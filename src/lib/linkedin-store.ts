import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { agentTasks, eventsOutbox, linkedinIngestReceipts, linkedinSnapshots } from "@/db/schema";
import { enqueueLinkedInEvaluationTask } from "@/lib/agent-tasks";
import { stableJsonHash } from "@/lib/agent-task-contract";
import { acceptsLinkedinIngestReplay, canonicalizeLinkedinJobUrl, LINKEDIN_DECISION_PROTECTED_STATES, type LinkedinIngestBatch } from "@/lib/linkedin-ingestion";
import { WorkerHttpError } from "@/lib/worker-auth";
import { loadEffectiveSearchPolicy, lockEffectiveSearchPolicy } from "@/lib/search-settings-store";
import { getWorkspace } from "@/lib/workspace";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
export async function linkedinPolicy(tx: Tx, options: { lock?: boolean } = {}) {
  return options.lock ? lockEffectiveSearchPolicy(tx) : loadEffectiveSearchPolicy(tx);
}

export async function lookupLinkedinJobs(jobIds: string[], tx: Tx) {
  const [{ policyHash }, workspace] = await Promise.all([linkedinPolicy(tx), getWorkspace(tx)]);
  const rows = await tx.select().from(linkedinSnapshots).where(and(eq(linkedinSnapshots.candidateId, workspace.candidateId), inArray(linkedinSnapshots.linkedinJobId, jobIds)));
  const byId = new Map(rows.map((row) => [row.linkedinJobId, row]));
  return { policyHash, jobs: jobIds.map((id) => {
    const row = byId.get(id);
    if (!row) return { jobId: id, known: false, shouldFetch: true, reason: "new" };
    const policyChanged = row.evaluatedPolicyHash !== policyHash;
    const stale = !row.completedAt || Date.now() - row.completedAt.getTime() > 7 * 86_400_000;
    const shouldFetch = row.state === "discovered_compact" || row.state === "failed_transient" || (row.state === "rejected" && (policyChanged || stale));
    return { jobId: id, known: true, state: row.state, firstObservedAt: row.firstObservedAt, lastObservedAt: row.lastObservedAt, promotedJobId: row.promotedJobId, shouldFetch, reason: shouldFetch ? (policyChanged ? "policy_changed" : "missing_or_stale_evidence") : "already_processed_or_pending" };
  }) };
}

/** Caller and receipt writes share one transaction; retrying a batch cannot duplicate its events/tasks. */
export async function ingestLinkedinBatch(batch: LinkedinIngestBatch, tx: Tx, parentTask?: typeof agentTasks.$inferSelect) {
  const workspace = await getWorkspace(tx);
  if (batch.candidateId !== workspace.candidateId) throw new WorkerHttpError("Unknown candidate", 400);
  const observedAt = new Date(batch.generatedAt);
  if (observedAt.getTime() > Date.now() + 300_000 || batch.items.some((item) => new Date(item.firstObservedAt) > observedAt)) throw new WorkerHttpError("Invalid observation time", 400);
  if (parentTask && !batch.runKey.startsWith(`task:${parentTask.id}:`)) throw new WorkerHttpError("runKey must start with task:<task_id>:", 400);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('compass:linkedin-ingest'))`);
  const payloadHash = stableJsonHash(batch);
  const [prior] = await tx.select().from(linkedinIngestReceipts).where(eq(linkedinIngestReceipts.idempotencyKey, batch.runKey)).limit(1);
  if (prior) {
    // Receipts created before payload hashing retain their original replay behavior.
    if (!acceptsLinkedinIngestReplay(prior.payloadHash, payloadHash)) throw new WorkerHttpError("Idempotency key already belongs to different content; use a new runKey");
    return { receiptId: prior.id, acceptedJobIds: prior.acceptedJobIds, idempotentReplay: true };
  }
  const { effectivePolicy, policyHash } = await linkedinPolicy(tx);
  const budgets = parentTask?.payload.budgets as { maxDetailFetches?: number } | undefined;
  const [children] = parentTask ? await tx.select({ count: sql<number>`count(*)::int` }).from(agentTasks).where(eq(agentTasks.parentTaskId, parentTask.id)) : [];
  let evaluationCount = children?.count ?? 0;
  const acceptedJobIds: string[] = [];
  const evaluationTaskIds: string[] = [];
  for (const item of [...batch.items].sort((a, b) => a.jobId.localeCompare(b.jobId))) {
    const { canonicalUrl } = canonicalizeLinkedinJobUrl(item.canonicalUrl, item.jobId);
    const [existing] = await tx.select().from(linkedinSnapshots).where(eq(linkedinSnapshots.linkedinJobId, item.jobId)).for("update").limit(1);
    if (existing && existing.candidateId !== workspace.candidateId) throw new WorkerHttpError("Snapshot belongs to another candidate");
    acceptedJobIds.push(item.jobId);
    if (existing && existing.lastObservedAt > observedAt) continue;
    const evidenceHash = item.snapshot ? stableJsonHash({ snapshot: item.snapshot, title: item.title, company: item.company, location: item.location, workMode: item.workMode ?? null }) : null;
    const protectedState = existing && LINKEDIN_DECISION_PROTECTED_STATES.includes(existing.state as (typeof LINKEDIN_DECISION_PROTECTED_STATES)[number]);
    const canRefresh = !existing || !protectedState;
    const becomingReady = item.funnelState === "snapshot_ready" && canRefresh && (!existing || existing.state !== "rejected" || existing.evidenceHash !== evidenceHash || existing.evaluatedPolicyHash !== policyHash || !existing.completedAt || Date.now() - existing.completedAt.getTime() > 7 * 86_400_000);
    const observedValues = {
      canonicalUrl, title: item.title, company: item.company, location: item.location, workModeText: item.workMode,
      searchLane: item.lane, resultRank: item.resultRank, collectorRunKey: item.collectorRunKey,
      compactEvidence: item.compact ?? { title: item.title, company: item.company, location: item.location, workMode: item.workMode },
      lastObservedAt: observedAt, updatedAt: new Date(),
      ...(becomingReady ? { snapshotEvidence: item.snapshot, titleDecision: item.titleDecision, detailDecision: item.detailDecision, evidenceHash, state: "snapshot_ready" as const, completedAt: null, completionReason: null } : {}),
    };
    // Work already under review or holding a terminal human decision keeps the evidence and identity that decision used.
    const values = protectedState ? { lastObservedAt: observedAt, updatedAt: new Date() } : observedValues;
    const [snapshot] = existing
      ? await tx.update(linkedinSnapshots).set(values).where(eq(linkedinSnapshots.id, existing.id)).returning()
      : await tx.insert(linkedinSnapshots).values({ ...observedValues, candidateId: workspace.candidateId, linkedinJobId: item.jobId, firstObservedAt: new Date(item.firstObservedAt), state: item.funnelState }).returning();
    if (becomingReady) {
      if (parentTask && evaluationCount >= (budgets?.maxDetailFetches ?? 30)) throw new WorkerHttpError("Task detail budget exceeded");
      // A fresh evaluation cycle uses the observation time only when the same evidence aged out.
      const cycle = existing?.evidenceHash === evidenceHash && existing?.evaluatedPolicyHash === policyHash ? `:${observedAt.toISOString().slice(0, 10)}` : "";
      const queued = await enqueueLinkedInEvaluationTask({ snapshotId: snapshot.id, parentTaskId: parentTask?.id, dedupeKey: `linkedin:${snapshot.id}:${stableJsonHash({ evidenceHash, policyHash, cycle })}`, payload: { candidateId: workspace.candidateId, admissionMode: "full_ingestion", effectivePolicy, policyHash, evidenceHash } }, tx);
      if (queued.created) evaluationCount++;
      evaluationTaskIds.push(queued.task.id);
      await tx.insert(eventsOutbox).values({ type: "linkedin_snapshot_ready", payload: { snapshotId: snapshot.id, linkedinJobId: item.jobId, managedTaskId: queued.task.id } });
    }
  }
  const [receipt] = await tx.insert(linkedinIngestReceipts).values({ idempotencyKey: batch.runKey, payloadHash, candidateId: workspace.candidateId, collectorRunKey: batch.runKey, acceptedJobIds, snapshotReadyJobIds: batch.items.filter((item) => item.funnelState === "snapshot_ready").map((item) => item.jobId), itemCount: acceptedJobIds.length }).returning({ id: linkedinIngestReceipts.id });
  return { receiptId: receipt.id, acceptedJobIds, evaluationTaskIds, idempotentReplay: false };
}
