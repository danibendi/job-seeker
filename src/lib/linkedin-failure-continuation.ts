export const LINKEDIN_FAILURE_MAX_CONSECUTIVE_NO_PROGRESS = 2;
export const LINKEDIN_FAILURE_MAX_SESSIONS = 20;

export type LinkedinFailureRecoveryState = {
  schemaVersion: 1;
  consecutiveNoProgress: number;
  totalSessions: number;
  lastAttempt: number;
  newPageReceipts: number;
  newCompletedDetails: number;
};

export function linkedinFailureContinuation(input: {
  attemptCount: number;
  maxAttempts: number;
  previousConsecutiveNoProgress: number;
  newPageReceipts: number;
  newCompletedDetails: number;
  totalSessions: number;
}) {
  const progressed = input.newPageReceipts > 0 || input.newCompletedDetails > 0;
  const consecutiveNoProgress = progressed ? 0 : input.previousConsecutiveNoProgress + 1;
  const state: LinkedinFailureRecoveryState = {
    schemaVersion: 1,
    consecutiveNoProgress,
    totalSessions: input.totalSessions,
    lastAttempt: input.attemptCount,
    newPageReceipts: input.newPageReceipts,
    newCompletedDetails: input.newCompletedDetails,
  };
  if (input.totalSessions >= LINKEDIN_FAILURE_MAX_SESSIONS) {
    return { retry: false, extended: false, delaySeconds: 0, reason: "session_limit" as const, state };
  }
  if (consecutiveNoProgress > LINKEDIN_FAILURE_MAX_CONSECUTIVE_NO_PROGRESS) {
    return { retry: false, extended: false, delaySeconds: 0, reason: "no_progress_limit" as const, state };
  }
  return {
    retry: true,
    extended: input.attemptCount >= input.maxAttempts,
    delaySeconds: progressed ? 0 : consecutiveNoProgress === 1 ? 60 : 300,
    reason: progressed ? "durable_progress" as const : "transient_no_progress" as const,
    state,
  };
}
