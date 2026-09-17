import { claimAgentTask } from "@/lib/agent-tasks";
import { unauthorized } from "@/lib/api-auth";
import { authenticateWorker, readWorkerJson, workerError } from "@/lib/worker-auth";
import { z } from "zod";
import { publicAgentTask } from "@/lib/worker-tasks";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const worker = authenticateWorker(request);
    if (!worker) return unauthorized();
    const body = z.object({ kinds: z.array(z.enum(["search", "linkedin_evaluate", "question"])).min(1).max(3).optional() }).parse(await readWorkerJson(request));
    const grant = await claimAgentTask({ workerId: worker.id, executor: worker.executor, kinds: body.kinds, leaseSeconds: 120 });
    if (!grant) return Response.json({ task: null });
    return Response.json({ task: publicAgentTask(grant.task), claim_token: grant.claimToken, lease_expires_at: grant.task.leaseExpiresAt, heartbeat_interval_seconds: 30 });
  } catch (error) { return workerError(error); }
}
