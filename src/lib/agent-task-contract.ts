import { createHash } from "node:crypto";
import type { SearchSchedule } from "./settings";

export const AGENT_TASK_KINDS = ["search", "question", "linkedin_evaluate"] as const;
export const AGENT_TASK_EXECUTORS = ["hermes", "codex", "api", "unassigned"] as const;
export const AGENT_TASK_STATUSES = ["queued", "running", "waiting_for_user", "succeeded", "failed", "cancelled"] as const;

export type AgentTaskKind = (typeof AGENT_TASK_KINDS)[number];
export type AgentTaskExecutor = (typeof AGENT_TASK_EXECUTORS)[number];
export type AgentWorkerExecutor = Exclude<AgentTaskExecutor, "unassigned">;
export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

export type AgentTaskPayload = Record<string, unknown>;
export type AgentTaskCheckpoint = Record<string, unknown>;
export type AgentTaskResult = Record<string, unknown>;

export type SearchExecutionSnapshot = {
  candidateId: string;
  purpose: "search_now" | "scheduled_search";
  scopeKey: string;
  searchSettings: Record<string, unknown>;
  sources: string[];
  budgets: {
    maxPages: number;
    maxDetailFetches: number;
    maxDurationSeconds: number;
  };
  execution: {
    executor: AgentTaskExecutor;
    sources: string[];
    maxPages: number;
    maxDetailFetches: number;
    maxDurationSeconds: number;
  };
};

export type AgentTaskGrant = { workerId: string; claimToken: string };

export type ExpiredTaskDisposition = "requeue" | "fail";

/** attemptCount is incremented when a lease is granted. */
export function classifyExpiredTask(attemptCount: number, maxAttempts: number): ExpiredTaskDisposition {
  return attemptCount < maxAttempts ? "requeue" : "fail";
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function stableJsonHash(value: unknown) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function resultsMatch(left: unknown, right: unknown) {
  return stableJsonHash(left) === stableJsonHash(right);
}

/** True only for a complete maintenance receipt that intentionally superseded this task. */
export function isSupersededAgentTaskCheckpoint(checkpoint: unknown, taskId: string) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return false;
  const recoveries = (checkpoint as Record<string, unknown>).linkedinBrowserReceiptRecoveries;
  if (!Array.isArray(recoveries)) return false;
  return recoveries.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const recovery = value as Record<string, unknown>;
    const receipt = recovery.receipt;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
    const receiptRecord = receipt as Record<string, unknown>;
    return recovery.schemaVersion === 1
      && recovery.kind === "linkedin_browser_receipt_recovery"
      && recovery.action === "supersede"
      && typeof recovery.planHash === "string" && /^[a-f0-9]{64}$/.test(recovery.planHash)
      && typeof recovery.receiptHash === "string" && recovery.receiptHash === stableJsonHash(receipt)
      && typeof recovery.supersedeReason === "string" && recovery.supersedeReason.trim().length > 0
      && receiptRecord.taskId === taskId;
  });
}

export function mergeWorkerCheckpoint(current: AgentTaskCheckpoint, incoming: AgentTaskCheckpoint) {
  const { _server: _untrustedServerState, ...workerCheckpoint } = incoming;
  void _untrustedServerState;
  return {
    ...current,
    ...workerCheckpoint,
    ...(current._server === undefined ? {} : { _server: current._server }),
  };
}

export function isFreshTerminalLinkedInDecision(state: string, completedAt: Date | null, taskCreatedAt: Date) {
  return ["promoted", "rejected", "needs_review"].includes(state)
    && completedAt !== null
    && completedAt >= taskCreatedAt;
}

export function sha256OpaqueToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function searchScopeKey(searchSettings: unknown, sources: readonly string[]) {
  let scopeSettings = searchSettings;
  if (searchSettings && typeof searchSettings === "object" && !Array.isArray(searchSettings)) {
    const { schedule: _schedule, followUpDays: _followUpDays, ...searchCriteria } = searchSettings as Record<string, unknown>;
    void _schedule;
    void _followUpDays;
    scopeSettings = searchCriteria;
  }
  return `search:${stableJsonHash({ searchSettings: scopeSettings, sources: [...sources].sort() }).slice(0, 32)}`;
}

const WEEKDAY_IDS = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" } as const;

export type DueScheduleOccurrence = {
  localDate: string;
  occurrenceKey: string;
  scheduledLocalTime: string;
};

/**
 * Returns only today's due occurrence. A delayed tick never replays an older day.
 * On DST gaps, the first tick after the requested local wall time wins; on folds,
 * the date-keyed occurrence can still be consumed only once.
 */
export function getDueScheduleOccurrence(schedule: SearchSchedule, timeZone: string, now = new Date()): DueScheduleOccurrence | null {
  if (!schedule.enabled) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = WEEKDAY_IDS[value("weekday") as keyof typeof WEEKDAY_IDS];
  if (!weekday) return null;
  const applies = schedule.frequency === "daily"
    || (schedule.frequency === "weekdays" && !["sat", "sun"].includes(weekday))
    || ((schedule.frequency === "weekly" || schedule.frequency === "custom") && schedule.days.includes(weekday));
  if (!applies) return null;
  const [scheduledHour, scheduledMinute] = schedule.time.split(":").map(Number);
  const localMinutes = Number(value("hour")) * 60 + Number(value("minute"));
  if (localMinutes < scheduledHour * 60 + scheduledMinute) return null;
  const localDate = `${value("year")}-${value("month")}-${value("day")}`;
  return {
    localDate,
    occurrenceKey: `owner:scheduled-search:${localDate}`,
    scheduledLocalTime: `${localDate}T${schedule.time}[${timeZone}]`,
  };
}
