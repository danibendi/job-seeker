import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  activityLog,
  agentExecutionSettings,
  agentScheduleOccurrences,
  agentTasks,
  eventsOutbox,
  linkedinSearchDetails,
  linkedinSearchPages,
  linkedinSearchRuns,
  linkedinSnapshots,
  notificationPreferences,
  requests,
  searchSettings,
} from "@/db/schema";
import { settingsFromRow } from "@/lib/data";
import {
  getDueScheduleOccurrence,
  isFreshTerminalLinkedInDecision,
  isSupersededAgentTaskCheckpoint,
  mergeWorkerCheckpoint,
  searchScopeKey,
  sha256OpaqueToken,
  stableJsonHash,
  type AgentTaskCheckpoint,
  type AgentTaskExecutor,
  type AgentTaskGrant,
  type AgentTaskKind,
  type AgentTaskPayload,
  type AgentTaskResult,
  type AgentWorkerExecutor,
  type SearchExecutionSnapshot,
} from "@/lib/agent-task-contract";
import { linkedinCoverageForTaskCompletion } from "@/lib/linkedin-scan";
import { DEFAULT_LINKEDIN_BROWSER_BUDGETS_USD, linkedinContinuation } from "@/lib/linkedin-continuation";
import { linkedinBrowserBudgetAvailable, retainLinkedinBrowserAttempts } from "@/lib/linkedin-browser-accounting";
import { linkedinFailureContinuation } from "@/lib/linkedin-failure-continuation";
import { lockEffectiveSearchPolicy } from "@/lib/search-settings-store";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "@/lib/time";
import { getWorkspace } from "@/lib/workspace";
import { WORKSPACE_ID } from "@/lib/workspace-values";

type Database = ReturnType<typeof getDb>;
export type AgentTaskTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type AgentTaskRecord = Omit<typeof agentTasks.$inferSelect, "claimTokenHash">;
export type AgentExecutionSettingsRecord = typeof agentExecutionSettings.$inferSelect;
export type AgentTaskClaim = { task: AgentTaskRecord; claimToken: string };

export type EnqueueAgentTaskInput = {
  requestId?: string | null;
  snapshotId?: string | null;
  parentTaskId?: string | null;
  kind: AgentTaskKind;
  executor?: AgentTaskExecutor;
  dedupeKey: string;
  payload?: AgentTaskPayload;
  maxAttempts?: number;
  availableAt?: Date;
  scheduledFor?: Date | null;
  externalRef?: string | null;
};

export type SearchTaskInput = {
  purpose: "search_now" | "scheduled_search";
  text?: string;
  scopeKey?: string;
  dedupeKey?: string;
  scheduledFor?: Date;
  payload?: AgentTaskPayload;
  executor?: AgentTaskExecutor;
};

const ACTIVE_TASK_STATUSES = ["queued", "running", "waiting_for_user"] as const;
const DEFAULT_EXECUTION_SETTINGS = {
  id: WORKSPACE_ID,
  searchExecutor: "unassigned",
  evaluationExecutor: "unassigned",
  searchSources: [],
  maxPages: 10,
  maxDetailFetches: 30,
  maxDurationSeconds: 1200,
} as const;

function publicTask(task: typeof agentTasks.$inferSelect): AgentTaskRecord {
  const { claimTokenHash, ...safe } = task;
  void claimTokenHash;
  return safe;
}

function throwRangeError(name: string, min: number, max: number): never {
  throw new Error(`${name} must be a whole number between ${min} and ${max}`);
}

function normalizeInteger(value: number, name: string, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) throwRangeError(name, min, max);
  return value;
}

async function inTransaction<T>(tx: AgentTaskTransaction | undefined, work: (store: AgentTaskTransaction) => Promise<T>) {
  if (tx) return work(tx);
  return getDb().transaction(work);
}

async function emitTaskEvent(
  tx: AgentTaskTransaction,
  actor: "owner" | "assistant" | "system",
  type: string,
  payload: Record<string, unknown>,
  message: string,
) {
  await tx.insert(eventsOutbox).values({ type, payload });
  await tx.insert(activityLog).values({ actor, type, payload, message });
}

async function readExecutionSettings(tx: AgentTaskTransaction): Promise<AgentExecutionSettingsRecord> {
  const [row] = await tx.select().from(agentExecutionSettings).where(eq(agentExecutionSettings.id, WORKSPACE_ID)).limit(1);
  return row ?? { ...DEFAULT_EXECUTION_SETTINGS, searchSources: [...DEFAULT_EXECUTION_SETTINGS.searchSources], updatedAt: new Date(0) };
}

export async function getAgentExecutionSettings(tx?: AgentTaskTransaction) {
  return inTransaction(tx, readExecutionSettings);
}

export async function updateAgentExecutionSettings(
  patch: Partial<Pick<AgentExecutionSettingsRecord, "searchExecutor" | "evaluationExecutor" | "searchSources" | "maxPages" | "maxDetailFetches" | "maxDurationSeconds">>,
  tx?: AgentTaskTransaction,
) {
  return inTransaction(tx, async (store) => {
    const current = await readExecutionSettings(store);
    const searchSources = patch.searchSources
      ? [...new Set(patch.searchSources.map((source) => source.trim()).filter(Boolean))].slice(0, 20)
      : current.searchSources;
    const next = {
      searchExecutor: patch.searchExecutor ?? current.searchExecutor,
      evaluationExecutor: patch.evaluationExecutor ?? current.evaluationExecutor,
      searchSources,
      maxPages: patch.maxPages === undefined ? current.maxPages : normalizeInteger(patch.maxPages, "maxPages", 1, 1_000),
      maxDetailFetches: patch.maxDetailFetches === undefined ? current.maxDetailFetches : normalizeInteger(patch.maxDetailFetches, "maxDetailFetches", 0, 10_000),
      maxDurationSeconds: patch.maxDurationSeconds === undefined ? current.maxDurationSeconds : normalizeInteger(patch.maxDurationSeconds, "maxDurationSeconds", 1, 86_400),
      updatedAt: new Date(),
    };
    const [saved] = await store.insert(agentExecutionSettings).values({ id: WORKSPACE_ID, ...next }).onConflictDoUpdate({
      target: agentExecutionSettings.id,
      set: next,
    }).returning();
    return saved;
  });
}

async function enqueueAgentTaskInTransaction(tx: AgentTaskTransaction, input: EnqueueAgentTaskInput) {
  const maxAttempts = normalizeInteger(input.maxAttempts ?? 3, "maxAttempts", 1, 100);
  const [created] = await tx.insert(agentTasks).values({
    requestId: input.requestId ?? null,
    snapshotId: input.snapshotId ?? null,
    parentTaskId: input.parentTaskId ?? null,
    kind: input.kind,
    executor: input.executor ?? "unassigned",
    dedupeKey: input.dedupeKey,
    payload: input.payload ?? {},
    maxAttempts,
    availableAt: input.availableAt ?? new Date(),
    scheduledFor: input.scheduledFor ?? null,
    externalRef: input.externalRef ?? null,
  }).onConflictDoNothing({ target: agentTasks.dedupeKey }).returning();
  if (created) return { task: publicTask(created), created: true };
  const [existing] = await tx.select().from(agentTasks).where(eq(agentTasks.dedupeKey, input.dedupeKey)).limit(1);
  if (!existing) throw new Error("Task could not be enqueued");
  return { task: publicTask(existing), created: false };
}

export async function enqueueAgentTask(input: EnqueueAgentTaskInput, tx?: AgentTaskTransaction) {
  return inTransaction(tx, (store) => enqueueAgentTaskInTransaction(store, input));
}

export async function enqueueSearchTask(input: SearchTaskInput, tx?: AgentTaskTransaction) {
  return inTransaction(tx, async (store) => {
    const [settingsRow, execution, workspace] = await Promise.all([
      store.select().from(searchSettings).where(eq(searchSettings.id, WORKSPACE_ID)).limit(1).then((rows) => rows[0]),
      readExecutionSettings(store),
      getWorkspace(store),
    ]);
    assertSearchSourcesConfigured(execution.searchSources);
    const search = settingsFromRow(settingsRow);
    const executor = input.executor ?? execution.searchExecutor;
    const scopeKey = input.scopeKey ?? searchScopeKey(search, execution.searchSources);
    await store.execute(sql`select pg_advisory_xact_lock(hashtext(${`owner:agent-search:${scopeKey}`}))`);

    const [active] = await store.select().from(agentTasks).where(and(
      eq(agentTasks.kind, "search"),
      inArray(agentTasks.status, [...ACTIVE_TASK_STATUSES]),
      sql`${agentTasks.payload}->>'scopeKey' = ${scopeKey}`,
    )).orderBy(asc(agentTasks.createdAt)).limit(1);
    if (active) {
      const [request] = active.requestId
        ? await store.select().from(requests).where(eq(requests.id, active.requestId)).limit(1)
        : [];
      return { task: publicTask(active), request: request ?? null, created: false, coalesced: true };
    }

    const snapshot: SearchExecutionSnapshot = {
      candidateId: workspace.candidateId,
      purpose: input.purpose,
      scopeKey,
      searchSettings: search as unknown as Record<string, unknown>,
      sources: execution.searchSources,
      budgets: {
        maxPages: execution.maxPages,
        maxDetailFetches: execution.maxDetailFetches,
        maxDurationSeconds: execution.maxDurationSeconds,
      },
      execution: {
        executor,
        sources: execution.searchSources,
        maxPages: execution.maxPages,
        maxDetailFetches: execution.maxDetailFetches,
        maxDurationSeconds: execution.maxDurationSeconds,
      },
    };
    const payload = { ...(input.payload ?? {}), ...snapshot,
      browserBudgetsUsd: { ...DEFAULT_LINKEDIN_BROWSER_BUDGETS_USD }, browserSpendUsd: 0 };
    const [request] = await store.insert(requests).values({
      text: input.text ?? (input.purpose === "search_now" ? "Run a job search now" : "Run the scheduled job search"),
      purpose: input.purpose,
      payload,
    }).returning();
    const enqueued = await enqueueAgentTaskInTransaction(store, {
      requestId: request.id,
      kind: "search",
      executor,
      dedupeKey: input.dedupeKey ?? `${input.purpose}:${randomUUID()}`,
      payload,
      scheduledFor: input.scheduledFor,
    });
    await emitTaskEvent(
      store,
      input.purpose === "search_now" ? "owner" : "system",
      "search_requested",
      { request_id: request.id, task_id: enqueued.task.id, purpose: input.purpose, scope_key: scopeKey },
      input.purpose === "search_now" ? "Queued a job search." : "Queued the scheduled job search.",
    );
    return { ...enqueued, request, coalesced: false };
  });
}

export function assertSearchSourcesConfigured(sources: readonly string[]) {
  if (!sources.length) throw new Error("Enable at least one search source before starting a search");
}

export async function enqueueQuestionTask(input: {
  text: string;
  jobId?: string | null;
  payload?: AgentTaskPayload;
  dedupeKey?: string;
  executor?: AgentTaskExecutor;
}, tx?: AgentTaskTransaction) {
  return inTransaction(tx, async (store) => {
    const dedupeKey = input.dedupeKey ?? `question:${randomUUID()}`;
    await store.execute(sql`select pg_advisory_xact_lock(hashtext(${`owner:agent-task:${dedupeKey}`}))`);
    const [existing] = await store.select().from(agentTasks).where(eq(agentTasks.dedupeKey, dedupeKey)).limit(1);
    if (existing) {
      const [request] = existing.requestId ? await store.select().from(requests).where(eq(requests.id, existing.requestId)).limit(1) : [];
      return { task: publicTask(existing), request: request ?? null, created: false };
    }
    const [request] = await store.insert(requests).values({ text: input.text, jobId: input.jobId ?? null, purpose: "question", payload: input.payload ?? {} }).returning();
    const enqueued = await enqueueAgentTaskInTransaction(store, { requestId: request.id, kind: "question", executor: input.executor ?? "unassigned", dedupeKey, payload: input.payload });
    await emitTaskEvent(store, "owner", "request_created", { request_id: request.id, task_id: enqueued.task.id, text: input.text, job_id: input.jobId ?? null }, "Queued a question for an agent.");
    return { ...enqueued, request };
  });
}

export async function enqueueLinkedInEvaluationTask(input: {
  snapshotId: string;
  parentTaskId?: string | null;
  payload?: AgentTaskPayload;
  dedupeKey?: string;
  executor?: AgentTaskExecutor;
}, tx?: AgentTaskTransaction) {
  return inTransaction(tx, async (store) => {
    const [execution, workspace] = await Promise.all([readExecutionSettings(store), getWorkspace(store)]);
    return enqueueAgentTaskInTransaction(store, {
      snapshotId: input.snapshotId,
      parentTaskId: input.parentTaskId,
      kind: "linkedin_evaluate",
      executor: input.executor ?? execution.evaluationExecutor,
      dedupeKey: input.dedupeKey ?? `linkedin-evaluate:${input.snapshotId}`,
      payload: { candidateId: workspace.candidateId, snapshotId: input.snapshotId, ...(input.payload ?? {}) },
    });
  });
}

async function expireLeases(tx: AgentTaskTransaction, now: Date) {
  const expired = await tx.select().from(agentTasks).where(and(
    eq(agentTasks.status, "running"),
    lte(agentTasks.leaseExpiresAt, now),
  )).for("update", { skipLocked: true });
  for (const task of expired) {
    const failed = task.attemptCount >= task.maxAttempts;
    await tx.update(agentTasks).set({
      status: failed ? "failed" : "queued",
      claimedBy: null,
      claimTokenHash: null,
      leaseExpiresAt: null,
      availableAt: now,
      lastError: "Worker lease expired",
      updatedAt: now,
      completedAt: failed ? now : null,
    }).where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, "running")));
    if (task.requestId) {
      await tx.update(requests).set(failed
        ? { status: "failed", errorMd: "Worker lease expired", updatedAt: now }
        : { status: "open", errorMd: null, updatedAt: now }
      ).where(eq(requests.id, task.requestId));
    }
    await emitTaskEvent(tx, "system", failed ? "agent_task_failed" : "agent_task_retry_queued", { task_id: task.id, reason: "lease_expired" }, failed ? "An agent task failed after its final lease expired." : "Requeued an agent task after its worker lease expired.");
  }
}

export async function claimAgentTask(input: {
  workerId: string;
  executor: AgentWorkerExecutor;
  kinds?: AgentTaskKind[];
  leaseSeconds?: number;
  now?: Date;
}, tx?: AgentTaskTransaction): Promise<AgentTaskClaim | null> {
  return inTransaction(tx, async (store) => {
    const now = input.now ?? new Date();
    const leaseSeconds = normalizeInteger(input.leaseSeconds ?? 300, "leaseSeconds", 1, 86_400);
    await expireLeases(store, now);
    let candidate: typeof agentTasks.$inferSelect | undefined;
    let retainedBrowserUsage: ReturnType<typeof retainLinkedinBrowserAttempts>;
    // Isolate an unsafe search retry without starving unrelated runnable work.
    while (true) {
      [candidate] = await store.select().from(agentTasks).where(and(
        eq(agentTasks.status, "queued"),
        lte(agentTasks.availableAt, now),
        eq(agentTasks.executor, input.executor),
        input.kinds ? inArray(agentTasks.kind, input.kinds) : undefined,
      )).orderBy(asc(agentTasks.availableAt), asc(agentTasks.createdAt)).limit(1).for("update", { skipLocked: true });
      if (!candidate) return null;
      try {
        retainedBrowserUsage = retainLinkedinBrowserAttempts(candidate);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : "LinkedIn browser accounting needs verification";
        await store.update(agentTasks).set({ status: "waiting_for_user", lastError: message, updatedAt: now })
          .where(eq(agentTasks.id, candidate.id));
        if (candidate.requestId) await store.update(requests).set({ status: "open", errorMd: message, updatedAt: now })
          .where(eq(requests.id, candidate.requestId));
        await emitTaskEvent(store, "system", "agent_task_waiting_for_user", { task_id: candidate.id, kind: candidate.kind }, message);
      }
    }
    const claimToken = randomBytes(32).toString("base64url");
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
    const [claimed] = await store.update(agentTasks).set({
      ...retainedBrowserUsage,
      executor: candidate.executor,
      externalRef: null,
      status: "running",
      startedAt: now,
      attemptCount: candidate.attemptCount + 1,
      claimedBy: input.workerId,
      claimTokenHash: sha256OpaqueToken(claimToken),
      leaseExpiresAt,
      lastError: null,
      updatedAt: now,
    }).where(and(eq(agentTasks.id, candidate.id), eq(agentTasks.status, "queued"))).returning();
    if (!claimed) return null;
    if (claimed.requestId) await store.update(requests).set({ status: "in_progress", errorMd: null, updatedAt: now }).where(eq(requests.id, claimed.requestId));
    await emitTaskEvent(store, input.executor === "hermes" ? "assistant" : "system", "agent_task_started", { task_id: claimed.id, kind: claimed.kind, executor: claimed.executor, attempt: claimed.attemptCount }, `Started ${claimed.kind.replaceAll("_", " ")} task.`);
    return { task: publicTask(claimed), claimToken };
  });
}

function activeGrantWhere(taskId: string, grant: AgentTaskGrant, now: Date) {
  return and(
    eq(agentTasks.id, taskId),
    eq(agentTasks.status, "running"),
    eq(agentTasks.claimedBy, grant.workerId),
    eq(agentTasks.claimTokenHash, sha256OpaqueToken(grant.claimToken)),
    gt(agentTasks.leaseExpiresAt, now),
  );
}

export async function renewAgentTaskLease(taskId: string, grant: AgentTaskGrant, leaseSeconds = 300, now = new Date(), tx?: AgentTaskTransaction) {
  return inTransaction(tx, async (store) => {
    normalizeInteger(leaseSeconds, "leaseSeconds", 1, 86_400);
    const [updated] = await store.update(agentTasks).set({ leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1_000), updatedAt: now }).where(activeGrantWhere(taskId, grant, now)).returning();
    if (!updated) throw new Error("Task claim is invalid or expired");
    return publicTask(updated);
  });
}

export async function updateAgentTaskProgress(taskId: string, grant: AgentTaskGrant, checkpoint: AgentTaskCheckpoint, now = new Date(), tx?: AgentTaskTransaction) {
  return inTransaction(tx, async (store) => {
    const [current] = await store.select().from(agentTasks).where(activeGrantWhere(taskId, grant, now)).limit(1).for("update");
    if (!current) throw new Error("Task claim is invalid or expired");
    const mergedCheckpoint = mergeWorkerCheckpoint(current.checkpoint, checkpoint);
    const [updated] = await store.update(agentTasks).set({ checkpoint: mergedCheckpoint, updatedAt: now }).where(activeGrantWhere(taskId, grant, now)).returning();
    if (!updated) throw new Error("Task claim is invalid or expired");
    return publicTask(updated);
  });
}

function requestResponse(result: AgentTaskResult) {
  for (const key of ["responseMd", "summaryMd", "response", "summary"] as const) {
    if (typeof result[key] === "string" && result[key].trim()) return result[key];
  }
  return null;
}

export function isPartialSearchResult(result: AgentTaskResult | null | undefined) {
  if (!result) return false;
  const coverage = result.linkedin_coverage;
  return result.status === "partial"
    || Boolean(coverage && typeof coverage === "object" && !Array.isArray(coverage) && (coverage as Record<string, unknown>).complete === false);
}

export async function completeAgentTask(taskId: string, grant: AgentTaskGrant, result: AgentTaskResult, now = new Date(), tx?: AgentTaskTransaction) {
  return inTransaction(tx, async (store) => {
    const grantHash = sha256OpaqueToken(grant.claimToken);
    const [current] = await store.select().from(agentTasks).where(activeGrantWhere(taskId, grant, now)).limit(1).for("update");
    if (!current) {
      const [existing] = await store.select().from(agentTasks).where(and(
        eq(agentTasks.id, taskId),
        eq(agentTasks.status, "succeeded"),
        eq(agentTasks.claimedBy, grant.workerId),
        eq(agentTasks.claimTokenHash, grantHash),
      )).limit(1);
      if (!existing) throw new Error("Task claim is invalid or expired");
      const replayResult = existing.kind === "search"
        ? {
            ...result,
            evaluation_pending: existing.result?.evaluation_pending ?? 0,
            evaluation_failed: existing.result?.evaluation_failed ?? 0,
            ...(existing.result && Object.hasOwn(existing.result, "linkedin_coverage") ? { linkedin_coverage: existing.result.linkedin_coverage } : {}),
            ...(existing.result && Object.hasOwn(existing.result, "linkedin_continuation") ? { linkedin_continuation: existing.result.linkedin_continuation } : {}),
          }
        : result;
      if (existing.resultHash !== stableJsonHash(replayResult)) throw new Error("Task was already completed with a different result");
      return { task: publicTask(existing), replayed: true };
    }

    if (current.kind === "linkedin_evaluate") {
      if (!current.snapshotId) throw new Error("LinkedIn evaluation task has no snapshot");
      const [snapshot] = await store.select({ state: linkedinSnapshots.state, completedAt: linkedinSnapshots.completedAt })
        .from(linkedinSnapshots).where(eq(linkedinSnapshots.id, current.snapshotId)).limit(1);
      if (!snapshot || !isFreshTerminalLinkedInDecision(snapshot.state, snapshot.completedAt, current.createdAt)) {
        throw new Error("LinkedIn snapshot needs a fresh terminal evaluation before task completion");
      }
    }

    let storedResult = result;
    if (current.kind === "search") {
      const [[counts], coverage] = await Promise.all([
        store.select({
          pending: sql<number>`count(*) filter (where ${agentTasks.status} in ('queued', 'running', 'waiting_for_user'))::int`,
          failed: sql<number>`count(*) filter (where ${agentTasks.status} in ('failed', 'cancelled'))::int`,
        }).from(agentTasks).where(and(eq(agentTasks.parentTaskId, current.id), eq(agentTasks.kind, "linkedin_evaluate"))),
        linkedinCoverageForTaskCompletion(current, store),
      ]);
      storedResult = { ...result, evaluation_pending: counts?.pending ?? 0, evaluation_failed: counts?.failed ?? 0, ...(coverage ? { linkedin_coverage: coverage } : {}) };
      if (coverage) {
        const policy = await lockEffectiveSearchPolicy(store);
        const continuation = linkedinContinuation({ result, coverage, payload: current.payload, currentPolicyHash: policy.policyHash });
        if (continuation) {
          storedResult = { ...storedResult, linkedin_continuation: continuation };
          if (continuation.resume) {
            // The completion and its one continuation are committed together.
            // Keep the frozen scope/frontier; public discovery already ran in
            // the first chunk and must not repeat for every detail backlog.
            const execution = current.payload.execution && typeof current.payload.execution === "object"
              ? current.payload.execution as Record<string, unknown> : {};
            await enqueueAgentTaskInTransaction(store, {
              kind: "search", executor: current.executor, parentTaskId: current.id, requestId: current.requestId,
              dedupeKey: `linkedin-resume:${current.id}`,
              payload: { ...current.payload, sources: ["linkedin"], execution: { ...execution, sources: ["linkedin"] },
                browserSpendUsd: continuation.browserSpendUsd, continuationOf: current.id },
            });
          }
        }
      }
    }
    const resultHash = stableJsonHash(storedResult);
    const [updated] = await store.update(agentTasks).set({
      status: "succeeded",
      result: storedResult,
      resultHash,
      lastError: null,
      completedAt: now,
      updatedAt: now,
    }).where(activeGrantWhere(taskId, grant, now)).returning();
    if (!updated) throw new Error("Task claim is invalid or expired");
    const continuing = (storedResult.linkedin_continuation as { resume?: boolean } | undefined)?.resume === true;
    if (updated.requestId) await store.update(requests).set({ status: continuing ? "in_progress" : "answered", responseMd: requestResponse(storedResult), errorMd: null, answeredAt: continuing ? null : now, updatedAt: now }).where(eq(requests.id, updated.requestId));
    const partialSearch = updated.kind === "search" && isPartialSearchResult(storedResult);
    await emitTaskEvent(
      store,
      updated.executor === "hermes" ? "assistant" : "system",
      "agent_task_succeeded",
      { task_id: updated.id, kind: updated.kind, request_id: updated.requestId, ...(partialSearch ? { partial: true } : {}) },
      continuing ? "Search chunk completed; collection will continue from its saved position." : partialSearch ? "Search finished with incomplete coverage." : `Completed ${updated.kind.replaceAll("_", " ")} task.`,
    );
    return { task: publicTask(updated), replayed: false };
  });
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const SAFE_TRANSIENT_BROWSER_METHODS = new Set([
  "Target.getTargets", "Target.createTarget", "Target.attachToTarget", "Target.closeTarget",
  "Page.enable", "Page.navigate", "Network.enable", "Network.setExtraHTTPHeaders",
  "Emulation.setLocaleOverride", "Fetch.enable", "Fetch.failRequest", "Fetch.continueRequest",
  "Runtime.evaluate",
]);

function safeTransientBrowserFailure(result: Record<string, unknown>) {
  const usage = jsonRecord(result.browser_usage);
  const browserFailure = jsonRecord(usage.browserFailure);
  const resourceBlocking = jsonRecord(usage.resourceBlocking);
  const blockingFailure = jsonRecord(resourceBlocking.failure);
  const hasBrowserFailure = Object.keys(browserFailure).length > 0;
  const hasBlockingFailure = Object.keys(blockingFailure).length > 0;
  const safeBrowserFailure = !hasBrowserFailure || (
    Object.keys(browserFailure).length === 2
    && typeof browserFailure.method === "string"
    && SAFE_TRANSIENT_BROWSER_METHODS.has(browserFailure.method)
    && ["timeout", "connection_closed"].includes(String(browserFailure.category))
  );
  const safeBlockingFailure = !hasBlockingFailure || (
    Object.keys(blockingFailure).length === 3
    && ["Fetch.failRequest", "Fetch.continueRequest"].includes(String(blockingFailure.method))
    && ["timeout", "connection_closed"].includes(String(blockingFailure.category))
    && blockingFailure.cdpCode === null
  );
  return (hasBrowserFailure || hasBlockingFailure) && safeBrowserFailure && safeBlockingFailure;
}

function hasAuthenticationStop(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (Array.isArray(value)) return value.some((item) => hasAuthenticationStop(item, depth + 1));
  const record = jsonRecord(value);
  if (["block_reason", "stop_reason", "reason"].some((key) => record[key] === "authentication_required")) return true;
  if (["stops", "gaps"].some((key) => hasAuthenticationStop(record[key], depth + 1))) return true;
  return Object.values(jsonRecord(record.tracks)).some((track) => hasAuthenticationStop(track, depth + 1));
}

function linkedinBrowserFailureResult(task: typeof agentTasks.$inferSelect, checkpoint: AgentTaskCheckpoint) {
  if (task.kind !== "search" || !Array.isArray(task.payload.sources) || !task.payload.sources.includes("linkedin")) return null;
  const collection = jsonRecord(checkpoint.linkedin_collection);
  const result = jsonRecord(checkpoint.linkedin_collection_result);
  const stops = Array.isArray(collection.stops) ? collection.stops.map(jsonRecord) : [];
  if (collection.attempt !== task.attemptCount || collection.collected !== false
    || result.gap_recorded !== true || result.block_reason !== "browser_unavailable"
    || result.provider_blocked !== true
    || !stops.some((stop) => stop.reason === "browser_unavailable")
    || hasAuthenticationStop(collection) || hasAuthenticationStop(result)) return null;
  return result;
}

function recoveryCount(checkpoint: AgentTaskCheckpoint) {
  const recovery = jsonRecord(jsonRecord(checkpoint._server).linkedinFailureRecovery);
  if (Object.keys(recovery).length === 0) return 0;
  return recovery.schemaVersion === 1
    && Number.isSafeInteger(recovery.consecutiveNoProgress)
    && Number(recovery.consecutiveNoProgress) >= 0
    ? Number(recovery.consecutiveNoProgress) : null;
}

async function serverVerifiedLinkedinProgress(taskId: string, startedAt: Date, tx: AgentTaskTransaction) {
  const [[pages], [details]] = await Promise.all([
    tx.select({ count: sql<number>`count(distinct ${linkedinSearchPages.id})::int` })
      .from(linkedinSearchPages)
      .innerJoin(linkedinSearchRuns, eq(linkedinSearchPages.runId, linkedinSearchRuns.id))
      .where(and(eq(linkedinSearchRuns.taskId, taskId), gt(linkedinSearchPages.createdAt, startedAt))),
    tx.select({ count: sql<number>`count(distinct ${linkedinSearchDetails.linkedinJobId})::int` })
      .from(linkedinSearchDetails)
      .innerJoin(linkedinSearchRuns, eq(linkedinSearchDetails.runId, linkedinSearchRuns.id))
      .where(and(eq(linkedinSearchRuns.taskId, taskId), eq(linkedinSearchDetails.status, "completed"),
        gt(linkedinSearchDetails.completedAt, startedAt))),
  ]);
  return { pages: pages?.count ?? 0, details: details?.count ?? 0 };
}

async function linkedinFailureRecovery(
  current: typeof agentTasks.$inferSelect,
  checkpoint: AgentTaskCheckpoint,
  now: Date,
  tx: AgentTaskTransaction,
) {
  const result = linkedinBrowserFailureResult(current, checkpoint);
  if (!result || !safeTransientBrowserFailure(result) || !current.startedAt) return null;
  const previousConsecutiveNoProgress = recoveryCount(checkpoint);
  if (previousConsecutiveNoProgress === null) return null;
  const policy = await lockEffectiveSearchPolicy(tx);
  const runs = await tx.select({
    policyHash: linkedinSearchRuns.policyHash,
    track: linkedinSearchRuns.track,
    mode: linkedinSearchRuns.mode,
  }).from(linkedinSearchRuns).where(eq(linkedinSearchRuns.taskId, current.id)).for("update");
  if (!runs.length || runs.some((run) => run.policyHash !== policy.policyHash
    || (run.track === "backfill" ? run.mode !== "bootstrap_30d" : run.mode !== "daily_1d"))) return null;
  const activePhase = runs.some((run) => run.track === "fresh") ? "daily_1d" : "bootstrap_30d";
  const activeTrack = activePhase === "daily_1d" ? "fresh" : "backfill";
  const collection = jsonRecord(checkpoint.linkedin_collection);
  const stops = Array.isArray(collection.stops) ? collection.stops.map(jsonRecord) : [];
  if (result.active_phase !== activePhase || collection.activePhase !== activePhase
    || !stops.some((stop) => stop.track === activeTrack && stop.reason === "browser_unavailable")) return null;
  const oldLedger = jsonRecord(checkpoint._server).linkedinBrowserAttempts;
  const oldSessionCount = Array.isArray(oldLedger) ? oldLedger.length : 0;
  let retained: ReturnType<typeof retainLinkedinBrowserAttempts>;
  try {
    retained = retainLinkedinBrowserAttempts({ ...current, checkpoint, result: null }, { enforceBudget: false });
  } catch {
    return null;
  }
  const newLedger = jsonRecord(retained.checkpoint._server).linkedinBrowserAttempts;
  const usage = jsonRecord(result.browser_usage);
  if (!Array.isArray(newLedger) || newLedger.length !== oldSessionCount + 1) return null;
  const newest = jsonRecord(newLedger.at(-1));
  const newestUsage = jsonRecord(newest.browser_usage);
  if (newest.attempt !== current.attemptCount || newestUsage.id !== usage.id) return null;
  const progress = await serverVerifiedLinkedinProgress(current.id, current.startedAt, tx);
  const decision = linkedinFailureContinuation({
    attemptCount: current.attemptCount,
    maxAttempts: current.maxAttempts,
    previousConsecutiveNoProgress,
    newPageReceipts: progress.pages,
    newCompletedDetails: progress.details,
    totalSessions: newLedger.length,
  });
  const server = jsonRecord(retained.checkpoint._server);
  const budgetAvailable = linkedinBrowserBudgetAvailable(retained.payload, activePhase);
  return {
    ...decision,
    ...(budgetAvailable ? {} : {
      retry: false,
      extended: false,
      delaySeconds: 0,
      reason: "browser_budget" as const,
    }),
    payload: retained.payload,
    checkpoint: { ...retained.checkpoint, _server: { ...server, linkedinFailureRecovery: decision.state } },
    availableAt: new Date(now.getTime() + (budgetAvailable ? decision.delaySeconds : 0) * 1000),
  };
}

export async function failAgentTask(taskId: string, grant: AgentTaskGrant, error: string, options: { retryable?: boolean; availableAt?: Date; now?: Date; checkpoint?: AgentTaskCheckpoint } = {}, tx?: AgentTaskTransaction) {
  return inTransaction(tx, async (store) => {
    const now = options.now ?? new Date();
    const [current] = await store.select().from(agentTasks).where(activeGrantWhere(taskId, grant, now)).limit(1).for("update");
    if (!current) throw new Error("Task claim is invalid or expired");
    let retry = options.retryable !== false && current.attemptCount < current.maxAttempts;
    let checkpoint = mergeWorkerCheckpoint(current.checkpoint, options.checkpoint ?? {});
    let payload = current.payload;
    let maxAttempts = current.maxAttempts;
    let availableAt = options.availableAt ?? now;
    const browserFailure = linkedinBrowserFailureResult(current, checkpoint);
    if (browserFailure && options.retryable === true) {
      const recovery = await linkedinFailureRecovery(current, checkpoint, now, store);
      retry = recovery?.retry === true;
      if (recovery) {
        checkpoint = recovery.checkpoint;
        payload = recovery.payload;
        availableAt = options.availableAt && options.availableAt > recovery.availableAt
          ? options.availableAt : recovery.availableAt;
        if (recovery.extended) maxAttempts = Math.max(maxAttempts, current.attemptCount + 1);
      }
    }
    const [updated] = await store.update(agentTasks).set({
      status: retry ? "queued" : "failed",
      payload,
      checkpoint,
      maxAttempts,
      claimedBy: null,
      claimTokenHash: null,
      leaseExpiresAt: null,
      availableAt,
      lastError: error,
      completedAt: retry ? null : now,
      updatedAt: now,
    }).where(activeGrantWhere(taskId, grant, now)).returning();
    if (!updated) throw new Error("Task claim is invalid or expired");
    if (updated.requestId) await store.update(requests).set(retry
      ? { status: "open", errorMd: null, updatedAt: now }
      : { status: "failed", errorMd: error, updatedAt: now }
    ).where(eq(requests.id, updated.requestId));
    const recovery = jsonRecord(jsonRecord(checkpoint._server).linkedinFailureRecovery);
    await emitTaskEvent(store, updated.executor === "hermes" ? "assistant" : "system", retry ? "agent_task_retry_queued" : "agent_task_failed", {
      task_id: updated.id, kind: updated.kind, error, retry,
      ...(recovery.schemaVersion === 1 ? { linkedin_failure_recovery: {
        consecutive_no_progress: recovery.consecutiveNoProgress,
        total_sessions: recovery.totalSessions,
      } } : {}),
    }, retry ? `Queued ${updated.kind.replaceAll("_", " ")} task for another attempt.` : `${updated.kind.replaceAll("_", " ")} task failed.`);
    return publicTask(updated);
  });
}

export async function waitAgentTaskForUser(taskId: string, grant: AgentTaskGrant, checkpoint: AgentTaskCheckpoint, now = new Date(), tx?: AgentTaskTransaction) {
  return inTransaction(tx, async (store) => {
    const [current] = await store.select().from(agentTasks).where(activeGrantWhere(taskId, grant, now)).limit(1).for("update");
    if (!current) throw new Error("Task claim is invalid or expired");
    const mergedCheckpoint = mergeWorkerCheckpoint(current.checkpoint, checkpoint);
    const [updated] = await store.update(agentTasks).set({
      status: "waiting_for_user",
      checkpoint: mergedCheckpoint,
      claimedBy: null,
      claimTokenHash: null,
      leaseExpiresAt: null,
      updatedAt: now,
    }).where(activeGrantWhere(taskId, grant, now)).returning();
    if (!updated) throw new Error("Task claim is invalid or expired");
    if (updated.requestId) await store.update(requests).set({ status: "open", updatedAt: now }).where(eq(requests.id, updated.requestId));
    await emitTaskEvent(store, updated.executor === "hermes" ? "assistant" : "system", "agent_task_waiting_for_user", { task_id: updated.id, kind: updated.kind }, `${updated.kind.replaceAll("_", " ")} task needs input.`);
    return publicTask(updated);
  });
}

export async function cancelAgentTask(taskId: string, reason = "Cancelled", now = new Date(), tx?: AgentTaskTransaction) {
  return inTransaction(tx, async (store) => {
    const [updated] = await store.update(agentTasks).set({ status: "cancelled", claimedBy: null, claimTokenHash: null, leaseExpiresAt: null, lastError: reason, completedAt: now, updatedAt: now }).where(and(eq(agentTasks.id, taskId), inArray(agentTasks.status, [...ACTIVE_TASK_STATUSES]))).returning();
    if (!updated) throw new Error("Only an active task can be cancelled");
    if (updated.requestId) await store.update(requests).set({ status: "failed", errorMd: reason, updatedAt: now }).where(eq(requests.id, updated.requestId));
    await emitTaskEvent(store, "owner", "agent_task_cancelled", { task_id: updated.id, reason }, `Cancelled ${updated.kind.replaceAll("_", " ")} task.`);
    return publicTask(updated);
  });
}

export async function retryAgentTask(taskId: string, now = new Date(), tx?: AgentTaskTransaction) {
  return inTransaction(tx, async (store) => {
    const retryableStatuses = ["failed", "waiting_for_user", "cancelled"] as const;
    const [current] = await store.select().from(agentTasks).where(and(
      eq(agentTasks.id, taskId),
      inArray(agentTasks.status, [...retryableStatuses]),
    )).limit(1).for("update");
    if (!current) throw new Error("Only a failed, cancelled or waiting task can be retried");
    if (isSupersededAgentTaskCheckpoint(current.checkpoint, current.id)) {
      throw new Error("This task was superseded and cannot be retried; start a new search under the current settings");
    }
    const retainedBrowserUsage = retainLinkedinBrowserAttempts(current);
    const [updated] = await store.update(agentTasks).set({
      ...retainedBrowserUsage,
      status: "queued",
      maxAttempts: sql`${agentTasks.attemptCount} + 3`,
      claimedBy: null,
      claimTokenHash: null,
      leaseExpiresAt: null,
      availableAt: now,
      lastError: null,
      completedAt: null,
      updatedAt: now,
    }).where(and(
      eq(agentTasks.id, current.id),
      eq(agentTasks.status, current.status),
      eq(agentTasks.attemptCount, current.attemptCount),
    )).returning();
    if (!updated) throw new Error("Task changed before it could be retried");
    if (updated.requestId) await store.update(requests).set({ status: "open", errorMd: null, updatedAt: now }).where(eq(requests.id, updated.requestId));
    await emitTaskEvent(store, "owner", "agent_task_retried", { task_id: updated.id }, `Retried ${updated.kind.replaceAll("_", " ")} task.`);
    return publicTask(updated);
  });
}

export async function runScheduledSearchTick(now = new Date(), tx?: AgentTaskTransaction): Promise<{
  due: boolean;
  created: boolean;
  coalesced: boolean;
  occurrenceKey?: string;
  task?: AgentTaskRecord;
}> {
  return inTransaction(tx, async (store) => {
    const [[settingsRow], [preference]] = await Promise.all([
      store.select().from(searchSettings).where(eq(searchSettings.id, WORKSPACE_ID)).limit(1),
      store.select({ timeZone: notificationPreferences.timeZone }).from(notificationPreferences).where(eq(notificationPreferences.id, WORKSPACE_ID)).limit(1),
    ]);
    const settings = settingsFromRow(settingsRow);
    const timeZone = preference?.timeZone && isValidTimeZone(preference.timeZone) ? preference.timeZone : DEFAULT_TIME_ZONE;
    const occurrence = getDueScheduleOccurrence(settings.schedule, timeZone, now);
    if (!occurrence) return { due: false, created: false, coalesced: false };

    await store.execute(sql`select pg_advisory_xact_lock(hashtext(${occurrence.occurrenceKey}))`);
    const [consumed] = await store.select().from(agentScheduleOccurrences).where(eq(agentScheduleOccurrences.occurrenceKey, occurrence.occurrenceKey)).limit(1);
    if (consumed) {
      const [task] = await store.select().from(agentTasks).where(eq(agentTasks.id, consumed.taskId)).limit(1);
      return { due: true, created: false, coalesced: false, occurrenceKey: occurrence.occurrenceKey, task: task ? publicTask(task) : undefined };
    }

    const queued = await enqueueSearchTask({
      purpose: "scheduled_search",
      scheduledFor: now,
      dedupeKey: occurrence.occurrenceKey,
      payload: { scheduleOccurrence: occurrence },
    }, store);
    await store.insert(agentScheduleOccurrences).values({ occurrenceKey: occurrence.occurrenceKey, localDate: occurrence.localDate, taskId: queued.task.id });
    await emitTaskEvent(store, "system", "scheduled_search_occurrence", { occurrence_key: occurrence.occurrenceKey, task_id: queued.task.id, coalesced: queued.coalesced, scheduled_local_time: occurrence.scheduledLocalTime }, queued.coalesced ? "The scheduled search joined an active search." : "Recorded today’s scheduled search.");
    return { due: true, created: queued.created, coalesced: queued.coalesced, occurrenceKey: occurrence.occurrenceKey, task: queued.task };
  });
}
