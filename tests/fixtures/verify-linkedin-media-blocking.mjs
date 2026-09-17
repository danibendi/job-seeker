import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const [transportPath, chromeBin] = process.argv.slice(2);
if (!transportPath || !chromeBin) {
  throw new Error('usage: verify-linkedin-media-blocking.mjs TRANSPORT CHROME');
}
const jobId = '4455695536';
const source = await readFile(transportPath, 'utf8');
const expansionTag = source.match(/const expansion = await evaluate\((String\.raw`[\s\S]*?`)\);/)?.[1];
const detailTag = source.match(/return \{auth, \.\.\.\(await evaluate\((String\.raw`[\s\S]*?`)\)\)\};/)?.[1];
if (!expansionTag || !detailTag) throw new Error('detail_templates_missing');

const requests = new Map();
const page = `<!doctype html><html><head>
  <link rel="stylesheet" href="/style.css"><script src="/script.js"></script>
</head><body><header><nav>
  <button aria-label="Home, 0 new notifications">Home</button><a>My Network</a><a>Jobs</a>
  <a>Messaging</a><a aria-label="Notifications, 0 new notifications">Notifications</a><button>Me</button>
  <div role="menu"><a href="https://www.linkedin.com/in/alex-example/">Alex Example</a><span>Sign out</span></div>
</nav></header><main>
  <div aria-label="Company, Example Corp."><p>Example Corp</p></div>
  <p>Technical Program Manager</p><p>Prague, Czechia · today</p>
  <h2>About the job</h2><div>Complete job evidence remains available while visual media is blocked.</div>
  <ul><li>Coordinate software delivery across engineering teams.</li><li>Manage risks and dependencies.</li></ul>
  <div>Lead a complex technical program with clear schedules, stakeholder alignment,
    implementation planning, measurable outcomes, and cross-functional communication.</div>
  <h2>About the company</h2><p>Excluded company recommendation.</p>
  <img src="/image.png"><video src="/media.mp4" preload="auto"></video>
</main></body></html>`;
const server = http.createServer((request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname;
  requests.set(path, (requests.get(path) || 0) + 1);
  if (path === '/style.css') {
    response.writeHead(200, { 'content-type': 'text/css' });
    response.end("@font-face{font-family:FixtureFont;src:url('/font.woff2')}body{font-family:FixtureFont;color:rgb(1,2,3)}");
  } else if (path === '/script.js') {
    response.writeHead(200, { 'content-type': 'application/javascript' });
    response.end("window.fixtureScript=true;fetch('/data.json').then(()=>window.fixtureFetch=true);document.fonts.load('16px FixtureFont');");
  } else if (path === '/data.json') {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}');
  } else if (path === '/image.png') {
    response.writeHead(200, { 'content-type': 'image/png' }); response.end(Buffer.from('iVBORw0KGgo=', 'base64'));
  } else if (path === '/font.woff2') {
    response.writeHead(200, { 'content-type': 'font/woff2' }); response.end(Buffer.alloc(64));
  } else if (path === '/media.mp4') {
    response.writeHead(200, { 'content-type': 'video/mp4' }); response.end(Buffer.alloc(256));
  } else {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(page);
  }
});
await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
const port = server.address().port;
const profile = await mkdtemp(join(tmpdir(), 'compass-media-block-'));
const chrome = spawn(chromeBin, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
let transport;
let browserSocket;
try {
  let debuggerPort;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      debuggerPort = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      if (debuggerPort) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!debuggerPort) throw new Error('chrome_start_failed');
  const endpoint = `http://127.0.0.1:${debuggerPort}`;
  const version = await (await fetch(`${endpoint}/json/version`)).json();
  browserSocket = new WebSocket(version.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    browserSocket.addEventListener('open', resolve, { once: true });
    browserSocket.addEventListener('error', reject, { once: true });
  });
  browserSocket.addEventListener('message', event => {
    const message = JSON.parse(event.data); const request = pending.get(message.id);
    if (!request) return; pending.delete(message.id);
    message.error ? request.reject(new Error('cdp_failed')) : request.resolve(message.result);
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    browserSocket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  transport = spawn('node', [transportPath], { stdio: ['pipe', 'pipe', 'pipe'], text: true });
  const replies = [];
  let buffered = '';
  transport.stdout.setEncoding('utf8');
  transport.stdout.on('data', chunk => {
    buffered += chunk;
    while (buffered.includes('\n')) {
      const boundary = buffered.indexOf('\n');
      replies.push(JSON.parse(buffered.slice(0, boundary))); buffered = buffered.slice(boundary + 1);
    }
  });
  const command = async value => {
    transport.stdin.write(JSON.stringify(value) + '\n');
    for (let attempt = 0; attempt < 400; attempt++) {
      if (replies.length) {
        const reply = replies.shift();
        if (!reply.ok) throw new Error(`transport_${reply.error}`);
        return reply.result || {};
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('transport_timeout');
  };
  const connected = await command({ op: 'connect', endpoint, dedicatedProfile: true, blockMedia: true });
  if (!connected.mediaBlocking || !connected.reusedStartupTarget) throw new Error('blocking_not_enabled');
  const { targetInfos } = await cdp('Target.getTargets');
  const target = targetInfos.find(item => item.type === 'page' && item.url === 'about:blank');
  const { sessionId } = await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/jobs/view/${jobId}/` }, sessionId);
  await new Promise(resolve => setTimeout(resolve, 1200));
  const probe = await command({ op: 'probe' });
  const stats = probe._resourceBlocking;
  if (!stats || stats.byType.Image < 1 || stats.byType.Media < 1 || stats.byType.Font < 1) {
    throw new Error('typed_resources_not_blocked');
  }
  if (probe.authenticated || probe.challenge || probe.pathname !== `/jobs/view/${jobId}/`) {
    throw new Error('guarded_account_dom_changed');
  }
  const functional = await cdp('Runtime.evaluate', {
    expression: `({ready:document.readyState,script:window.fixtureScript===true,
      fetched:window.fixtureFetch===true,color:getComputedStyle(document.body).color})`,
    returnByValue: true,
  }, sessionId);
  const state = functional.result.value;
  if (state.ready !== 'complete' || !state.script || !state.fetched || state.color !== 'rgb(1, 2, 3)') {
    throw new Error('functional_resources_failed');
  }
  const expansionExpression = vm.runInNewContext(expansionTag, { id: jobId });
  const expansion = (await cdp('Runtime.evaluate', {
    expression: expansionExpression, returnByValue: true,
  }, sessionId)).result.value;
  const detailExpression = vm.runInNewContext(detailTag, { id: jobId, expansion });
  const evidence = (await cdp('Runtime.evaluate', {
    expression: detailExpression, returnByValue: true,
  }, sessionId)).result.value;
  if (evidence.title !== 'Technical Program Manager' || evidence.company !== 'Example Corp' ||
      evidence.location !== 'Prague, Czechia' || evidence.description.length < 200 ||
      evidence.description.includes('Excluded company recommendation')) {
    throw new Error('detail_dom_changed');
  }
  for (const required of [`/jobs/view/${jobId}/`, '/style.css', '/script.js', '/data.json']) {
    if (!requests.get(required)) throw new Error('functional_request_blocked');
  }
  for (const blocked of ['/image.png', '/media.mp4', '/font.woff2']) {
    if (requests.get(blocked)) throw new Error('blocked_request_reached_server');
  }
  await cdp('Target.detachFromTarget', { sessionId });
  await command({ op: 'close' });
  browserSocket.close();
} finally {
  if (transport?.exitCode === null) transport.kill('SIGTERM');
  chrome.kill('SIGTERM');
  await new Promise(resolve => chrome.once('exit', resolve));
  server.close();
  await rm(profile, { recursive: true, force: true });
}
