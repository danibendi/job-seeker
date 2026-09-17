import { runScheduledSearchTick } from "@/lib/agent-tasks";
import { unauthorized } from "@/lib/api-auth";
import { authenticateScheduler, workerError } from "@/lib/worker-auth";
import { publicAgentTask } from "@/lib/worker-tasks";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    if (!authenticateScheduler(request)) return unauthorized();
    const result = await runScheduledSearchTick();
    return Response.json({ ...result, ...(result.task ? { task: publicAgentTask(result.task) } : {}) });
  } catch (error) { return workerError(error); }
}
