import { describe, expect, it } from "vitest";
import { linkedinContinuation } from "../src/lib/linkedin-continuation";

const example = () => ({
  currentPolicyHash: "current", payload: { browserSpendUsd: 0.05 },
  result: { resume_required: true, provider_blocked: false, collection: { page_receipts: 40, detail_acknowledgements: 90 }, browser_usage: { status: "stopped", browserCost: "0.003", proxyCost: "0.09" } },
  coverage: { phase: "bootstrap_30d", complete: false, backfill: { plan_hash: "plan", policy_hash: "current" }, gaps: [{ kind: "run_stopped", reason: "time_budget" }] },
});
describe("durable collection continuation", () => {
  it("continues a verified budget stop and carries provider cost", () => {
    const decision = linkedinContinuation(example());
    expect(decision).toMatchObject({ resume: true, phase: "bootstrap_30d", browserBudgetUsd: 1 });
    expect(decision?.browserSpendUsd).toBeCloseTo(0.143);
  });
  it("stops after completion, policy change, uncertain cleanup, or a source gap", () => {
    for (const mutate of [
      (x: ReturnType<typeof example>) => { x.coverage.complete = true; },
      (x: ReturnType<typeof example>) => { x.currentPolicyHash = "changed"; },
      (x: ReturnType<typeof example>) => { x.result.browser_usage.status = "active"; },
      (x: ReturnType<typeof example>) => { x.result.provider_blocked = true; },
      (x: ReturnType<typeof example>) => { x.coverage.gaps[0].reason = "authentication_required"; },
    ]) {
      const value = example(); mutate(value);
      expect(linkedinContinuation(value)?.resume).toBe(false);
    }
  });
  it("continues accessible work while retaining a source cap in another lane", () => {
    const value = example();
    value.coverage.gaps.push({kind: "lane_stopped", reason: "source_cap"});
    expect(linkedinContinuation(value)?.resume).toBe(true);
    value.result.collection = {page_receipts: 0, detail_acknowledgements: 0};
    expect(linkedinContinuation(value)?.resume).toBe(false);
  });
  it("uses the daily cash ceiling and refuses unconfirmed cost", () => {
    const value = example();
    value.coverage = { ...value.coverage, phase: "daily_1d", fresh: value.coverage.backfill } as typeof value.coverage;
    expect(linkedinContinuation(value)).toMatchObject({ resume: false, reason: "browser_budget", browserBudgetUsd: 0.10 });
    value.result.browser_usage.proxyCost = "";
    expect(linkedinContinuation(value)).toMatchObject({ resume: false, reason: "browser_usage_unconfirmed" });
  });
});
