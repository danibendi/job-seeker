import { describe, expect, it } from "vitest";
import {
  LINKEDIN_FAILURE_MAX_SESSIONS,
  linkedinFailureContinuation,
} from "../src/lib/linkedin-failure-continuation";

const decision = (overrides: Partial<Parameters<typeof linkedinFailureContinuation>[0]> = {}) =>
  linkedinFailureContinuation({
    attemptCount: 1,
    maxAttempts: 3,
    previousConsecutiveNoProgress: 0,
    newPageReceipts: 0,
    newCompletedDetails: 0,
    totalSessions: 1,
    ...overrides,
  });

describe("LinkedIn transient failure continuation", () => {
  it("tracks every no-progress failure and stops before generic attempts can escape the limit", () => {
    const first = decision();
    expect(first).toMatchObject({ retry: true, extended: false, delaySeconds: 60,
      state: { consecutiveNoProgress: 1 } });
    const second = decision({ attemptCount: 2,
      previousConsecutiveNoProgress: first.state.consecutiveNoProgress });
    expect(second).toMatchObject({ retry: true, extended: false, delaySeconds: 300,
      state: { consecutiveNoProgress: 2 } });
    const third = decision({ attemptCount: 3,
      previousConsecutiveNoProgress: second.state.consecutiveNoProgress });
    expect(third).toMatchObject({ retry: false, extended: false, reason: "no_progress_limit",
      state: { consecutiveNoProgress: 3 } });
  });

  it("resets only for server-verified page or completed-detail progress", () => {
    for (const progress of [{ newPageReceipts: 1 }, { newCompletedDetails: 4 }]) {
      expect(decision({ attemptCount: 3, maxAttempts: 3, previousConsecutiveNoProgress: 2,
        ...progress })).toMatchObject({ retry: true, extended: true, delaySeconds: 0,
        reason: "durable_progress", state: { consecutiveNoProgress: 0 } });
    }
  });

  it("refuses to authorize a twenty-first browser session", () => {
    expect(decision({ attemptCount: 3, maxAttempts: 3,
      totalSessions: LINKEDIN_FAILURE_MAX_SESSIONS })).toMatchObject({
      retry: false, extended: false, reason: "session_limit",
    });
    expect(decision({ attemptCount: 3, maxAttempts: 3,
      totalSessions: LINKEDIN_FAILURE_MAX_SESSIONS - 1 })).toMatchObject({
      retry: true, extended: true,
    });
  });
});
