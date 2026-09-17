import type { JobStatus } from "@/db/schema";

export const JOB_STATUSES = [
  "sourced", "to_apply", "applied", "screening", "interviewing", "offer",
  "rejected", "withdrawn", "irrelevant", "archived",
] as const satisfies readonly JobStatus[];

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  sourced: "Sourced",
  to_apply: "Shortlisted",
  applied: "Applied",
  screening: "Recruiter screening",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  irrelevant: "Passed",
  archived: "Archived",
};

const ALLOWED_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  sourced: ["to_apply", "irrelevant", "archived"],
  to_apply: ["sourced", "applied", "irrelevant", "withdrawn", "archived"],
  applied: ["to_apply", "screening", "interviewing", "offer", "rejected", "withdrawn", "archived"],
  screening: ["applied", "interviewing", "offer", "rejected", "withdrawn", "archived"],
  interviewing: ["screening", "offer", "rejected", "withdrawn", "archived"],
  offer: ["interviewing", "rejected", "withdrawn", "archived"],
  rejected: ["archived"],
  withdrawn: ["archived"],
  irrelevant: ["sourced", "archived"],
  archived: [],
};

const QUICK_ADVANCE: Partial<Record<JobStatus, JobStatus>> = {
  sourced: "to_apply",
  to_apply: "applied",
  applied: "screening",
  screening: "interviewing",
  interviewing: "offer",
};

export function canTransitionJob(from: JobStatus, to: JobStatus) {
  return from !== to && ALLOWED_TRANSITIONS[from].includes(to);
}

export function availableJobTransitions(from: JobStatus) {
  return ALLOWED_TRANSITIONS[from];
}

export function quickAdvanceStatus(from: JobStatus) {
  return QUICK_ADVANCE[from] ?? null;
}

/** A place a job can be moved to. `sourced` means "back to review"; `later` is sourced but already looked at. */
export type JobDestination = JobStatus | "later";

export const JOB_DESTINATION_LABELS: Record<JobDestination, string> = { ...JOB_STATUS_LABELS, sourced: "To review", later: "Saved for later" };

export function isJobDestination(value: string): value is JobDestination {
  return value === "later" || (JOB_STATUSES as readonly string[]).includes(value);
}

export function resolveJobDestination(to: JobDestination): { status: JobStatus; triaged: boolean | null } {
  if (to === "later") return { status: "sourced", triaged: true };
  if (to === "sourced") return { status: "sourced", triaged: false };
  return { status: to, triaged: null };
}

/** Everywhere a job can go from its current state, including flipping between review and saved-for-later. */
export function jobDestinations(from: JobStatus, triaged: boolean): JobDestination[] {
  const out: JobDestination[] = [];
  if (from === "sourced") out.push(triaged ? "sourced" : "later");
  for (const status of ALLOWED_TRANSITIONS[from]) {
    out.push(status);
    if (status === "sourced") out.push("later");
  }
  return out;
}

export function canReachDestination(from: JobStatus, triaged: boolean, to: JobDestination) {
  return jobDestinations(from, triaged).includes(to);
}
