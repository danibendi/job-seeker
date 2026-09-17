import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, like, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  agentTasks,
  linkedinIngestReceipts,
  linkedinSearchDetails,
  linkedinSearchLanes,
  linkedinSearchPages,
  linkedinSearchRuns,
  linkedinSnapshots,
} from "@/db/schema";
import {
  LINKEDIN_BOOTSTRAP_LOOKBACK_SECONDS,
  LINKEDIN_DAILY_LOOKBACK_SECONDS,
  LINKEDIN_PROVIDER_MAX_PAGES_PER_LANE,
  LINKEDIN_PROVIDER_PAGE_SIZE,
  LINKEDIN_PROVIDER_VISIBLE_RESULT_CAP,
  LINKEDIN_SCAN_MAX_PENDING_DETAILS_RETURNED,
  linkedinScanPlanHash,
  normalizedLinkedinScanPlan,
  type LinkedinScanDetails,
  type LinkedinScanPage,
  type LinkedinScanPlan,
  type LinkedinScanStop,
  type LinkedinScanTrack,
} from "@/lib/linkedin-scan-contract";
import { stableJsonHash } from "@/lib/agent-task-contract";
import { lockEffectiveSearchPolicy } from "@/lib/search-settings-store";
import { WorkerHttpError } from "@/lib/worker-auth";

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
type Task = typeof agentTasks.$inferSelect;
type Run = typeof linkedinSearchRuns.$inferSelect;

async function currentPolicyHash(tx: Tx) {
  return (await lockEffectiveSearchPolicy(tx)).policyHash;
}

function requireLinkedinSearchTask(task: Task) {
  if (task.kind !== "search" || !Array.isArray(task.payload.sources) || !task.payload.sources.includes("linkedin")) {
    throw new WorkerHttpError("LinkedIn scan coverage is not available for this task", 403);
  }
  if (typeof task.payload.candidateId !== "string" || !task.payload.candidateId) throw new WorkerHttpError("LinkedIn scan task has an invalid candidate", 403);
  const scopeKey = task.payload.scopeKey;
  if (typeof scopeKey !== "string" || !scopeKey || scopeKey.length > 240) throw new WorkerHttpError("Search task has no valid scope key");
  return scopeKey;
}

async function currentRun(taskId: string, track: LinkedinScanTrack, tx: Tx, lock = false) {
  const query = tx.select().from(linkedinSearchRuns).where(and(eq(linkedinSearchRuns.taskId, taskId), eq(linkedinSearchRuns.track, track))).limit(1);
  const rows = lock ? await query.for("update") : await query;
  return rows[0] ?? null;
}

async function refreshRunCompletion(runId: string, tx: Tx) {
  const [[laneCounts], [detailCounts], [run]] = await Promise.all([
    tx.select({ total: sql<number>`count(*)::int`, exhausted: sql<number>`count(*) filter (where ${linkedinSearchLanes.exhausted})::int` }).from(linkedinSearchLanes).where(eq(linkedinSearchLanes.runId, runId)),
    tx.select({ incomplete: sql<number>`count(*) filter (where ${linkedinSearchDetails.status} <> 'completed')::int` }).from(linkedinSearchDetails).where(eq(linkedinSearchDetails.runId, runId)),
    tx.select().from(linkedinSearchRuns).where(eq(linkedinSearchRuns.id, runId)).limit(1),
  ]);
  if (!run) throw new WorkerHttpError("LinkedIn scan run not found", 404);
  const collectionComplete = (laneCounts?.total ?? 0) > 0 && laneCounts?.total === laneCounts?.exhausted;
  const detailsComplete = (detailCounts?.incomplete ?? 0) === 0;
  const complete = collectionComplete && detailsComplete;
  const [updated] = await tx.update(linkedinSearchRuns).set({
    collectionComplete,
    detailsComplete,
    completedAt: complete ? (run.completedAt ?? new Date()) : null,
    updatedAt: new Date(),
  }).where(eq(linkedinSearchRuns.id, runId)).returning();
  return updated;
}

function laneWatermark(run: Run, lookbackSeconds: number | null) {
  if (lookbackSeconds === null) return null;
  return new Date(run.scanStartedAt.getTime() - Math.max(0, lookbackSeconds) * 1_000);
}

async function renderState(run: Run, tx: Tx) {
  const compatible = and(eq(linkedinSearchRuns.scopeKey, run.scopeKey), eq(linkedinSearchRuns.planHash, run.planHash));
  const [lanes, pendingRows, backlogRows, [backlogCounts], [trackBacklogCounts], [trackUnavailableCounts], [detailCounts], currentPageRows, touchRows] = await Promise.all([
    tx.select().from(linkedinSearchLanes).where(eq(linkedinSearchLanes.runId, run.id)),
    tx.select({ jobId: linkedinSearchDetails.linkedinJobId }).from(linkedinSearchDetails).where(and(eq(linkedinSearchDetails.runId, run.id), eq(linkedinSearchDetails.status, "pending"))).orderBy(asc(linkedinSearchDetails.linkedinJobId)).limit(LINKEDIN_SCAN_MAX_PENDING_DETAILS_RETURNED + 1),
    tx.select({ jobId: linkedinSearchDetails.linkedinJobId }).from(linkedinSearchDetails).innerJoin(linkedinSearchRuns, eq(linkedinSearchDetails.runId, linkedinSearchRuns.id)).where(and(compatible, ne(linkedinSearchRuns.id, run.id), eq(linkedinSearchDetails.status, "pending"))).groupBy(linkedinSearchDetails.linkedinJobId).orderBy(asc(linkedinSearchDetails.linkedinJobId)).limit(LINKEDIN_SCAN_MAX_PENDING_DETAILS_RETURNED + 1),
    tx.select({ pending: sql<number>`count(distinct ${linkedinSearchDetails.linkedinJobId})::int` }).from(linkedinSearchDetails).innerJoin(linkedinSearchRuns, eq(linkedinSearchDetails.runId, linkedinSearchRuns.id)).where(and(compatible, ne(linkedinSearchRuns.id, run.id), eq(linkedinSearchDetails.status, "pending"))),
    tx.select({ pending: sql<number>`count(distinct ${linkedinSearchDetails.linkedinJobId})::int` }).from(linkedinSearchDetails).innerJoin(linkedinSearchRuns, eq(linkedinSearchDetails.runId, linkedinSearchRuns.id)).where(and(compatible, ne(linkedinSearchRuns.id, run.id), eq(linkedinSearchRuns.track, run.track), eq(linkedinSearchDetails.status, "pending"))),
    tx.select({ unavailable: sql<number>`count(distinct ${linkedinSearchDetails.linkedinJobId})::int` }).from(linkedinSearchDetails).innerJoin(linkedinSearchRuns, eq(linkedinSearchDetails.runId, linkedinSearchRuns.id)).where(and(compatible, eq(linkedinSearchRuns.track, run.track), eq(linkedinSearchDetails.status, "unavailable"))),
    tx.select({
      pending: sql<number>`count(*) filter (where ${linkedinSearchDetails.status} = 'pending')::int`,
      completed: sql<number>`count(*) filter (where ${linkedinSearchDetails.status} = 'completed')::int`,
      unavailable: sql<number>`count(*) filter (where ${linkedinSearchDetails.status} = 'unavailable')::int`,
    }).from(linkedinSearchDetails).where(eq(linkedinSearchDetails.runId, run.id)),
    tx.select({ laneId: linkedinSearchPages.laneId }).from(linkedinSearchPages).where(eq(linkedinSearchPages.runId, run.id)).groupBy(linkedinSearchPages.laneId),
    tx.select({ laneKey: linkedinSearchLanes.laneKey, touchedAt: sql<Date>`max(${linkedinSearchPages.createdAt})`.mapWith(linkedinSearchPages.createdAt) }).from(linkedinSearchPages)
      .innerJoin(linkedinSearchLanes, eq(linkedinSearchPages.laneId, linkedinSearchLanes.id))
      .innerJoin(linkedinSearchRuns, eq(linkedinSearchPages.runId, linkedinSearchRuns.id))
      .where(and(compatible, eq(linkedinSearchRuns.track, run.track)))
      .groupBy(linkedinSearchLanes.laneKey),
  ]);
  const pending = pendingRows.slice(0, LINKEDIN_SCAN_MAX_PENDING_DETAILS_RETURNED).map((row) => row.jobId);
  const backlog = backlogRows.slice(0, LINKEDIN_SCAN_MAX_PENDING_DETAILS_RETURNED).map((row) => row.jobId);
  const touched = new Set(currentPageRows.map((row) => row.laneId));
  const lastTouched = new Map(touchRows.map((row) => [row.laneKey, row.touchedAt]));
  const elapsedSeconds = Math.max(0, Math.ceil((Date.now() - run.scanStartedAt.getTime()) / 1_000));
  const orderedLanes = [...lanes].sort((left, right) => {
    const leftTime = lastTouched.get(left.laneKey)?.getTime() ?? 0;
    const rightTime = lastTouched.get(right.laneKey)?.getTime() ?? 0;
    return leftTime - rightTime || left.laneKey.localeCompare(right.laneKey);
  });
  const laneStates = orderedLanes.map((lane) => {
    const adjustedLookback = lane.lookbackSeconds === null ? null : lane.lookbackSeconds + elapsedSeconds;
    return {
      lane_key: lane.laneKey,
      query: lane.query,
      search_url: lane.searchUrl,
      lookback_seconds_at_start: lane.lookbackSeconds,
      lookback_seconds: adjustedLookback,
      apply_linkedin_time_filter: adjustedLookback ? `r${adjustedLookback}` : null,
      observation_watermark_started_at: laneWatermark(run, lane.lookbackSeconds)?.toISOString() ?? null,
      touched_in_run: touched.has(lane.id),
      next_page: lane.nextPage,
      next_cursor: lane.nextCursor,
      last_page_job_ids: lane.lastPageJobIds,
      exhausted: lane.exhausted,
      stop_reason: lane.stopReason,
    };
  });
  const trackDetailsComplete = run.detailsComplete && (trackBacklogCounts?.pending ?? 0) === 0;
  const compatibleDetailsComplete = run.detailsComplete && (backlogCounts?.pending ?? 0) === 0;
  const complete = run.collectionComplete && trackDetailsComplete;
  const settlementBlocked = ["authentication_required", "browser_unavailable", "pagination_unverified", "detail_unavailable"].includes(run.stopReason ?? "");
  const settled = lanes.length > 0
    && lanes.every((lane) => lane.exhausted || lane.stopReason === "source_cap")
    && (detailCounts?.pending ?? 0) === 0
    && (trackBacklogCounts?.pending ?? 0) === 0
    && (trackUnavailableCounts?.unavailable ?? 0) === 0
    && !settlementBlocked;
  const lookbackSeconds = run.lookbackSeconds === null ? null : run.lookbackSeconds + elapsedSeconds;
  const gaps = [
    ...(run.stopReason ? [{ kind: "run_stopped", reason: run.stopReason }] : []),
    ...laneStates.filter((lane) => !lane.exhausted).map((lane) => ({ kind: "lane_not_exhausted", lane_key: lane.lane_key, next_page: lane.next_page, touched_in_run: lane.touched_in_run, ...(lane.stop_reason ? { reason: lane.stop_reason } : {}) })),
    ...((detailCounts?.pending ?? 0) ? [{ kind: "pending_details", count: detailCounts?.pending ?? 0 }] : []),
    ...((detailCounts?.unavailable ?? 0) ? [{ kind: "detail_unavailable", count: detailCounts?.unavailable ?? 0 }] : []),
    ...((backlogCounts?.pending ?? 0) ? [{ kind: "compatible_pending_detail_backlog", count: backlogCounts?.pending ?? 0 }] : []),
  ];
  return {
    schema_version: 1,
    track: run.track,
    plan_hash: run.planHash,
    policy_hash: run.policyHash,
    scope_key: run.scopeKey,
    mode: run.mode,
    scan_started_at: run.scanStartedAt.toISOString(),
    lookback_seconds_at_start: run.lookbackSeconds,
    lookback_seconds: lookbackSeconds,
    apply_linkedin_time_filter: lookbackSeconds ? `r${lookbackSeconds}` : null,
    collection_complete: run.collectionComplete,
    details_complete: trackDetailsComplete,
    run_details_complete: run.detailsComplete,
    compatible_details_complete: compatibleDetailsComplete,
    complete,
    settled,
    settlement_scope: "provider_visible_results",
    completeness_scope: "observed_lane_traversal",
    source_snapshot_guaranteed: false,
    coverage_limitation: "LinkedIn offset results can change during traversal; finished pages do not prove all matching jobs were observed. Untouched lanes and budget stops remain explicit gaps.",
    provider_limits: {
      page_size: LINKEDIN_PROVIDER_PAGE_SIZE,
      max_pages_per_lane: LINKEDIN_PROVIDER_MAX_PAGES_PER_LANE,
      visible_result_cap_per_lane: LINKEDIN_PROVIDER_VISIBLE_RESULT_CAP,
    },
    watermark_started_at: null,
    stop_reason: run.stopReason,
    gaps,
    lanes: laneStates,
    pending_detail_job_ids: pending,
    pending_detail_count: detailCounts?.pending ?? 0,
    pending_detail_ids_truncated: pendingRows.length > LINKEDIN_SCAN_MAX_PENDING_DETAILS_RETURNED,
    backlog_pending_detail_job_ids: backlog,
    backlog_pending_detail_count: backlogCounts?.pending ?? 0,
    track_backlog_pending_detail_count: trackBacklogCounts?.pending ?? 0,
    backlog_pending_ids_truncated: backlogRows.length > LINKEDIN_SCAN_MAX_PENDING_DETAILS_RETURNED,
    completed_detail_count: detailCounts?.completed ?? 0,
    unavailable_detail_count: detailCounts?.unavailable ?? 0,
  };
}

async function priorCompatibleRun(run: Run, tx: Tx) {
  const [prior] = await tx.select().from(linkedinSearchRuns).where(and(
    eq(linkedinSearchRuns.scopeKey, run.scopeKey),
    eq(linkedinSearchRuns.planHash, run.planHash),
    eq(linkedinSearchRuns.track, run.track),
    ne(linkedinSearchRuns.id, run.id),
  )).orderBy(desc(linkedinSearchRuns.createdAt)).limit(1);
  return prior ?? null;
}

async function runIsSettled(run: Run, tx: Tx) {
  return (await renderState(await refreshRunCompletion(run.id, tx), tx)).settled;
}

async function copyRunFrontier(run: Run, prior: Run, normalizedPlan: ReturnType<typeof normalizedLinkedinScanPlan>, tx: Tx) {
  const priorLanes = await tx.select().from(linkedinSearchLanes).where(eq(linkedinSearchLanes.runId, prior.id));
  const priorByKey = new Map(priorLanes.map((lane) => [lane.laneKey, lane]));
  await tx.insert(linkedinSearchLanes).values(normalizedPlan.lanes.map((lane) => {
    const frontier = priorByKey.get(lane.laneKey);
    if (!frontier) throw new WorkerHttpError("Stored LinkedIn frontier does not match the frozen scan plan");
    return { runId: run.id, ...lane, lookbackSeconds: frontier.lookbackSeconds, nextPage: frontier.nextPage, nextCursor: frontier.nextCursor, lastPageJobIds: frontier.lastPageJobIds, exhausted: frontier.exhausted, exhaustedAt: frontier.exhaustedAt, stopReason: frontier.stopReason, stoppedAt: frontier.stoppedAt };
  }));
  const incompleteDetails = await tx.select({ linkedinJobId: linkedinSearchDetails.linkedinJobId, status: linkedinSearchDetails.status }).from(linkedinSearchDetails).where(and(
    eq(linkedinSearchDetails.runId, prior.id),
    inArray(linkedinSearchDetails.status, ["pending", "unavailable"]),
  ));
  if (incompleteDetails.length) await tx.insert(linkedinSearchDetails).values(incompleteDetails.map((row) => ({ runId: run.id, linkedinJobId: row.linkedinJobId, status: row.status })));
  const [updated] = await tx.update(linkedinSearchRuns).set({ scanStartedAt: prior.scanStartedAt, lookbackSeconds: prior.lookbackSeconds }).where(eq(linkedinSearchRuns.id, run.id)).returning();
  return updated;
}

async function createFreshLanes(run: Run, normalizedPlan: ReturnType<typeof normalizedLinkedinScanPlan>, tx: Tx) {
  const prior = await priorCompatibleRun(run, tx);
  if (prior && !(await runIsSettled(prior, tx))) return copyRunFrontier(run, prior, normalizedPlan, tx);
  await tx.insert(linkedinSearchLanes).values(normalizedPlan.lanes.map((lane) => ({ runId: run.id, ...lane, lookbackSeconds: LINKEDIN_DAILY_LOOKBACK_SECONDS })));
  return run;
}

async function createBackfillLanes(run: Run, normalizedPlan: ReturnType<typeof normalizedLinkedinScanPlan>, tx: Tx) {
  const prior = await priorCompatibleRun(run, tx);
  if (prior) return copyRunFrontier(run, prior, normalizedPlan, tx);
  await tx.insert(linkedinSearchLanes).values(normalizedPlan.lanes.map((lane) => ({ runId: run.id, ...lane, lookbackSeconds: LINKEDIN_BOOTSTRAP_LOOKBACK_SECONDS })));
  return run;
}

export async function getOrCreateLinkedinScanState(task: Task, input: LinkedinScanPlan, tx: Tx) {
  const scopeKey = requireLinkedinSearchTask(task);
  const policyHash = await currentPolicyHash(tx);
  if (input.policy_hash !== policyHash) throw new WorkerHttpError("Search policy changed; reload task context and rebuild the scan plan");
  const normalizedPlan = normalizedLinkedinScanPlan(input);
  const planHash = linkedinScanPlanHash(scopeKey, policyHash, input);
  const existing = await currentRun(task.id, input.track, tx, true);
  if (existing) {
    if (existing.planHash !== planHash) throw new WorkerHttpError("This task already has a different frozen LinkedIn scan plan for this track");
    return renderState(await refreshRunCompletion(existing.id, tx), tx);
  }
  const sibling = await tx.select({ planHash: linkedinSearchRuns.planHash }).from(linkedinSearchRuns).where(eq(linkedinSearchRuns.taskId, task.id)).limit(1);
  if (sibling[0] && sibling[0].planHash !== planHash) throw new WorkerHttpError("Fresh and backfill tracks must share one frozen LinkedIn scan plan");
  if (input.track === "fresh") {
    const [bootstrap] = await tx.select().from(linkedinSearchRuns).where(and(
      eq(linkedinSearchRuns.scopeKey, scopeKey),
      eq(linkedinSearchRuns.planHash, planHash),
      eq(linkedinSearchRuns.track, "backfill"),
    )).orderBy(desc(linkedinSearchRuns.createdAt)).limit(1);
    if (!bootstrap || !(await runIsSettled(bootstrap, tx))) throw new WorkerHttpError("Settle the compatible 30-day LinkedIn bootstrap before starting a daily scan", 409);
  }

  const taskStartedAt = task.startedAt ?? new Date();
  const [inserted] = await tx.insert(linkedinSearchRuns).values({
    taskId: task.id,
    track: input.track,
    scopeKey,
    planHash,
    policyHash,
    mode: input.track === "fresh" ? "daily_1d" : "bootstrap_30d",
    scanStartedAt: taskStartedAt,
    lookbackSeconds: input.track === "fresh" ? LINKEDIN_DAILY_LOOKBACK_SECONDS : LINKEDIN_BOOTSTRAP_LOOKBACK_SECONDS,
  }).returning();
  const run = input.track === "fresh"
    ? await createFreshLanes(inserted, normalizedPlan, tx)
    : await createBackfillLanes(inserted, normalizedPlan, tx);
  return renderState(await refreshRunCompletion(run.id, tx), tx);
}

async function requireRun(task: Task, track: LinkedinScanTrack, planHash: string, tx: Tx) {
  const scopeKey = requireLinkedinSearchTask(task);
  const run = await currentRun(task.id, track, tx, true);
  if (!run) throw new WorkerHttpError("Initialize this LinkedIn scan track before recording progress");
  if (run.planHash !== planHash || run.scopeKey !== scopeKey) throw new WorkerHttpError("LinkedIn scan plan hash does not match this task");
  return run;
}

async function requireDurableObservations(candidateId: string, jobIds: string[], tx: Tx) {
  if (!jobIds.length) return;
  const rows = await tx.select({ jobId: linkedinSnapshots.linkedinJobId }).from(linkedinSnapshots).where(and(
    eq(linkedinSnapshots.candidateId, candidateId),
    inArray(linkedinSnapshots.linkedinJobId, jobIds),
  ));
  const stored = new Set(rows.map((row) => row.jobId));
  const missing = jobIds.filter((id) => !stored.has(id));
  if (missing.length) throw new WorkerHttpError("Page progress cannot outrun durable LinkedIn observations");
}

async function requireTaskObservations(taskId: string, jobIds: string[], tx: Tx) {
  if (!jobIds.length) return;
  const receipts = await tx.select({ acceptedJobIds: linkedinIngestReceipts.acceptedJobIds }).from(linkedinIngestReceipts).where(like(linkedinIngestReceipts.collectorRunKey, `task:${taskId}:%`));
  const accepted = new Set(receipts.flatMap((receipt) => receipt.acceptedJobIds));
  if (jobIds.some((id) => !accepted.has(id))) throw new WorkerHttpError("Incomplete-page pending IDs require durable observations from this task");
  const [task] = await tx.select({ candidateId: sql<string>`${agentTasks.payload}->>'candidateId'` }).from(agentTasks).where(eq(agentTasks.id, taskId)).limit(1);
  if (!task?.candidateId) throw new WorkerHttpError("Search task has no candidate identity");
  await requireDurableObservations(task.candidateId, jobIds, tx);
}

export async function recordLinkedinScanPage(task: Task, input: LinkedinScanPage, tx: Tx) {
  const run = await requireRun(task, input.track, input.plan_hash, tx);
  const [lane] = await tx.select().from(linkedinSearchLanes).where(and(eq(linkedinSearchLanes.runId, run.id), eq(linkedinSearchLanes.laneKey, input.lane_key))).for("update").limit(1);
  if (!lane) throw new WorkerHttpError("LinkedIn scan lane not found", 404);
  const canonical = { page: input.page, sourceCursor: input.source_cursor ?? null, nextCursor: input.next_cursor ?? null, jobIds: [...input.job_ids].sort(), pendingDetailJobIds: [...input.pending_detail_job_ids].sort(), exhausted: input.exhausted };
  const payloadHash = stableJsonHash(canonical);
  const [receipt] = await tx.select().from(linkedinSearchPages).where(and(eq(linkedinSearchPages.laneId, lane.id), eq(linkedinSearchPages.pageNumber, input.page))).limit(1);
  if (receipt) {
    if (receipt.payloadHash !== payloadHash) throw new WorkerHttpError("This scan page was already recorded with different evidence");
    return { idempotent_replay: true, state: await renderState(await refreshRunCompletion(run.id, tx), tx) };
  }
  if (lane.exhausted) throw new WorkerHttpError("LinkedIn scan lane is already exhausted");
  if (input.page !== lane.nextPage || (input.source_cursor ?? null) !== lane.nextCursor) throw new WorkerHttpError("LinkedIn scan page does not match the durable frontier");
  const previousIds = [...lane.lastPageJobIds].sort();
  if (canonical.jobIds.length && stableJsonHash(canonical.jobIds) === stableJsonHash(previousIds)) throw new WorkerHttpError("LinkedIn returned the same job IDs again; the lane is not proven exhausted");
  await requireDurableObservations(String(task.payload.candidateId), input.job_ids, tx);
  await tx.insert(linkedinSearchPages).values({ runId: run.id, laneId: lane.id, pageNumber: input.page, payloadHash, jobIds: canonical.jobIds, sourceCursor: canonical.sourceCursor, nextCursor: canonical.nextCursor, exhausted: input.exhausted });
  if (canonical.pendingDetailJobIds.length) await tx.insert(linkedinSearchDetails).values(canonical.pendingDetailJobIds.map((linkedinJobId) => ({ runId: run.id, linkedinJobId }))).onConflictDoNothing({ target: [linkedinSearchDetails.runId, linkedinSearchDetails.linkedinJobId] });
  const now = new Date();
  await tx.update(linkedinSearchLanes).set({ nextPage: input.page + 1, nextCursor: canonical.nextCursor, lastPageJobIds: canonical.jobIds, exhausted: input.exhausted, exhaustedAt: input.exhausted ? now : null, stopReason: null, stoppedAt: null, updatedAt: now }).where(eq(linkedinSearchLanes.id, lane.id));
  await tx.update(linkedinSearchRuns).set({ stopReason: null, stoppedAt: null, updatedAt: now }).where(eq(linkedinSearchRuns.id, run.id));
  return { idempotent_replay: false, state: await renderState(await refreshRunCompletion(run.id, tx), tx) };
}

function hasFullSnapshot(snapshot: { title: string; company: string | null; canonicalUrl: string; jobId: string; snapshotEvidence: Record<string, unknown> | null }) {
  const description = snapshot.snapshotEvidence?.description;
  if (!snapshot.title.trim() || !snapshot.company?.trim() || typeof description !== "string" || !description.trim() || description.length > 100_000) return false;
  try {
    const parsed = new URL(snapshot.canonicalUrl);
    return parsed.protocol === "https:" && ["linkedin.com", "www.linkedin.com"].includes(parsed.hostname.toLowerCase()) && new RegExp(`^/jobs/view/${snapshot.jobId}/?$`).test(parsed.pathname);
  } catch {
    return false;
  }
}

export async function recordLinkedinScanDetails(task: Task, input: LinkedinScanDetails, tx: Tx) {
  const run = await requireRun(task, input.track, input.plan_hash, tx);
  const compatibleRows = await tx.select({ id: linkedinSearchDetails.id, runId: linkedinSearchDetails.runId, jobId: linkedinSearchDetails.linkedinJobId }).from(linkedinSearchDetails)
    .innerJoin(linkedinSearchRuns, eq(linkedinSearchDetails.runId, linkedinSearchRuns.id))
    .where(and(eq(linkedinSearchRuns.scopeKey, run.scopeKey), eq(linkedinSearchRuns.planHash, run.planHash), eq(linkedinSearchDetails.status, "pending"), inArray(linkedinSearchDetails.linkedinJobId, input.job_ids))).for("update");
  const authorizedIds = new Set(compatibleRows.map((row) => row.jobId));
  if (input.job_ids.some((id) => !authorizedIds.has(id))) throw new WorkerHttpError("Detail completion includes a job outside this compatible scan backlog");
  const receipts = await tx.select({ snapshotReadyJobIds: linkedinIngestReceipts.snapshotReadyJobIds }).from(linkedinIngestReceipts).where(like(linkedinIngestReceipts.collectorRunKey, `task:${task.id}:%`));
  const acceptedThisTask = new Set(receipts.flatMap((receipt) => receipt.snapshotReadyJobIds));
  const snapshots = await tx.select({ jobId: linkedinSnapshots.linkedinJobId, canonicalUrl: linkedinSnapshots.canonicalUrl, title: linkedinSnapshots.title, company: linkedinSnapshots.company, state: linkedinSnapshots.state, snapshotEvidence: linkedinSnapshots.snapshotEvidence, collectorRunKey: linkedinSnapshots.collectorRunKey, evaluatedPolicyHash: linkedinSnapshots.evaluatedPolicyHash, completedAt: linkedinSnapshots.completedAt }).from(linkedinSnapshots).where(and(
    eq(linkedinSnapshots.candidateId, String(task.payload.candidateId)),
    inArray(linkedinSnapshots.linkedinJobId, input.job_ids),
    isNotNull(linkedinSnapshots.snapshotEvidence),
  ));
  const nowMs = Date.now();
  const persisted = new Set(snapshots.filter((snapshot) => {
    if (!hasFullSnapshot(snapshot)) return false;
    const currentTaskEvidence = acceptedThisTask.has(snapshot.jobId) && snapshot.collectorRunKey.startsWith(`task:${task.id}:`);
    const rejectedNeedsRefresh = snapshot.state === "rejected" && (snapshot.evaluatedPolicyHash !== run.policyHash || !snapshot.completedAt || nowMs - snapshot.completedAt.getTime() > 7 * 86_400_000);
    const alreadyCurrent = !["discovered_compact", "failed_transient"].includes(snapshot.state) && !rejectedNeedsRefresh;
    return currentTaskEvidence || alreadyCurrent;
  }).map((snapshot) => snapshot.jobId));
  if (input.job_ids.some((id) => !persisted.has(id))) throw new WorkerHttpError("Detail completion requires a durable full snapshot that no longer needs fetching");
  const detailRowIds = compatibleRows.map((row) => row.id);
  const affectedRunIds = [...new Set(compatibleRows.map((row) => row.runId))];
  const now = new Date();
  await tx.update(linkedinSearchDetails).set({ status: "completed", completedAt: now, updatedAt: now }).where(inArray(linkedinSearchDetails.id, detailRowIds));
  for (const runId of affectedRunIds) await refreshRunCompletion(runId, tx);
  await tx.update(linkedinSearchRuns).set({ stopReason: null, stoppedAt: null, updatedAt: now }).where(eq(linkedinSearchRuns.id, run.id));
  return { acknowledged_run_count: affectedRunIds.length, state: await renderState(await refreshRunCompletion(run.id, tx), tx) };
}

export async function recordLinkedinScanStop(task: Task, input: LinkedinScanStop, tx: Tx) {
  const run = await requireRun(task, input.track, input.plan_hash, tx);
  const now = new Date();
  if (input.detail_job_id) {
    const rows = await tx.select({ id: linkedinSearchDetails.id }).from(linkedinSearchDetails)
      .innerJoin(linkedinSearchRuns, eq(linkedinSearchDetails.runId, linkedinSearchRuns.id))
      .where(and(
        eq(linkedinSearchRuns.scopeKey, run.scopeKey),
        eq(linkedinSearchRuns.planHash, run.planHash),
        eq(linkedinSearchDetails.linkedinJobId, input.detail_job_id),
        eq(linkedinSearchDetails.status, "pending"),
      )).for("update");
    if (!rows.length) throw new WorkerHttpError("Unavailable detail evidence is not pending in this compatible scan backlog");
    await tx.update(linkedinSearchDetails).set({ status: "unavailable", updatedAt: now }).where(inArray(linkedinSearchDetails.id, rows.map((row) => row.id)));
    // A detail may come from an older compatible backlog rather than this run's
    // own pages. Mirror the terminal gap into the active run so its completion
    // state and any copied continuation frontier cannot lose that evidence.
    await tx.insert(linkedinSearchDetails).values({
      runId: run.id,
      linkedinJobId: input.detail_job_id,
      status: "unavailable",
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [linkedinSearchDetails.runId, linkedinSearchDetails.linkedinJobId],
      set: { status: "unavailable", completedAt: null, updatedAt: now },
    });
    await tx.update(linkedinSearchRuns).set({ stopReason: input.reason, stoppedAt: now, updatedAt: now }).where(eq(linkedinSearchRuns.id, run.id));
  } else if (input.lane_key) {
    await requireTaskObservations(task.id, input.pending_detail_job_ids, tx);
    const [lane] = await tx.update(linkedinSearchLanes).set({ stopReason: input.reason, stoppedAt: now, updatedAt: now }).where(and(eq(linkedinSearchLanes.runId, run.id), eq(linkedinSearchLanes.laneKey, input.lane_key), eq(linkedinSearchLanes.exhausted, false))).returning();
    if (!lane) throw new WorkerHttpError("Only an unfinished LinkedIn lane can be stopped");
    if (input.pending_detail_job_ids.length) await tx.insert(linkedinSearchDetails).values(input.pending_detail_job_ids.map((linkedinJobId) => ({ runId: run.id, linkedinJobId }))).onConflictDoNothing({ target: [linkedinSearchDetails.runId, linkedinSearchDetails.linkedinJobId] });
  } else {
    await tx.update(linkedinSearchRuns).set({ stopReason: input.reason, stoppedAt: now, updatedAt: now }).where(eq(linkedinSearchRuns.id, run.id));
  }
  const refreshed = await currentRun(task.id, input.track, tx);
  if (!refreshed) throw new WorkerHttpError("LinkedIn scan run not found", 404);
  return { state: await renderState(await refreshRunCompletion(refreshed.id, tx), tx) };
}

export async function linkedinCoverageForTaskCompletion(task: Task, tx: Tx) {
  if (task.kind !== "search" || !Array.isArray(task.payload.sources) || !task.payload.sources.includes("linkedin")) return null;
  const runs = await tx.select().from(linkedinSearchRuns).where(eq(linkedinSearchRuns.taskId, task.id)).for("update");
  if (!runs.length) {
    return { schema_version: 3, phase: null, phase_settled: false, fresh: null, backfill: null, fresh_observation_complete: false, fresh_details_complete: false, historical_backfill_complete: false, historical_backfill_settled: false, complete: false, completeness_scope: "observed_lane_traversal", source_snapshot_guaranteed: false, coverage_limitation: "LinkedIn offset results can change during traversal; finished pages do not prove all matching jobs were observed.", gaps: [{ kind: "scan_not_started" }] };
  }
  const states = new Map<string, Awaited<ReturnType<typeof renderState>>>();
  for (const run of runs) states.set(run.track, await renderState(await refreshRunCompletion(run.id, tx), tx));
  const fresh = states.get("fresh") ?? null;
  const backfill = states.get("backfill") ?? null;
  const freshObservationComplete = fresh?.collection_complete === true;
  const freshDetailsComplete = fresh?.details_complete === true;
  const historicalBackfillComplete = backfill?.complete === true;
  const historicalBackfillSettled = backfill?.settled === true;
  const phase = fresh ? "daily_1d" : "bootstrap_30d";
  const phaseSettled = (fresh ?? backfill)?.settled === true;
  const gaps = [
    ...(fresh ? fresh.gaps.map((gap) => ({ track: "fresh", ...gap })) : []),
    ...(!backfill ? [{ track: "backfill", kind: "scan_not_started" }] : backfill.gaps.map((gap) => ({ track: "backfill", ...gap }))),
  ];
  return {
    schema_version: 3,
    phase,
    phase_settled: phaseSettled,
    fresh,
    backfill,
    fresh_observation_complete: freshObservationComplete,
    fresh_details_complete: freshDetailsComplete,
    historical_backfill_complete: historicalBackfillComplete,
    historical_backfill_settled: historicalBackfillSettled,
    complete: historicalBackfillComplete && (phase === "bootstrap_30d" || (freshObservationComplete && freshDetailsComplete)),
    completeness_scope: "observed_lane_traversal",
    source_snapshot_guaranteed: false,
    coverage_limitation: "LinkedIn offset results can change during traversal; finished pages do not prove all matching jobs were observed. Phase completeness requires enough budget to exhaust every lane and ingest every pending description within the provider's visible result cap.",
    gaps,
  };
}
