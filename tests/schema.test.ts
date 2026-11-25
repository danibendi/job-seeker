import { describe, expect, it } from "vitest";
import { FEEDBACK_REASONS, jobStatus, linkedinSnapshotState, requestStatus, tailoringStatus } from "../src/db/schema";

describe("workflow constants", () => {
  it("keeps every supported pipeline state", () => expect(jobStatus.enumValues).toEqual([
    "sourced", "to_apply", "applied", "screening", "interviewing", "offer", "rejected", "withdrawn", "irrelevant", "archived",
  ]));

  it("keeps the feedback taxonomy stable", () => {
    expect(FEEDBACK_REASONS).toContain("domain_mismatch");
    expect(FEEDBACK_REASONS).toContain("already_applied");
    expect(FEEDBACK_REASONS).toHaveLength(12);
  });

  it("lets the owner dismiss stale needs-you items", () => {
    expect(tailoringStatus.enumValues).toEqual(["proposed", "reviewed", "dismissed"]);
    expect(requestStatus.enumValues).toEqual(["open", "in_progress", "answered", "failed", "dismissed"]);
  });

  it("keeps LinkedIn ingestion and evaluation states explicit", () => {
    expect(linkedinSnapshotState.enumValues).toEqual([
      "discovered_compact", "snapshot_ready", "claimed", "promoted", "rejected", "needs_review", "failed_transient",
    ]);
  });
});
