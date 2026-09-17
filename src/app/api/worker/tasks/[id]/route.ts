import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { agentTasks } from "@/db/schema";
import { unauthorized } from "@/lib/api-auth";
import { authenticateWorker, workerError } from "@/lib/worker-auth";
import { publicAgentTask } from "@/lib/worker-tasks";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const worker = authenticateWorker(request);
    if (!worker) return unauthorized();
    const id = z.uuid().parse((await context.params).id);
    const [task] = await getDb().select().from(agentTasks).where(and(eq(agentTasks.id, id), eq(agentTasks.claimedBy, worker.id), eq(agentTasks.executor, worker.executor))).limit(1);
    return task ? Response.json({ task: publicAgentTask(task) }) : Response.json({ error: "Task not found" }, { status: 404 });
  } catch (error) { return workerError(error); }
}
