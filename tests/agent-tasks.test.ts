import { describe, expect, it } from "vitest";
import {
  classifyExpiredTask,
  getDueScheduleOccurrence,
  isFreshTerminalLinkedInDecision,
  isSupersededAgentTaskCheckpoint,
  mergeWorkerCheckpoint,
  resultsMatch,
  searchScopeKey,
  sha256OpaqueToken,
  stableJsonHash,
} from "../src/lib/agent-task-contract";
import type { SearchSchedule } from "../src/lib/settings";
import { assertSearchSourcesConfigured, isPartialSearchResult, updateAgentExecutionSettings, type AgentTaskTransaction } from "../src/lib/agent-tasks";
import {
  LINKEDIN_BOOTSTRAP_LOOKBACK_SECONDS,
  LINKEDIN_DAILY_LOOKBACK_SECONDS,
  LINKEDIN_PROVIDER_VISIBLE_RESULT_CAP,
  linkedinScanPageSchema,
  linkedinScanPlanHash,
  linkedinScanPlanSchema,
  linkedinScanStopSchema,
} from "../src/lib/linkedin-scan-contract";

const daily: SearchSchedule = { enabled: true, frequency: "daily", time: "09:00", days: [], maxJobs: 15 };

describe("agent task contract", () => {
  it("allows question-only execution settings while refusing source-less searches", async () => {
    const current = {
      id: "owner", searchExecutor: "unassigned", evaluationExecutor: "unassigned", searchSources: [],
      maxPages: 10, maxDetailFetches: 30, maxDurationSeconds: 1200, updatedAt: new Date(0),
    } as const;
    let inserted: Record<string, unknown> | undefined;
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [current] }) }) }),
      insert: () => ({ values: (value: Record<string, unknown>) => {
        inserted = value;
        return { onConflictDoUpdate: () => ({ returning: async () => [value] }) };
      } }),
    } as unknown as AgentTaskTransaction;
    await expect(updateAgentExecutionSettings({ searchExecutor: "api", searchSources: [] }, tx)).resolves.toMatchObject({ searchExecutor: "api", searchSources: [] });
    expect(inserted).toMatchObject({ searchExecutor: "api", searchSources: [] });
    expect(() => assertSearchSourcesConfigured([])).toThrow(/at least one search source/i);
    expect(() => assertSearchSourcesConfigured(["public"])).not.toThrow();
  });

  it("classifies explicit and server-derived partial search results", () => {
    expect(isPartialSearchResult({ status: "partial" })).toBe(true);
    expect(isPartialSearchResult({ linkedin_coverage: { complete: false } })).toBe(true);
    expect(isPartialSearchResult({ status: "complete", linkedin_coverage: { complete: true } })).toBe(false);
    expect(isPartialSearchResult(undefined)).toBe(false);
  });

  it("requeues an expired lease only while another bounded attempt remains", () => {
    expect(classifyExpiredTask(1, 3)).toBe("requeue");
    expect(classifyExpiredTask(2, 3)).toBe("requeue");
    expect(classifyExpiredTask(3, 3)).toBe("fail");
  });

  it("accepts an identical completion replay regardless of object key order", () => {
    const first = { summaryMd: "Collected 12 roles", counts: { pending: 4, accepted: 8 } };
    const replay = { counts: { accepted: 8, pending: 4 }, summaryMd: "Collected 12 roles" };
    expect(resultsMatch(first, replay)).toBe(true);
    expect(resultsMatch(first, { ...replay, summaryMd: "Collected 13 roles" })).toBe(false);
    expect(stableJsonHash(first)).toHaveLength(64);
  });

  it("preserves server checkpoint state while merging worker progress", () => {
    expect(mergeWorkerCheckpoint(
      { page: 1, _server: { scopedJobIds: ["job-1"], evaluationDecisionHash: "abc" } },
      { page: 2, note: "continued", _server: { scopedJobIds: ["forged"] } },
    )).toEqual({ page: 2, note: "continued", _server: { scopedJobIds: ["job-1"], evaluationDecisionHash: "abc" } });
  });

  it("recognizes only an exact supersede recovery receipt for the same task", () => {
    const taskId = "686c3a29-586d-4722-a15f-6ff7a503dad5";
    const receipt = { taskId, session: { id: "7052e562-e0d0-4682-b623-a6dc4f52cb29", status: "stopped" } };
    const recovery = {
      schemaVersion: 1,
      kind: "linkedin_browser_receipt_recovery",
      action: "supersede",
      planHash: "a".repeat(64),
      receiptHash: stableJsonHash(receipt),
      supersedeReason: "Superseded by approved Prague-filtered discovery",
      receipt,
    };
    expect(isSupersededAgentTaskCheckpoint({ linkedinBrowserReceiptRecoveries: [recovery] }, taskId)).toBe(true);
    expect(isSupersededAgentTaskCheckpoint({}, taskId)).toBe(false);
    expect(isSupersededAgentTaskCheckpoint({ linkedinBrowserReceiptRecoveries: [{ ...recovery, action: "retry" }] }, taskId)).toBe(false);
    expect(isSupersededAgentTaskCheckpoint({ linkedinBrowserReceiptRecoveries: [{ ...recovery, receiptHash: "b".repeat(64) }] }, taskId)).toBe(false);
    expect(isSupersededAgentTaskCheckpoint({ linkedinBrowserReceiptRecoveries: [recovery] }, "11111111-1111-4111-8111-111111111111")).toBe(false);
  });

  it("requires a fresh persisted terminal decision for LinkedIn completion", () => {
    const createdAt = new Date("2026-09-12T10:00:00Z");
    expect(isFreshTerminalLinkedInDecision("promoted", new Date("2026-09-12T10:01:00Z"), createdAt)).toBe(true);
    expect(isFreshTerminalLinkedInDecision("claimed", new Date("2026-09-12T10:01:00Z"), createdAt)).toBe(false);
    expect(isFreshTerminalLinkedInDecision("rejected", new Date("2026-09-12T09:59:00Z"), createdAt)).toBe(false);
  });

  it("hashes opaque grants and stable search scope inputs", () => {
    expect(sha256OpaqueToken("grant")).toMatch(/^[a-f0-9]{64}$/);
    expect(searchScopeKey({ roles: ["TPM"], remote: true }, ["board", "public"]))
      .toBe(searchScopeKey({ remote: true, roles: ["TPM"] }, ["public", "board"]));
    expect(searchScopeKey({ roles: ["TPM"], schedule: { time: "09:00" } }, ["public"]))
      .toBe(searchScopeKey({ roles: ["TPM"], schedule: { time: "14:00" } }, ["public"]));
  });
});

describe("scheduled search occurrence", () => {
  it("becomes due only after today's local wall time and keeps a date-only identity", () => {
    expect(getDueScheduleOccurrence(daily, "Europe/Prague", new Date("2026-09-12T06:59:00Z"))).toBeNull();
    const due = getDueScheduleOccurrence(daily, "Europe/Prague", new Date("2026-09-12T07:01:00Z"));
    expect(due).toEqual({
      localDate: "2026-09-12",
      occurrenceKey: "owner:scheduled-search:2026-09-12",
      scheduledLocalTime: "2026-09-12T09:00[Europe/Prague]",
    });
    const changed = getDueScheduleOccurrence({ ...daily, time: "07:30", maxJobs: 50 }, "Europe/Prague", new Date("2026-09-12T12:00:00Z"));
    expect(changed?.occurrenceKey).toBe(due?.occurrenceKey);
  });

  it("honours weekday and custom-day schedules without historical replay", () => {
    const sunday = new Date("2026-09-13T10:00:00Z");
    expect(getDueScheduleOccurrence({ ...daily, frequency: "weekdays" }, "UTC", sunday)).toBeNull();
    expect(getDueScheduleOccurrence({ ...daily, frequency: "custom", days: ["sun"] }, "UTC", sunday)?.localDate).toBe("2026-09-13");
    expect(getDueScheduleOccurrence({ ...daily, enabled: false }, "UTC", sunday)).toBeNull();
  });

  it("uses the first real tick after a skipped DST wall time", () => {
    const skippedTime = { ...daily, time: "02:30" };
    const afterSpringForward = new Date("2026-03-29T01:05:00Z"); // 03:05 in Prague; 02:30 did not exist.
    expect(getDueScheduleOccurrence(skippedTime, "Europe/Prague", afterSpringForward)?.localDate).toBe("2026-03-29");
  });
});

describe("LinkedIn scan contract", () => {
  const plan = {
    schema_version: 2 as const,
    track: "fresh" as const,
    policy_hash: "a".repeat(64),
    lanes: [
      { lane_key: "prague-tpm", query: "technical program manager", search_url: "https://www.linkedin.com/jobs/search/?keywords=technical+program+manager&location=Prague" },
      { lane_key: "eu-remote", query: "program manager", search_url: "https://www.linkedin.com/jobs/search/?keywords=program+manager&f_WT=2" },
    ],
  };

  it("freezes a lane-order-independent plan and excludes a caller-supplied time window", () => {
    expect(linkedinScanPlanSchema.safeParse(plan).success).toBe(true);
    expect(linkedinScanPlanHash("scope", plan.policy_hash, plan)).toBe(linkedinScanPlanHash("scope", plan.policy_hash, { ...plan, lanes: [...plan.lanes].reverse() }));
    expect(linkedinScanPlanHash("scope", plan.policy_hash, plan)).toBe(linkedinScanPlanHash("scope", plan.policy_hash, { ...plan, track: "backfill" }));
    expect(linkedinScanPlanSchema.parse(({ ...plan, track: undefined })).track).toBe("backfill");
    expect(linkedinScanPlanSchema.safeParse({ ...plan, schema_version: 1 }).success).toBe(false);
    expect(linkedinScanPlanSchema.safeParse({ ...plan, lanes: [{ ...plan.lanes[0], search_url: `${plan.lanes[0].search_url}&f_TPR=r86400` }] }).success).toBe(false);
  });

  it("requires a complete cursor chain and rejects non-terminal empty pages", () => {
    const base = { track: "fresh" as const, plan_hash: "b".repeat(64), lane_key: "prague-tpm", page: 1, page_complete: true as const, job_ids: ["123456789"], pending_detail_job_ids: [], exhausted: false };
    expect(linkedinScanPageSchema.safeParse({ ...base, next_cursor: "page-2" }).success).toBe(true);
    expect(linkedinScanPageSchema.safeParse(base).success).toBe(false);
    expect(linkedinScanPageSchema.safeParse({ ...base, job_ids: [], next_cursor: "page-2" }).success).toBe(false);
    expect(linkedinScanPageSchema.safeParse({ ...base, exhausted: true, next_cursor: "page-2" }).success).toBe(false);
  });

  it("isolates corrected result extraction from legacy pending IDs and completion", () => {
    const legacyHash = linkedinScanPlanHash("scope", plan.policy_hash, plan);
    const corrected = linkedinScanPlanSchema.parse({ ...plan, collector_revision: 2 });
    expect(corrected.collector_revision).toBe(2);
    expect(linkedinScanPlanHash("scope", plan.policy_hash, corrected)).not.toBe(legacyHash);
    expect(linkedinScanPlanHash("scope", plan.policy_hash, { ...plan, collector_revision: 1 })).toBe(legacyHash);
    expect(linkedinScanPlanSchema.safeParse({ ...plan, collector_revision: 3 }).success).toBe(false);
  });

  it("declares the 30-day bootstrap, exact 1-day daily window and provider cap", () => {
    expect(LINKEDIN_BOOTSTRAP_LOOKBACK_SECONDS).toBe(2_592_000);
    expect(LINKEDIN_DAILY_LOOKBACK_SECONDS).toBe(86_400);
    expect(LINKEDIN_PROVIDER_VISIBLE_RESULT_CAP).toBe(1_000);
  });

  it("requires a lane when an incomplete-page stop preserves pending details", () => {
    const stop = { track: "fresh", plan_hash: "c".repeat(64), reason: "pagination_unverified", pending_detail_job_ids: ["123456789"] };
    expect(linkedinScanStopSchema.safeParse(stop).success).toBe(false);
    expect(linkedinScanStopSchema.safeParse({ ...stop, lane_key: "prague-tpm" }).success).toBe(true);
  });

  it("ties unavailable detail stops to one durable job ID", () => {
    const stop = { track: "fresh", plan_hash: "d".repeat(64), reason: "detail_unavailable" };
    expect(linkedinScanStopSchema.safeParse(stop).success).toBe(false);
    expect(linkedinScanStopSchema.safeParse({ ...stop, detail_job_id: "123456789" }).success).toBe(true);
    expect(linkedinScanStopSchema.safeParse({ ...stop, reason: "source_cap", detail_job_id: "123456789" }).success).toBe(false);
  });
});
