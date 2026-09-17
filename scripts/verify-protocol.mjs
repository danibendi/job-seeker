#!/usr/bin/env node
/** Real HTTP/PostgreSQL conformance test. Use an EMPTY disposable database only. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';

const app = process.env.JOB_SEEKER_TEST_URL ?? 'http://127.0.0.1:3047';
const owner = process.env.JOB_SEEKER_TEST_OWNER_TOKEN;
const worker = process.env.JOB_SEEKER_TEST_WORKER_TOKEN;
const workerId = process.env.JOB_SEEKER_TEST_WORKER_ID;
const executor = process.env.JOB_SEEKER_TEST_EXECUTOR ?? 'codex';
if (process.env.JOB_SEEKER_DISPOSABLE_DATABASE !== 'true') throw Error('Set JOB_SEEKER_DISPOSABLE_DATABASE=true only for a new disposable test database');
if (!['localhost','127.0.0.1','[::1]'].includes(new URL(app).hostname)) throw Error('The test application must run on loopback');
if (!owner || !worker || !workerId || !process.env.DATABASE_URL) throw Error('Database and test credentials must be supplied through environment variables');
if (!['codex','api','hermes'].includes(executor)) throw Error('Unsupported test executor');
const db = postgres(process.env.DATABASE_URL,{max:2,prepare:false});
const checks=[];
const check=(condition,name)=>{assert.ok(condition,name);checks.push({name,status:'passed'})};
let rpcId=0;
async function http(path,token,body) {
 const response=await fetch(`${app}${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
 const text=await response.text();let data;
 try {data=JSON.parse(text)}catch{const event=text.split('\n').find(line=>line.startsWith('data: '));data=event?JSON.parse(event.slice(6)):{};}
 return {status:response.status,data};
}
async function rpc(method,params,token=owner,path='/api/mcp') {
 return http(path,token,{jsonrpc:'2.0',id:++rpcId,method,params});
}
async function mcp(name,args,token=owner,path='/api/mcp') {
 const response=await rpc('tools/call',{name,arguments:args},token,path);
 if(response.status!==200 || response.data.error || response.data.result?.isError)return {error:true,status:response.status};
 return JSON.parse(response.data.result.content[0].text);
}
const claim=()=>http('/api/worker/tasks/claim',worker,{kinds:['question']});
const operation=(id,name,grant,body={})=>http(`/api/worker/tasks/${id}/${name}`,worker,{claim_token:grant,...body});
try {
 const [counts]=await db`select (select count(*) from jobs)::int jobs,(select count(*) from requests)::int requests,(select count(*) from agent_tasks)::int tasks`;
 check(counts.jobs===0&&counts.requests===0&&counts.tasks===0,'empty disposable dataset');
 // Prove HTTP and SQL point at the same database before any business mutation.
 const challenge=randomUUID();
 await db`insert into agent_tasks(id,kind,executor,status,dedupe_key,claimed_by) values(${challenge},'question',${executor},'running',${'verification:'+challenge},${workerId})`;
 try{const r=await http(`/api/worker/tasks/${challenge}`,worker);check(r.status===200&&r.data.task?.id===challenge,'application/database identity challenge')}
 finally{await db`delete from agent_tasks where id=${challenge}`}
 check((await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'job-seeker-conformance',version:'1'}})).data.result?.serverInfo,'owner MCP initialize');
 const list=await rpc('tools/list',{});check(Array.isArray(list.data.result?.tools)&&list.data.result.tools.length>0,'owner MCP tool discovery');
 check((await rpc('tools/list',{},'invalid')).status===401,'invalid owner bearer rejected');
 check((await http('/api/worker/tasks/claim','invalid',{})).status===401,'invalid worker bearer rejected');
 check((await http('/api/worker/tasks/claim',owner,{})).status===401,'owner credential cannot claim');
 check((await rpc('tools/list',{},worker)).status===401,'worker credential cannot use owner MCP');
 const marker=randomUUID();
 const [request]=await db`insert into requests(text,purpose,payload) values('Explain the synthetic verification job search.','question','{}') returning id`;
 const [workspace]=await db`select candidate_id from workspaces where id='owner'`;
 const [task]=await db`insert into agent_tasks(kind,executor,request_id,dedupe_key,payload) values('question',${executor},${request.id},${'verification:'+marker},${JSON.stringify({candidateId:workspace.candidate_id})}::jsonb) returning id`;
 const [a,b]=await Promise.all([claim(),claim()]);
 check([a,b].filter(x=>x.data.task?.id===task.id).length===1,'concurrent claims yield one owner');
 let grant=a.data.task?a.data:b.data;
 const identity={task_id:task.id,attempt:grant.task.attemptCount};
 check(!('claimTokenHash' in grant.task),'claim does not expose stored token hash');
 const context=await mcp('get_task_context',identity,grant.claim_token,'/api/worker/mcp');
 check(!context.error,'task capability can read own context');
 check((await mcp('get_task_context',{...identity,task_id:randomUUID()},grant.claim_token,'/api/worker/mcp')).error,'task capability cannot read another task');
 check((await operation(task.id,'progress',grant.claim_token,{checkpoint:{cursor:1}})).status===200,'durable progress saved');
 await db`update agent_tasks set lease_expires_at=now()-interval '1 second' where id=${task.id}`;
 check((await operation(task.id,'renew',grant.claim_token)).status===409,'expired lease cannot renew');
 const old=grant;
 grant=(await claim()).data;
 check(grant.task?.id===task.id&&grant.task.attemptCount>old.task.attemptCount,'expired attempt recovered with higher attempt');
 check(grant.task.checkpoint.cursor===1,'recovered attempt retains durable progress');
 check((await operation(task.id,'complete',old.claim_token,{result:{summary:'Stale attempt'}})).status===409,'replaced capability cannot complete');
 const result={summary:'Protocol verification answer: your synthetic task completed once.'};
 check((await operation(task.id,'complete',grant.claim_token,{result})).status===200,'task completion saved');
 check((await operation(task.id,'complete',grant.claim_token,{result})).data.replayed===true,'identical completion replays safely');
 check((await operation(task.id,'complete',grant.claim_token,{result:{summary:'Conflicting answer'}})).status===409,'conflicting completion rejected');
 const [answer]=await db`select status,response_md from requests where id=${request.id}`;
 check(answer.status==='answered'&&answer.response_md.includes(result.summary),'answer saved to linked user request');
 const [second]=await db`insert into agent_tasks(kind,executor,dedupe_key,payload) values('question',${executor},${'verification:'+randomUUID()},${JSON.stringify({candidateId:workspace.candidate_id})}::jsonb) returning id`;
 grant=(await claim()).data;
 check(!(await mcp('cancel_agent_task',{task_id:second.id})).error,'owner can cancel task');
 check((await operation(second.id,'complete',grant.claim_token,{result})).status===409,'cancellation fences late completion');
 check(!(await mcp('retry_agent_task',{task_id:second.id})).error,'owner can explicitly retry');
 const retried=(await claim()).data;
 check(retried.task.attemptCount>grant.task.attemptCount,'human retry keeps attempts monotonic');
 check((await operation(second.id,'fail',retried.claim_token,{error:'Synthetic login needed',waiting_for_user:true})).status===200,'waiting-for-user state saved');
 check((await claim()).data.task===null,'waiting-for-user does not auto retry');
 const job=await mcp('upsert_job',{company:'Synthetic Example Studio',title:'Synthetic verification engineer',url:`https://example.com/jobs/${marker}`,location:'Example City',source:'manual',description_md:'Synthetic conformance fixture; not a real vacancy.'});
 check(Boolean(job.job_id),'owner MCP allowed write');
 const duplicate=await mcp('upsert_job',{company:'Synthetic Example Studio',title:'Synthetic verification engineer',url:`https://example.com/jobs/${marker}`,location:'Example City',source:'manual'});
 check(duplicate.job_id===job.job_id,'owner write is idempotent for same job');
 const [{total}]=await db`select count(*)::int total from jobs`;
 check(total===1,'repeated write produced exactly one job');
 console.log(JSON.stringify({schema:'job-seeker.protocol-verification',at:new Date().toISOString(),status:'passed',checks},null,2));
} catch(error) {
 console.error(JSON.stringify({status:'failed',checks,error:error instanceof assert.AssertionError?error.message:'Verification operation failed; inspect private server logs.'},null,2));
 process.exitCode=1;
} finally {await db.end()}
