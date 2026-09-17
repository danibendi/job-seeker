import { describe, expect, it } from "vitest";
import { availableJobTransitions, canReachDestination, canTransitionJob, isJobDestination, jobDestinations, quickAdvanceStatus, resolveJobDestination } from "../src/lib/job-workflow";

describe("job workflow", () => {
  it("never quick-advances terminal or offer states", () => {
    expect(quickAdvanceStatus("offer")).toBeNull();
    expect(quickAdvanceStatus("rejected")).toBeNull();
    expect(quickAdvanceStatus("archived")).toBeNull();
  });

  it("advances active states without no-op transitions", () => {
    expect(quickAdvanceStatus("sourced")).toBe("to_apply");
    expect(quickAdvanceStatus("interviewing")).toBe("offer");
    expect(canTransitionJob("interviewing", "interviewing")).toBe(false);
  });

  it("limits terminal-state changes to explicit recovery or archiving", () => {
    expect(availableJobTransitions("rejected")).toEqual(["archived"]);
    expect(canTransitionJob("irrelevant", "sourced")).toBe(true);
    expect(canTransitionJob("offer", "to_apply")).toBe(false);
  });

  it("splits sourced into review and saved-for-later destinations", () => {
    expect(jobDestinations("sourced", false)).toEqual(["later", "to_apply", "irrelevant", "archived"]);
    expect(jobDestinations("sourced", true)).toEqual(["sourced", "to_apply", "irrelevant", "archived"]);
    expect(jobDestinations("to_apply", false)).toEqual(["sourced", "later", "applied", "irrelevant", "withdrawn", "archived"]);
    expect(jobDestinations("archived", false)).toEqual([]);
  });

  it("only lets a job be dropped where it can actually go", () => {
    expect(canReachDestination("sourced", false, "applied")).toBe(false);
    expect(canReachDestination("sourced", false, "later")).toBe(true);
    expect(canReachDestination("sourced", true, "later")).toBe(false);
    expect(canReachDestination("irrelevant", true, "sourced")).toBe(true);
    expect(canReachDestination("applied", false, "rejected")).toBe(true);
  });

  it("resolves destinations to a status plus triage flag", () => {
    expect(resolveJobDestination("later")).toEqual({ status: "sourced", triaged: true });
    expect(resolveJobDestination("sourced")).toEqual({ status: "sourced", triaged: false });
    expect(resolveJobDestination("applied")).toEqual({ status: "applied", triaged: null });
    expect(isJobDestination("later")).toBe(true);
    expect(isJobDestination("nowhere")).toBe(false);
  });
});
