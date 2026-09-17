import "server-only";

import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { agentTasks, linkedinIngestReceipts, linkedinSnapshots, workspaces } from "@/db/schema";
import { DEFAULT_WORKSPACE, WORKSPACE_ID } from "@/lib/workspace-values";

type Store = Pick<ReturnType<typeof getDb>, "select" | "insert">;

export type WorkspaceRecord = typeof workspaces.$inferSelect;

export async function getWorkspace(store: Store = getDb()): Promise<WorkspaceRecord> {
  const [row] = await store.select().from(workspaces).where(eq(workspaces.id, WORKSPACE_ID)).limit(1);
  if (row) return row;
  const [created] = await store.insert(workspaces).values({ ...DEFAULT_WORKSPACE, candidateId: `candidate-${randomUUID().replaceAll("-", "")}` }).onConflictDoNothing({ target: workspaces.id }).returning();
  if (created) return created;
  const [concurrent] = await store.select().from(workspaces).where(eq(workspaces.id, WORKSPACE_ID)).limit(1);
  if (!concurrent) throw new Error("Workspace could not be initialized");
  return concurrent;
}

export function workspaceConfigured(workspace: Pick<WorkspaceRecord, "onboardingCompletedAt">) {
  return workspace.onboardingCompletedAt !== null;
}

export async function workspaceCandidateLocked(candidateId: string, store: Store = getDb()) {
  const [snapshots, receipts, tasks] = await Promise.all([
    store.select({ id: linkedinSnapshots.id }).from(linkedinSnapshots).where(eq(linkedinSnapshots.candidateId, candidateId)).limit(1),
    store.select({ id: linkedinIngestReceipts.id }).from(linkedinIngestReceipts).where(eq(linkedinIngestReceipts.candidateId, candidateId)).limit(1),
    store.select({ id: agentTasks.id }).from(agentTasks).where(sql`${agentTasks.payload}->>'candidateId' = ${candidateId}`).limit(1),
  ]);
  return snapshots.length > 0 || receipts.length > 0 || tasks.length > 0;
}
