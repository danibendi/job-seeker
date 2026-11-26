import type { AgentTaskExecutor, AgentTaskKind, AgentWorkerExecutor } from "./agent-task-contract";
import { formatShortDate, formatTime } from "./format";
import type { SearchSchedule, Weekday } from "./settings";
import { DEFAULT_TIME_ZONE, isValidTimeZone, zonedDateParts } from "./time";

export const WORKER_OFFLINE_MS = 15 * 60 * 1000;
export const SCHEDULE_MISSED_MS = 60 * 60 * 1000;
export const WORKER_CONTACT_THROTTLE_MS = 60 * 1000;

export type AssistantState = "ready" | "working" | "offline" | "paused" | "missed" | "none";
export type AssistantTone = "good" | "brand" | "bad" | "warn" | "neutral";

export type AssistantStatus = {
  state: AssistantState;
  tone: AssistantTone;
  title: string;
  meta: string;
  assistantLabel: string;
  waitReason: string | null;
  tailoringWaitLabel: string;
};

export type ScheduledOccurrenceInfo = {
  localDate: string;
  occurrenceKey: string;
  dueAt: Date;
  weekday: string;
  time: string;
};

export type RegisteredWorkerRef = {
  id: string;
  executor: AgentWorkerExecutor;
};

export type WorkerContactRef = {
  workerId: string;
  executor: AgentTaskExecutor;
  lastSeenAt: Date;
};

export type WorkerPauseRef = {
  workerId: string;
  executor: AgentTaskExecutor;
  reason: string;
  pausedAt: Date;
};

export type RunningTaskRef = {
  id: string;
  kind: AgentTaskKind;
  executor: AgentTaskExecutor;
  status: string;
  requestId: string | null;
  claimedBy: string | null;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
};

export type AssistantStatusInput = {
  assistantLabel: string;
  timeZone: string;
  now?: Date;
  chosenExecutors: readonly AgentTaskExecutor[];
  registeredWorkers: readonly RegisteredWorkerRef[];
  workerContacts: readonly WorkerContactRef[];
  workerPauses: readonly WorkerPauseRef[];
  runningTasks: readonly RunningTaskRef[];
  waitingRequests: number;
  lastSuccessfulSearchAt: Date | null;
  schedule: SearchSchedule;
  hasElapsedScheduleOccurrence: boolean;
};

const WEEKDAY_MAP: Record<string, Weekday> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

const WORKING_KIND_PRIORITY: Record<AgentTaskKind, number> = {
  search: 0,
  question: 1,
  linkedin_evaluate: 2,
};

/** True when a running task's worker lease has already expired without renewal. */
export function isInterruptedTask(task: { status: string; leaseExpiresAt: Date | null }, now = new Date()) {
  return task.status === "running" && task.leaseExpiresAt !== null && task.leaseExpiresAt.getTime() <= now.getTime();
}

/**
 * Returns request IDs whose status is still `in_progress` only because their
 * running task's worker lease expired before recovery on the next claim.
 */
export function interruptedRequestIdsFor(
  requests: ReadonlyArray<{ id: string; status: string }>,
  tasks: ReadonlyArray<{ requestId: string | null; status: string; leaseExpiresAt: Date | null }>,
  now = new Date(),
) {
  const activeRunRequests = new Set<string>();
  const interruptedRequests = new Set<string>();
  for (const task of tasks) {
    if (!task.requestId || task.status !== "running") continue;
    if (isInterruptedTask(task, now)) interruptedRequests.add(task.requestId);
    else activeRunRequests.add(task.requestId);
  }
  const result: string[] = [];
  for (const request of requests) {
    if (request.status === "in_progress" && interruptedRequests.has(request.id) && !activeRunRequests.has(request.id)) {
      result.push(request.id);
    }
  }
  return result;
}

function safeTimeZone(timeZone: string) {
  return isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
}

function shiftIsoDate(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calendarDayDiff(fromIsoDate: string, toIsoDate: string) {
  const from = Date.parse(`${fromIsoDate}T12:00:00Z`);
  const to = Date.parse(`${toIsoDate}T12:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

function scheduleAppliesOnWeekday(schedule: SearchSchedule, weekday: Weekday) {
  return schedule.frequency === "daily"
    || (schedule.frequency === "weekdays" && !["sat", "sun"].includes(weekday))
    || ((schedule.frequency === "weekly" || schedule.frequency === "custom") && schedule.days.includes(weekday));
}

function zonedLocalMinutes(date: Date, timeZone: string) {
  const parts = zonedDateParts(date, timeZone);
  return { ...parts, minutes: parts.hour * 60 + parts.minute };
}

/**
 * Resolves a local calendar date + HH:MM wall time in `timeZone` to a UTC Date.
 * On DST folds, chooses the earlier instant (matching when the schedule first becomes due).
 * On DST spring-forward gaps, returns the first real instant at or after the skipped wall time.
 */
export function resolveScheduledInstant(localDate: string, time: string, timeZone: string) {
  const tz = safeTimeZone(timeZone);
  const [year, month, day] = localDate.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute);
  const targetMinutes = hour * 60 + minute;

  let instant = desiredUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedDateParts(new Date(instant), tz);
    const [ay, am, ad] = actual.date.split("-").map(Number);
    const representedUtc = Date.UTC(ay, am - 1, ad, actual.hour, actual.minute);
    const next = instant + (desiredUtc - representedUtc);
    if (next === instant) break;
    instant = next;
  }

  const resolved = new Date(instant);
  const resolvedParts = zonedLocalMinutes(resolved, tz);
  if (resolvedParts.date === localDate && resolvedParts.minutes === targetMinutes) {
    // Handle DST autumn fold: prefer the earlier matching occurrence.
    const earlier = new Date(instant - 3_600_000);
    const earlierParts = zonedLocalMinutes(earlier, tz);
    if (earlierParts.date === localDate && earlierParts.minutes === targetMinutes) return earlier;
    return resolved;
  }

  // Handle DST spring-forward gap: find the first instant on localDate whose local time >= target.
  const probe = instant - 3_600_000;
  for (let step = 0; step < 240; step += 1) {
    const candidate = new Date(probe + step * 60_000);
    const parts = zonedLocalMinutes(candidate, tz);
    if (parts.date > localDate || (parts.date === localDate && parts.minutes >= targetMinutes)) {
      return candidate;
    }
  }
  return resolved;
}

/**
 * Returns the most recent scheduled search whose grace window (default 1 hour)
 * has already elapsed by `now`. Checking against `now - graceMs` avoids hiding
 * an older missed search during the grace hour of the next day's schedule.
 */
export function getMostRecentElapsedDueOccurrence(
  schedule: SearchSchedule,
  timeZone: string,
  now = new Date(),
  graceMs = SCHEDULE_MISSED_MS,
): ScheduledOccurrenceInfo | null {
  if (!schedule.enabled) return null;
  if ((schedule.frequency === "weekly" || schedule.frequency === "custom") && !schedule.days.length) return null;
  const tz = safeTimeZone(timeZone);
  const cutoff = new Date(now.getTime() - graceMs);
  const cutoffLocalDate = zonedDateParts(cutoff, tz).date;

  for (let offset = 0; offset <= 8; offset += 1) {
    const localDate = shiftIsoDate(cutoffLocalDate, -offset);
    const dueAt = resolveScheduledInstant(localDate, schedule.time, tz);
    const parts = zonedDateParts(dueAt, tz);
    const weekdayId = WEEKDAY_MAP[parts.weekday];
    if (!weekdayId || !scheduleAppliesOnWeekday(schedule, weekdayId)) continue;
    if (dueAt.getTime() <= cutoff.getTime()) {
      return {
        localDate,
        occurrenceKey: `owner:scheduled-search:${localDate}`,
        dueAt,
        weekday: parts.weekday,
        time: schedule.time,
      };
    }
  }
  return null;
}

/** Returns the next scheduled search strictly after `now`. */
export function getNextScheduledSearch(
  schedule: SearchSchedule,
  timeZone: string,
  now = new Date(),
): ScheduledOccurrenceInfo | null {
  if (!schedule.enabled) return null;
  if ((schedule.frequency === "weekly" || schedule.frequency === "custom") && !schedule.days.length) return null;
  const tz = safeTimeZone(timeZone);
  const todayLocalDate = zonedDateParts(now, tz).date;

  for (let offset = 0; offset <= 8; offset += 1) {
    const localDate = shiftIsoDate(todayLocalDate, offset);
    const dueAt = resolveScheduledInstant(localDate, schedule.time, tz);
    const parts = zonedDateParts(dueAt, tz);
    const weekdayId = WEEKDAY_MAP[parts.weekday];
    if (!weekdayId || !scheduleAppliesOnWeekday(schedule, weekdayId)) continue;
    if (dueAt.getTime() > now.getTime()) {
      return {
        localDate,
        occurrenceKey: `owner:scheduled-search:${localDate}`,
        dueAt,
        weekday: parts.weekday,
        time: schedule.time,
      };
    }
  }
  return null;
}

export function formatRelativePastTime(date: Date, now: Date, timeZone: string) {
  const tz = safeTimeZone(timeZone);
  const target = zonedDateParts(date, tz);
  const today = zonedDateParts(now, tz);
  const diff = calendarDayDiff(target.date, today.date);
  const time = formatTime(date, tz);
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `yesterday ${time}`;
  if (diff > 1 && diff <= 6) return `${target.weekday} ${time}`;
  return `${formatShortDate(date, tz)} ${time}`;
}

export function formatRelativeStartTime(date: Date, now: Date, timeZone: string) {
  const tz = safeTimeZone(timeZone);
  const target = zonedDateParts(date, tz);
  const today = zonedDateParts(now, tz);
  const diff = calendarDayDiff(target.date, today.date);
  const time = formatTime(date, tz);
  if (diff === 0) return time;
  if (diff === 1) return `yesterday ${time}`;
  if (diff > 1 && diff <= 6) return `${target.weekday} ${time}`;
  return `${formatShortDate(date, tz)} ${time}`;
}

export function formatRelativeNextSchedule(next: ScheduledOccurrenceInfo, now: Date, timeZone: string) {
  const tz = safeTimeZone(timeZone);
  const today = zonedDateParts(now, tz).date;
  const diff = calendarDayDiff(today, next.localDate);
  if (diff === 0) return `today ${next.time}`;
  if (diff > 0 && diff <= 6) return `${next.weekday} ${next.time}`;
  return `${formatShortDate(next.dueAt, tz)} ${next.time}`;
}

function waitingRequestsPhrase(count: number, more = false) {
  const noun = count === 1 ? "request" : "requests";
  return more ? `${count} more ${noun} waiting` : `${count} ${noun} waiting`;
}

function pauseShortReason(reason: string) {
  if (reason === "usage_limit") return "Usage limit reached";
  if (reason === "login_required") return "Sign-in required";
  return "Needs attention";
}

function workingHeadline(label: string, kind: AgentTaskKind) {
  if (kind === "search") return `${label} is searching for roles`;
  if (kind === "linkedin_evaluate") return `${label} is scoring a role`;
  return `${label} is answering a question`;
}

export function roleQuestionStatusLabel(
  request: { id: string; status: string; errorMd: string | null },
  assistantStatus: AssistantStatus,
  interruptedRequestIds: ReadonlySet<string>,
) {
  if (request.status === "failed") return `Failed · ${request.errorMd ?? "no details"}`;
  if (request.status === "dismissed") return "Dismissed";
  if (request.status === "in_progress" && !interruptedRequestIds.has(request.id)) {
    return `${assistantStatus.assistantLabel} is working on it`;
  }
  return assistantStatus.waitReason ? `Waiting · ${assistantStatus.waitReason}` : "Waiting";
}

export function computeAssistantStatus(input: AssistantStatusInput): AssistantStatus {
  const now = input.now ?? new Date();
  const tz = safeTimeZone(input.timeZone);
  const label = input.assistantLabel.trim() || "Assistant";
  const waiting = Math.max(0, input.waitingRequests);

  const chosen = new Set<AgentWorkerExecutor>(
    input.chosenExecutors.filter((executor): executor is AgentWorkerExecutor => executor !== "unassigned"),
  );
  const coveredWorkers = input.registeredWorkers.filter((worker) => chosen.has(worker.executor));

  if (!coveredWorkers.length) {
    const meta = waiting > 0
      ? waitingRequestsPhrase(waiting)
      : input.lastSuccessfulSearchAt
        ? `Last search ${formatRelativePastTime(input.lastSuccessfulSearchAt, now, tz)}`
        : "";
    return {
      state: "none",
      tone: "neutral",
      title: "No assistant connected",
      meta,
      assistantLabel: label,
      waitReason: "no assistant connected",
      tailoringWaitLabel: "CV tailoring waiting · no assistant",
    };
  }

  const contactByWorker = new Map(input.workerContacts.map((contact) => [contact.workerId, contact.lastSeenAt]));
  const pauseByWorker = new Map(input.workerPauses.map((pause) => [pause.workerId, pause]));

  const offlineWorkers = coveredWorkers
    .map((worker) => ({ worker, lastSeenAt: contactByWorker.get(worker.id) ?? null }))
    .filter(({ lastSeenAt }) => lastSeenAt === null || now.getTime() - lastSeenAt.getTime() >= WORKER_OFFLINE_MS);

  if (offlineWorkers.length > 0) {
    offlineWorkers.sort((left, right) => {
      if (left.lastSeenAt === null && right.lastSeenAt === null) return 0;
      if (left.lastSeenAt === null) return -1;
      if (right.lastSeenAt === null) return 1;
      return left.lastSeenAt.getTime() - right.lastSeenAt.getTime();
    });
    const leastHealthyLastSeen = offlineWorkers[0].lastSeenAt;
    const seenPart = leastHealthyLastSeen
      ? `Last seen ${formatRelativePastTime(leastHealthyLastSeen, now, tz)}`
      : "Not seen yet";
    const meta = waiting > 0 ? `${seenPart} · ${waitingRequestsPhrase(waiting)}` : seenPart;
    return {
      state: "offline",
      tone: "bad",
      title: `${label} is offline`,
      meta,
      assistantLabel: label,
      waitReason: `${label} is offline`,
      tailoringWaitLabel: `CV tailoring waiting · ${label} is offline`,
    };
  }

  const pausedWorkers = coveredWorkers
    .map((worker) => pauseByWorker.get(worker.id))
    .filter((pause): pause is WorkerPauseRef => Boolean(pause))
    .sort((left, right) => left.pausedAt.getTime() - right.pausedAt.getTime());

  if (pausedWorkers.length > 0) {
    const primaryPause = pausedWorkers[0];
    const reason = pauseShortReason(primaryPause.reason);
    const meta = waiting > 0
      ? `${reason} · ${waitingRequestsPhrase(waiting)}`
      : `${reason} ${formatRelativeStartTime(primaryPause.pausedAt, now, tz)}`;
    return {
      state: "paused",
      tone: "warn",
      title: `${label} is paused`,
      meta,
      assistantLabel: label,
      waitReason: `${label} is paused`,
      tailoringWaitLabel: `CV tailoring waiting · ${label} is paused`,
    };
  }

  const coveredIds = new Set(coveredWorkers.map((worker) => worker.id));
  const activeRunning = input.runningTasks
    .filter((task) => task.status === "running" && !isInterruptedTask(task, now))
    .filter((task) => (task.claimedBy ? coveredIds.has(task.claimedBy) : chosen.has(task.executor as AgentWorkerExecutor)))
    .sort((left, right) => {
      const kindDelta = WORKING_KIND_PRIORITY[left.kind] - WORKING_KIND_PRIORITY[right.kind];
      if (kindDelta !== 0) return kindDelta;
      const leftStart = (left.startedAt ?? left.updatedAt ?? left.createdAt).getTime();
      const rightStart = (right.startedAt ?? right.updatedAt ?? right.createdAt).getTime();
      return leftStart - rightStart;
    });

  if (activeRunning.length > 0) {
    const current = activeRunning[0];
    const startedAt = current.startedAt ?? current.updatedAt ?? current.createdAt;
    const activeRequestIds = new Set(activeRunning.map((task) => task.requestId).filter((id): id is string => Boolean(id)));
    const moreWaiting = Math.max(0, waiting - activeRequestIds.size);
    const startedPart = `Started ${formatRelativeStartTime(startedAt, now, tz)}`;
    const meta = moreWaiting > 0 ? `${startedPart} · ${waitingRequestsPhrase(moreWaiting, true)}` : startedPart;
    return {
      state: "working",
      tone: "brand",
      title: workingHeadline(label, current.kind),
      meta,
      assistantLabel: label,
      waitReason: null,
      tailoringWaitLabel: "CV tailoring waiting",
    };
  }

  const elapsedDue = getMostRecentElapsedDueOccurrence(input.schedule, tz, now);
  const searchRanSinceDue = elapsedDue !== null
    && input.lastSuccessfulSearchAt !== null
    && input.lastSuccessfulSearchAt.getTime() >= elapsedDue.dueAt.getTime();
  if (elapsedDue && !input.hasElapsedScheduleOccurrence && !searchRanSinceDue) {
    const todayLocalDate = zonedDateParts(now, tz).date;
    const when = elapsedDue.localDate === todayLocalDate
      ? elapsedDue.time
      : `${elapsedDue.weekday} ${elapsedDue.time}`;
    const meta = input.lastSuccessfulSearchAt
      ? `Last search ${formatRelativePastTime(input.lastSuccessfulSearchAt, now, tz)}`
      : "No completed search yet";
    return {
      state: "missed",
      tone: "warn",
      title: `${when} search didn’t start`,
      meta,
      assistantLabel: label,
      waitReason: null,
      tailoringWaitLabel: "CV tailoring waiting",
    };
  }

  const lastPart = input.lastSuccessfulSearchAt
    ? `Last search ${formatRelativePastTime(input.lastSuccessfulSearchAt, now, tz)}`
    : "No searches yet";
  const next = getNextScheduledSearch(input.schedule, tz, now);
  const nextPart = next ? `Next ${formatRelativeNextSchedule(next, now, tz)}` : "Schedule paused";
  return {
    state: "ready",
    tone: "good",
    title: `${label} is ready`,
    meta: `${lastPart} · ${nextPart}`,
    assistantLabel: label,
    waitReason: null,
    tailoringWaitLabel: "CV tailoring waiting",
  };
}
