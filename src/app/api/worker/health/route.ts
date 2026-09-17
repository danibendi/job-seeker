import { unauthorized } from "@/lib/api-auth";
import { authenticateScheduler, authenticateWorker, workerError } from "@/lib/worker-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Verify a provisioned capability without claiming work or ticking a schedule. */
export async function GET(request: Request) {
  try {
    const worker = authenticateWorker(request);
    if (worker) return Response.json({ ok: true, role: "worker", executor: worker.executor, worker_id: worker.id });
    if (authenticateScheduler(request)) return Response.json({ ok: true, role: "scheduler" });
    return unauthorized();
  } catch (error) { return workerError(error); }
}
