import { describe, expect, it } from "vitest";
import { acceptsLinkedinIngestReplay, canonicalizeLinkedinJobUrl, LINKEDIN_DECISION_PROTECTED_STATES, linkedinIngestBatchSchema } from "../src/lib/linkedin-ingestion";

const CANDIDATE_ID = "synthetic-candidate";

function snapshotItem(jobId = "4429879613") {
  return {
    candidateId: CANDIDATE_ID,
    source: "linkedin" as const,
    jobId,
    canonicalUrl: `https://www.linkedin.com/jobs/view/${jobId}/?trackingId=ignored`,
    title: "Technical Program Manager",
    company: "Example Company",
    lane: "eu-remote-tpm",
    resultRank: 1,
    collectorRunKey: "linkedin:2026-08-09:manual-canary",
    firstObservedAt: "2026-08-09T10:00:00.000Z",
    snapshot: { description: "Own complex technical programs." },
    titleDecision: { decision: "open" },
    detailDecision: { decision: "snapshot_ready" },
    funnelState: "snapshot_ready" as const,
  };
}

function batch(items: unknown[] = [snapshotItem()]) {
  return {
    schemaVersion: 1 as const,
    candidateId: CANDIDATE_ID,
    runKey: "linkedin:2026-08-09:manual-canary",
    generatedAt: "2026-08-09T10:05:00.000Z",
    items,
  };
}

describe("LinkedIn ingestion contract", () => {
  it("canonicalizes supported LinkedIn job URLs and strips tracking data", () => {
    expect(canonicalizeLinkedinJobUrl("https://linkedin.com/jobs/view/4429879613?trk=test", "4429879613")).toEqual({
      jobId: "4429879613",
      canonicalUrl: "https://www.linkedin.com/jobs/view/4429879613/",
    });
  });

  it("rejects mismatched IDs and non-job URLs", () => {
    expect(() => canonicalizeLinkedinJobUrl("https://www.linkedin.com/jobs/view/4429879613/", "4450711978")).toThrow("does not match");
    expect(() => canonicalizeLinkedinJobUrl("https://example.com/jobs/view/4429879613/", "4429879613")).toThrow("LinkedIn");
  });

  it("accepts the collector's snapshot-ready payload", () => {
    expect(linkedinIngestBatchSchema.parse(batch()).items[0].jobId).toBe("4429879613");
  });

  it("requires company, both Luna gate decisions and snapshot evidence", () => {
    const item = snapshotItem();
    const invalid = { ...item, detailDecision: undefined };
    expect(linkedinIngestBatchSchema.safeParse(batch([invalid])).success).toBe(false);
    expect(linkedinIngestBatchSchema.safeParse(batch([{ ...item, company: undefined }])).success).toBe(false);
    expect(linkedinIngestBatchSchema.safeParse(batch([{ ...item, company: " \t " }])).success).toBe(false);
    expect(linkedinIngestBatchSchema.safeParse(batch([{ ...item, company: "ﬃ".repeat(101) }])).success).toBe(false);
  });

  it("allows compact discovery without triggering the rich-snapshot contract", () => {
    const item = snapshotItem();
    const compact = { ...item, company: undefined, funnelState: "discovered_compact" as const, snapshot: undefined, titleDecision: undefined, detailDecision: undefined };
    expect(linkedinIngestBatchSchema.safeParse(batch([compact])).success).toBe(true);
  });

  it("enforces the eight-job evaluator budget and unique IDs", () => {
    const nine = Array.from({ length: 9 }, (_, index) => snapshotItem(String(4429879613 + index)));
    expect(linkedinIngestBatchSchema.safeParse(batch(nine)).success).toBe(false);
    expect(linkedinIngestBatchSchema.safeParse(batch([snapshotItem(), snapshotItem()])).success).toBe(false);
  });

  it("requires batch and item run/candidate identities to agree", () => {
    expect(linkedinIngestBatchSchema.safeParse(batch([{ ...snapshotItem(), candidateId: "someone-else" }])).success).toBe(false);
    expect(linkedinIngestBatchSchema.safeParse(batch([{ ...snapshotItem(), collectorRunKey: "another-run" }])).success).toBe(false);
  });

  it("preserves legacy receipt replay while rejecting changed hashed payloads", () => {
    expect(acceptsLinkedinIngestReplay(null, "new-hash")).toBe(true);
    expect(acceptsLinkedinIngestReplay("same-hash", "same-hash")).toBe(true);
    expect(acceptsLinkedinIngestReplay("old-hash", "new-hash")).toBe(false);
  });

  it("keeps needs-review evidence protected from later observations", () => {
    expect(LINKEDIN_DECISION_PROTECTED_STATES).toContain("needs_review");
    expect(LINKEDIN_DECISION_PROTECTED_STATES).not.toContain("rejected");
  });
});
