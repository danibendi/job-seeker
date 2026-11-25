import { describe, expect, it } from "vitest";
import { heldExecutors } from "@/lib/worker-pauses";

describe("held executors", () => {
  const registry = [{ id: "codex-a", executor: "codex" }, { id: "codex-b", executor: "codex" }, { id: "api-a", executor: "api" }];

  it("holds an executor only when every registered worker is paused", () => {
    expect(heldExecutors([{ workerId: "codex-a", executor: "codex" }], registry)).toEqual([]);
    expect(heldExecutors([{ workerId: "codex-a", executor: "codex" }, { workerId: "codex-b", executor: "codex" }], registry)).toEqual(["codex"]);
  });

  it("does not hold an executor that has no registered worker", () => {
    expect(heldExecutors([{ workerId: "retired", executor: "hermes" }], registry)).toEqual([]);
  });
});
