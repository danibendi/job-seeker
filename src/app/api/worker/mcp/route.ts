import { and, eq, gt } from "drizzle-orm";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { getDb } from "@/db";
import { agentTasks } from "@/db/schema";
import { unauthorized } from "@/lib/api-auth";
import { sha256OpaqueToken } from "@/lib/agent-task-contract";
import { bearerToken, readWorkerJson, WorkerHttpError, workerError } from "@/lib/worker-auth";
import { TASK_CONTEXT_SECTION_NAMES } from "@/lib/agent-task-context";
import { PublicSourceFetchError, verifyPublicSource } from "@/lib/public-source-fetch";
import { authorizeTaskClaim, discoveredJobSchema, finishLinkedinEvaluation, getTaskContext, getTaskContextSection, linkedinEvaluationSchema, publicDiscoveredJobSchema, requireTaskKind, saveDiscoveredJob, storePublicSourceReceipt, taskIdentitySchema, withTask, type TaskPrincipal } from "@/lib/task-capabilities";
import { linkedinIngestBatchSchema } from "@/lib/linkedin-ingestion";
import { linkedinScanDetailsSchema, linkedinScanPageSchema, linkedinScanPlanSchema, linkedinScanStopSchema } from "@/lib/linkedin-scan-contract";
import { getOrCreateLinkedinScanState, recordLinkedinScanDetails, recordLinkedinScanPage, recordLinkedinScanStop } from "@/lib/linkedin-scan";
import { ingestLinkedinBatch, lookupLinkedinJobs } from "@/lib/linkedin-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
async function authorized(request: Request) {
  try {
    const token = bearerToken(request);
    if (!token) return unauthorized();
    const principal: TaskPrincipal = { token };
    {
      const [task] = await getDb().select({ id: agentTasks.id }).from(agentTasks).where(and(eq(agentTasks.claimTokenHash, sha256OpaqueToken(token)), eq(agentTasks.status, "running"), gt(agentTasks.leaseExpiresAt, new Date()))).limit(1);
      if (!task) return unauthorized();
    }
    // Bound before the MCP SDK parses the body. Never log request bodies or bearer credentials.
    let bounded = request;
    if (request.method === "POST") bounded = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(await readWorkerJson(request)) });
    const handler = createMcpHandler((server) => {
      server.registerTool("get_task_context", { description: "Load this task's durable checkpoint, current policy, evidence and relevant candidate context. A large response returns a versioned semantic-section manifest; retrieve its applicable sections with get_task_context_section before acting.", inputSchema: taskIdentitySchema }, async (input) => result(await withTask(input, principal, getTaskContext)));
      server.registerTool("get_task_context_section", {
        description: "Read a chunk from a versioned large task context. Omit item_index on an items section to page its bounded item index, select applicable items by index, or set whole_section to read every item in bounded chunks. Follow every next_cursor. A context-version conflict requires reloading get_task_context.",
        inputSchema: z.object({
          context_version: z.string().length(64),
          section: z.enum(TASK_CONTEXT_SECTION_NAMES),
          item_index: z.number().int().min(0).optional(),
          whole_section: z.boolean().optional(),
          cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        }).safeExtend(taskIdentitySchema.shape),
      }, async (input) => result(await withTask(input, principal, (task, tx) => getTaskContextSection(task, input, tx))));
      server.registerTool("get_task_time", { description: "Get current UTC time immediately before a direct source verification, without reloading task context.", inputSchema: taskIdentitySchema }, async (input) => result(await withTask(input, principal, async (task) => ({ serverNowUtc: new Date().toISOString(), attemptStartedAt: task.startedAt?.toISOString() ?? null }))));
      server.registerTool("verify_public_source", {
        description: "Have Job Seeker independently fetch the exact public employer/ATS URL before save_job. Returns a current server receipt only for public DNS, HTTP 200 static HTML that matches the submitted employer/title, has vacancy-shaped sections and an apply signal, and has no explicit closed/expired/soft-404 signal. This is a fail-closed static HTML check, not proof that an application submission will succeed.",
        inputSchema: z.object({
          url: z.url().max(4000),
          expected_title: z.string().min(1).max(500),
          expected_company: z.string().min(1).max(300),
        }).safeExtend(taskIdentitySchema.shape),
      }, async (input) => {
        const task = await authorizeTaskClaim(input, principal);
        requireTaskKind(task, ["search"]);
        if (!Array.isArray(task.payload.sources) || !task.payload.sources.includes("public")) throw new WorkerHttpError("Public search is not enabled for this task", 403);
        let receipt;
        try {
          receipt = await verifyPublicSource({ taskId: task.id, attempt: task.attemptCount, url: input.url, expectedTitle: input.expected_title, expectedCompany: input.expected_company });
        } catch (error) {
          if (error instanceof PublicSourceFetchError) throw new WorkerHttpError(error.message, 400);
          throw error;
        }
        return result(await withTask(input, principal, (current, tx) => storePublicSourceReceipt(current, receipt, tx)));
      });
      server.registerTool("lookup_linkedin_jobs", { description: "Check known LinkedIn IDs before fetching details. Returns only source history and fetch eligibility.", inputSchema: taskIdentitySchema.extend({ job_ids: z.array(z.string().regex(/^\d{6,40}$/)).min(1).max(300) }) }, async (input) => result(await withTask(input, principal, (task, tx) => {
        requireTaskKind(task, ["search"]);
        if (!Array.isArray(task.payload.sources) || !task.payload.sources.includes("linkedin")) throw new WorkerHttpError("LinkedIn is not enabled for this task", 403);
        return lookupLinkedinJobs(input.job_ids, tx);
      })));
      server.registerTool("ingest_linkedin_batch", { description: "Persist observations and queue evaluation tasks. Keep companyless evidence discovered_compact; snapshot_ready requires a nonblank, storage-compatible company. Use schemaVersion 1 and stable runKey task:<task_id>:<batch_key>. Same content can be retried safely.", inputSchema: taskIdentitySchema.extend({ batch: linkedinIngestBatchSchema }) }, async (input) => result(await withTask(input, principal, (task, tx) => {
        requireTaskKind(task, ["search"]);
        if (!Array.isArray(task.payload.sources) || !task.payload.sources.includes("linkedin")) throw new WorkerHttpError("LinkedIn is not enabled for this task", 403);
        return ingestLinkedinBatch(input.batch, tx, task);
      })));
      server.registerTool("get_linkedin_scan_state", { description: "Freeze or resume a LinkedIn scan. Backfill is the 30-day bootstrap; fresh is the 1-day daily scan and is available only after a compatible bootstrap settles all provider-visible results. A source-capped bootstrap remains explicitly incomplete even when it is settled. Interrupted phases preserve their original time window and page frontier. Plan URLs omit f_TPR; apply each returned lane's time filter exactly.", inputSchema: linkedinScanPlanSchema.safeExtend(taskIdentitySchema.shape) }, async (input) => result(await withTask(input, principal, (task, tx) => getOrCreateLinkedinScanState(task, input, tx))));
      server.registerTool("record_linkedin_scan_page", { description: "Advance one lane in the named track only after every listed job ID has a durable LinkedIn observation. Requires a complete page, an explicit next cursor or exhaustion, and rejects repeated page IDs.", inputSchema: linkedinScanPageSchema.safeExtend(taskIdentitySchema.shape) }, async (input) => result(await withTask(input, principal, (task, tx) => recordLinkedinScanPage(task, input, tx))));
      server.registerTool("record_linkedin_scan_details", { description: "Acknowledge pending detail IDs from the named track after durable full snapshots exist. The server clears each ID across every compatible fresh/backfill run so older task backlogs are not lost.", inputSchema: linkedinScanDetailsSchema.safeExtend(taskIdentitySchema.shape) }, async (input) => result(await withTask(input, principal, (task, tx) => recordLinkedinScanDetails(task, input, tx))));
      server.registerTool("record_linkedin_scan_stop", { description: "Record a bounded source, authentication, pagination, unavailable-detail, or resource stop without advancing its durable page frontier. Include detail_job_id when full evidence is unavailable so it remains an explicit gap without being fetched again. When an incomplete page was durably ingested, include its pending detail IDs so they remain in the compatible backlog.", inputSchema: linkedinScanStopSchema.safeExtend(taskIdentitySchema.shape) }, async (input) => result(await withTask(input, principal, (task, tx) => recordLinkedinScanStop(task, input, tx))));
      server.registerTool("save_job", { description: "Save an eligible public-web job with both a current worker attestation and the matching server receipt from verify_public_source. Missing, stale, non-200, identity-mismatched, soft-closed or expired evidence is refused. LinkedIn requires separate evaluation.", inputSchema: taskIdentitySchema.extend({ job: publicDiscoveredJobSchema }) }, async (input) => result(await withTask(input, principal, (task, tx) => saveDiscoveredJob(task, input.job, tx))));
      server.registerTool("complete_linkedin_evaluation", { description: "Atomically record one policy-fenced structured evaluation and, when promoted, its evidence-bound Job Seeker job.", inputSchema: taskIdentitySchema.extend({ status: z.enum(["promoted", "rejected", "needs_review"]), reason: z.string().min(1).max(10_000), policy_hash: z.string().length(64), evaluation: linkedinEvaluationSchema, job: discoveredJobSchema.optional() }) }, async (input) => result(await withTask(input, principal, (task, tx) => finishLinkedinEvaluation(task, input, tx))));
    }, { serverInfo: { name: "compass-task", version: "1.0.0" } });
    return await handler(bounded);
  } catch (error) { return workerError(error); }
}
export { authorized as GET, authorized as POST };
