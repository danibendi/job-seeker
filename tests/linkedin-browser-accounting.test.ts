import { describe, expect, it } from "vitest";
import { retainLinkedinBrowserAttempts } from "../src/lib/linkedin-browser-accounting";
import { mergeWorkerCheckpoint } from "../src/lib/agent-task-contract";

const receipt = (id = "8fd72561-0000-4000-8000-000000000001") => ({ id, status: "stopped", browserCost: "0.0026666666667", proxyCost: "0.0878943", proxyUsedMb: "450.018" });
const example = () => ({ kind: "search", attemptCount: 1, payload: { browserSpendUsd: 0.05 },
  checkpoint: { linkedin_collection_result: { active_phase: "bootstrap_30d", browser_usage: receipt() } }, result: null });

describe("LinkedIn browser attempt accounting", () => {
  it("carries a failed attempt's charge once through retry and claim, retaining receipts after checkpoint replacement", () => {
    const task = example();
    const retried = retainLinkedinBrowserAttempts(task);
    expect(retried.payload.browserSpendUsd).toBe(0.140561);
    const claimed = retainLinkedinBrowserAttempts({ ...task, ...retried });
    expect(claimed).toEqual(retried);
    const next = receipt("8fd72561-0000-4000-8000-000000000002");
    const checkpoint = mergeWorkerCheckpoint(claimed.checkpoint, { _server: { linkedinBrowserAttempts: [] }, linkedin_collection_result: { active_phase: "bootstrap_30d", browser_usage: next } });
    const second = retainLinkedinBrowserAttempts({ ...task, payload: claimed.payload, checkpoint, attemptCount: 2 });
    expect(second.payload.browserSpendUsd).toBe(0.231122);
    expect((second.checkpoint._server as Record<string, unknown>).linkedinBrowserAttempts).toHaveLength(2);
  });
  it("deduplicates result/checkpoint but never trusts worker-writable recovery metadata as charged", () => {
    const task = example();
    const duplicate = retainLinkedinBrowserAttempts({ ...task, result: { linkedin_collection: { browser_usage: receipt() } } });
    expect(duplicate.payload.browserSpendUsd).toBe(0.140561);
    const recovered = retainLinkedinBrowserAttempts({ ...task, checkpoint: { ...task.checkpoint, linkedinBrowserReceiptRecoveries: [{ receipt: { session: { id: receipt().id } } }] } });
    expect(recovered.payload.browserSpendUsd).toBe(0.140561);
    const historical = retainLinkedinBrowserAttempts({ ...task, checkpoint: { linkedinBrowserReceiptRecoveries: [{ receipt: { session: { id: receipt().id } } }] } });
    expect(historical.payload.browserSpendUsd).toBe(0.05);
  });
  it("refuses unknown charges, live sessions and an exhausted retry budget", () => {
    for (const usage of [{ ...receipt(), proxyCost: null }, { ...receipt(), status: "running" }]) {
      const task = example();
      expect(() => retainLinkedinBrowserAttempts({ ...task, checkpoint: { linkedin_collection_result: { browser_usage: usage } } })).toThrow("Confirm LinkedIn browser");
    }
    expect(() => retainLinkedinBrowserAttempts({ ...example(), payload: { browserSpendUsd: 0.95 } })).toThrow("budget");
    expect(() => retainLinkedinBrowserAttempts({ ...example(), payload: { browserSpendUsd: "unknown" }, checkpoint: {} })).toThrow("cumulative browser spend");
  });
  it("can retain a terminal stopped receipt while leaving default claim budget enforcement intact", () => {
    const task = { ...example(), payload: { browserSpendUsd: 0.95 } };
    expect(() => retainLinkedinBrowserAttempts(task)).toThrow("budget");
    const terminal = retainLinkedinBrowserAttempts(task, { enforceBudget: false });
    expect(terminal.payload.browserSpendUsd).toBe(1.040561);
    expect((terminal.checkpoint._server as Record<string, unknown>).linkedinBrowserAttempts).toHaveLength(1);
  });
  it("leaves fresh tasks and failures before browser allocation alone", () => {
    const task = example();
    expect(retainLinkedinBrowserAttempts({ ...task, attemptCount: 0 }).payload).toBe(task.payload);
    expect(retainLinkedinBrowserAttempts({ ...task, checkpoint: {} }).payload).toBe(task.payload);
  });
});
