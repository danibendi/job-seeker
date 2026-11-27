import { afterEach, describe, expect, it, vi } from "vitest";
import { recordWorkerContact } from "@/lib/agent-tasks";

describe("recordWorkerContact", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips the upsert when an existing contact for the same executor is within the throttle window", async () => {
    const insert = vi.fn();
    const execute = vi.fn().mockResolvedValue(undefined);
    const now = new Date("2026-11-27T12:00:30Z");
    const db = {
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<boolean>) => fn({
        execute,
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ executor: "codex", lastSeenAt: new Date("2026-11-27T12:00:00Z") }],
            }),
          }),
        }),
        insert,
      })),
    };

    const recorded = await recordWorkerContact("codex-main", "codex", now, { db: db as never });
    expect(recorded).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it("upserts when contact is missing or past the throttle window", async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    const insert = vi.fn(() => ({ values }));
    const execute = vi.fn().mockResolvedValue(undefined);
    const now = new Date("2026-11-27T12:02:00Z");
    const db = {
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<boolean>) => fn({
        execute,
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ executor: "codex", lastSeenAt: new Date("2026-11-27T12:00:00Z") }],
            }),
          }),
        }),
        insert,
      })),
    };

    const recorded = await recordWorkerContact("codex-main", "codex", now, { db: db as never });
    expect(recorded).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it("never fails the caller on storage errors and logs only sanitized telemetry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = {
      transaction: vi.fn().mockRejectedValue(Object.assign(
        new Error("relation agent_worker_contacts does not exist on db.example.invalid (token=opaque-demo-value)"),
        { code: "42P01" },
      )),
    };

    const recorded = await recordWorkerContact("worker-demo-id", "codex", new Date("2026-11-27T12:00:00Z"), { db: db as never });
    expect(recorded).toBe(false);
    expect(warn).toHaveBeenCalledWith("[worker-contact] failed to record authenticated worker contact", {
      executor: "codex",
      code: "42P01",
    });
    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).not.toContain("worker-demo-id");
    expect(serialized).not.toContain("opaque-demo-value");
    expect(serialized).not.toContain("db.example.invalid");
  });

  it("bounds slow contact storage with a timeout so caller routes stay responsive", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = {
      transaction: vi.fn(() => new Promise(() => undefined)),
    };

    const recorded = await recordWorkerContact("codex-main", "hermes", new Date("2026-11-27T12:00:00Z"), {
      db: db as never,
      timeoutMs: 100,
    });
    expect(recorded).toBe(false);
    expect(warn).toHaveBeenCalledWith("[worker-contact] failed to record authenticated worker contact", {
      executor: "hermes",
      code: "timeout",
    });
  });
});
