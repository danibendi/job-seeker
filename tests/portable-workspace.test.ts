import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE, normalizeWorkspaceInput } from "../src/lib/workspace-values";

describe("portable workspace identity", () => {
  it("normalizes a complete installation-owned identity", () => {
    expect(normalizeWorkspaceInput({
      candidateId: " Candidate_01 ",
      displayName: " Alex's Search ",
      ownerName: " Alex Morgan ",
      assistantLabel: " Scout ",
      locale: "en-GB",
      timeZone: "Europe/London",
    })).toEqual({
      candidateId: "candidate_01",
      displayName: "Alex's Search",
      ownerName: "Alex Morgan",
      assistantLabel: "Scout",
      locale: "en-GB",
      timeZone: "Europe/London",
    });
    expect(DEFAULT_WORKSPACE.onboardingCompletedAt).toBeNull();
  });

  it("rejects unsafe candidate IDs and invalid locale/time-zone values", () => {
    const valid = { candidateId: "candidate-01", displayName: "Search", ownerName: "Alex", assistantLabel: "Assistant", locale: "en", timeZone: "UTC" };
    expect(() => normalizeWorkspaceInput({ ...valid, candidateId: "../../shared" })).toThrow(/Candidate ID/);
    expect(() => normalizeWorkspaceInput({ ...valid, locale: "not a locale" })).toThrow(/Locale/);
    expect(() => normalizeWorkspaceInput({ ...valid, timeZone: "Local/Guess" })).toThrow(/time zone/);
  });
});
