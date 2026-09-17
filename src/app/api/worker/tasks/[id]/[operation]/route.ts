import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { agentTasks } from "@/db/schema";
import { completeAgentTask, failAgentTask, renewAgentTaskLease, updateAgentTaskProgress, waitAgentTaskForUser } from "@/lib/agent-tasks";
import { unauthorized } from "@/lib/api-auth";
import { authenticateWorker, readWorkerJson, workerError, WorkerHttpError } from "@/lib/worker-auth";
import { publicAgentTask } from "@/lib/worker-tasks";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const record = z.record(z.string(), z.unknown());
const inputSchema = z.object({ claim_token: z.string().min(32).max(512), checkpoint: record.optional(), result: z.object({ summary: z.string().min(1).max(100_000) }).catchall(z.unknown()).optional(), error: z.string().min(1).max(10_000).optional(), retryable: z.boolean().optional(), waiting_for_user: z.boolean().optional(), external_ref: z.string().max(500).optional(), message: z.string().max(2000).optional() });
export async function POST(request: Request, context: { params: Promise<{ id: string; operation: string }> }) {
  try {
    const worker = authenticateWorker(request);
    if (!worker) return unauthorized();
    const params = await context.params;
    const id = z.uuid().parse(params.id);
    const input = inputSchema.parse(await readWorkerJson(request, 200_000));
    const grant = { workerId: worker.id, claimToken: input.claim_token };
    if (params.operation === "renew") {
      const task = await renewAgentTaskLease(id, grant, 120);
      return Response.json({ lease_expires_at: task.leaseExpiresAt });
    }
    if (params.operation === "progress") {
      const task = await getDb().transaction(async (tx) => {
        const updated = await updateAgentTaskProgress(id, grant, { ...input.checkpoint, ...(input.message ? { message: input.message } : {}) }, undefined, tx);
        if (input.external_ref) await tx.update(agentTasks).set({ externalRef: input.external_ref }).where(eq(agentTasks.id, id));
        return { ...updated, ...(input.external_ref ? { externalRef: input.external_ref } : {}) };
      });
      return Response.json({ task: publicAgentTask(task) });
    }
    if (params.operation === "complete") {
      if (!input.result) throw new WorkerHttpError("result is required", 400);
      const result = await completeAgentTask(id, grant, input.result);
      return Response.json({ task: publicAgentTask(result.task), replayed: result.replayed });
    }
    if (params.operation === "fail") {
      if (!input.error) throw new WorkerHttpError("error is required", 400);
      const task = input.waiting_for_user
        ? await waitAgentTaskForUser(id, grant, { ...input.checkpoint, message: input.error })
        : await failAgentTask(id, grant, input.error, { retryable: input.retryable ?? false, checkpoint: input.checkpoint });
      return Response.json({ task: publicAgentTask(task) });
    }
    return Response.json({ error: "Unknown operation" }, { status: 404 });
  } catch (error) { return workerError(error); }
}
