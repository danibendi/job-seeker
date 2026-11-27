import { describe, expect, it } from "vitest";
import { executorsWithOfflineUnpausedSibling, heldExecutors } from "@/lib/worker-pauses";

describe("held executors", () => {
  const registry = [{ id: "codex-a", executor: "codex" }, { id: "codex-b", executor: "codex" }, { id: "api-a", executor: "api" }];

  it("holds an executor only when every registered worker is paused", () => {
    expect(heldExecutors([{ workerId: "codex-a", executor: "codex" }], registry)).toEqual([]);
    expect(heldExecutors([{ workerId: "codex-a", executor: "codex" }, { workerId: "codex-b", executor: "codex" }], registry)).toEqual(["codex"]);
  });

  it("does not hold an executor that has no registered worker", () => {
    expect(heldExecutors([{ workerId: "retired", executor: "hermes" }], registry)).toEqual([]);
  });

  it("accounts for contact freshness so an offline sibling does not keep a paused executor unheld", () => {
    const now = new Date("2026-11-27T12:00:00Z");
    const fresh = new Date("2026-11-27T11:59:00Z");
    const stale = new Date("2026-11-27T11:30:00Z");

    // Unpaused sibling is online -> executor is not held
    expect(heldExecutors(
      [{ workerId: "codex-a", executor: "codex" }],
      registry,
      [{ workerId: "codex-a", lastSeenAt: fresh }, { workerId: "codex-b", lastSeenAt: fresh }],
      now,
    )).toEqual([]);

    // Unpaused sibling is offline (stale contact) -> executor IS held
    expect(heldExecutors(
      [{ workerId: "codex-a", executor: "codex" }],
      registry,
      [{ workerId: "codex-a", lastSeenAt: fresh }, { workerId: "codex-b", lastSeenAt: stale }],
      now,
    )).toEqual(["codex"]);

    // Unpaused sibling has never contacted the app -> executor IS held and has an offline unpaused sibling
    expect(heldExecutors(
      [{ workerId: "codex-a", executor: "codex" }],
      registry,
      [{ workerId: "codex-a", lastSeenAt: fresh }],
      now,
    )).toEqual(["codex"]);
    expect(executorsWithOfflineUnpausedSibling(
      [{ workerId: "codex-a", executor: "codex" }],
      registry,
      [{ workerId: "codex-a", lastSeenAt: fresh }, { workerId: "codex-b", lastSeenAt: stale }],
      now,
    )).toEqual(["codex"]);

    // When all workers for the executor are paused, there is no unpaused sibling
    expect(executorsWithOfflineUnpausedSibling(
      [{ workerId: "codex-a", executor: "codex" }, { workerId: "codex-b", executor: "codex" }],
      registry,
      [{ workerId: "codex-a", lastSeenAt: fresh }, { workerId: "codex-b", lastSeenAt: stale }],
      now,
    )).toEqual([]);
  });
});
