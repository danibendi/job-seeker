import type { InterviewOutcome, InterviewStage, JobStatus } from "@/db/schema";

export const DEFAULT_INTERVIEW_TIME_ZONE = "UTC";

export const INTERVIEW_STAGES = [
  "recruiter_screen", "hiring_manager", "technical", "panel", "onsite", "final", "offer_discussion",
] as const satisfies readonly InterviewStage[];
export const INTERVIEW_OUTCOMES = ["pending", "passed", "failed", "cancelled"] as const satisfies readonly InterviewOutcome[];

export const INTERVIEW_TIME_ZONE_OPTIONS = ["UTC"] as const;

const ACTIVE_STATUS_RANK: Partial<Record<JobStatus, number>> = {
  sourced: 0,
  to_apply: 1,
  applied: 2,
  screening: 3,
  interviewing: 4,
  offer: 5,
};

export function targetStatusForInterviewStage(stage: InterviewStage): JobStatus {
  if (stage === "recruiter_screen") return "screening";
  if (stage === "offer_discussion") return "offer";
  return "interviewing";
}

export function synchronizedJobStatus(
  current: JobStatus,
  stage: InterviewStage,
  outcome: InterviewOutcome = "pending",
): JobStatus {
  if (outcome === "cancelled" || outcome === "failed") return current;
  const target = targetStatusForInterviewStage(stage);
  const currentRank = ACTIVE_STATUS_RANK[current];
  const targetRank = ACTIVE_STATUS_RANK[target];
  if (currentRank == null || targetRank == null || currentRank >= targetRank) return current;
  return target;
}

export function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function zonedParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

export function parseZonedDateTime(localValue: string, timeZone: string) {
  if (!isValidTimeZone(timeZone)) throw new Error("Invalid interview timezone");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localValue);
  if (!match) throw new Error("Invalid interview date");
  const desired: LocalParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  const desiredUtc = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute);
  const validDate = new Date(desiredUtc);
  if (
    validDate.getUTCFullYear() !== desired.year
    || validDate.getUTCMonth() + 1 !== desired.month
    || validDate.getUTCDate() !== desired.day
    || desired.hour > 23
    || desired.minute > 59
  ) throw new Error("Invalid interview date");

  let instant = desiredUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(instant), timeZone);
    const representedUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const next = instant + (desiredUtc - representedUtc);
    if (next === instant) break;
    instant = next;
  }
  const resolved = new Date(instant);
  if (JSON.stringify(zonedParts(resolved, timeZone)) !== JSON.stringify(desired)) {
    throw new Error("That local time does not exist in the selected timezone");
  }
  return resolved;
}
