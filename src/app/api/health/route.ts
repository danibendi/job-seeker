import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { getWorkspace } from "@/lib/workspace";
import { getAgentExecutionSettings } from "@/lib/agent-tasks";
import { workerRegistry } from "@/lib/worker-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const source = process.env.JOB_SEEKER_SOURCE_REVISION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "";
  const software = { version: "0.1.0", protocolVersion: 1, sourceRevision: /^[a-f0-9]{7,40}$/.test(source) ? source : "unrecorded" };
  try {
    await getDb().execute(sql`select 1`);
    const [workspace, execution] = await Promise.all([getWorkspace(), getAgentExecutionSettings()]);
    let workers = 0;
    let workerConfiguration: "configured" | "disabled" | "invalid" = "disabled";
    try {
      workers = workerRegistry().length;
      workerConfiguration = workers ? "configured" : "disabled";
    } catch {
      workerConfiguration = "invalid";
    }
    const ownerMcpConfigured = Boolean((process.env.OWNER_MCP_TOKEN ?? process.env.HERMES_API_TOKEN)?.trim());
    const schedulerConfigured = Boolean(process.env.COMPASS_SCHEDULER_TOKEN?.trim());
    const automationAssigned = execution.searchExecutor !== "unassigned" || execution.evaluationExecutor !== "unassigned";
    const automationReady = automationAssigned
      && workspace.onboardingCompletedAt !== null
      && workerConfiguration === "configured"
      && (!schedulerConfigured || process.env.COMPASS_SCHEDULER_TOKEN!.length >= 32);
    return Response.json({
      ok: true,
      ...software,
      database: "connected",
      workspace: { configured: workspace.onboardingCompletedAt !== null },
      ownerMcp: ownerMcpConfigured ? "configured" : "disabled",
      automation: {
        status: workerConfiguration === "invalid" ? "invalid" : automationReady ? "ready" : automationAssigned ? "incomplete" : "disabled",
        workers,
        scheduler: schedulerConfigured ? "configured" : "disabled",
        searchExecutor: execution.searchExecutor,
        evaluationExecutor: execution.evaluationExecutor,
        discovery: execution.searchSources.length > 0 ? "configured" : "disabled",
        sources: execution.searchSources,
      },
    });
  } catch {
    return Response.json({ ok: false, database: "unavailable", ...software }, { status: 503 });
  }
}
