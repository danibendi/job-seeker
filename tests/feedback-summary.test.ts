import { describe, expect, it } from "vitest";
import { aggregateFeedbackReasons } from "../src/lib/feedback-summary";

describe("aggregateFeedbackReasons", () => {
  it("counts repeated reasons without relying on database array expansion", () => {
    expect(aggregateFeedbackReasons([
      { reasons: ["location", "role_type"] },
      { reasons: ["location"] },
      { reasons: [] },
      { reasons: null },
    ])).toEqual([
      { reason: "location", count: 2 },
      { reason: "role_type", count: 1 },
    ]);
  });

  it("drops blank values and provides deterministic tie ordering", () => {
    expect(aggregateFeedbackReasons([
      { reasons: [" visa ", "", "company"] },
    ])).toEqual([
      { reason: "company", count: 1 },
      { reason: "visa", count: 1 },
    ]);
  });
});
