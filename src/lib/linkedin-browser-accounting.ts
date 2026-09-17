import { DEFAULT_LINKEDIN_BROWSER_BUDGETS_USD } from "./linkedin-continuation";

type Json = Record<string, unknown>;
function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
function dollars(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function linkedinBrowserBudgetAvailable(payload: Json, phase: "bootstrap_30d" | "daily_1d") {
  const spend = dollars(payload.browserSpendUsd ?? 0);
  const budget = dollars(object(payload.browserBudgetsUsd)[phase]) ?? DEFAULT_LINKEDIN_BROWSER_BUDGETS_USD[phase];
  return spend !== null && spend < budget;
}

/** Preserve stopped-session receipts before a new attempt can replace its checkpoint. */
export function retainLinkedinBrowserAttempts(task: {
  kind: string; attemptCount: number; payload: Json; checkpoint: Json; result: Json | null;
}, options: { enforceBudget?: boolean } = {}): { payload: Json; checkpoint: Json } {
  const unchanged = { payload: task.payload, checkpoint: task.checkpoint };
  if (task.kind !== "search" || task.attemptCount === 0) return unchanged;
  const server = object(task.checkpoint._server);
  const rawLedger = server.linkedinBrowserAttempts;
  if (rawLedger !== undefined && !Array.isArray(rawLedger)) throw new Error("LinkedIn browser attempt accounting is invalid");
  const ledger = [...(rawLedger as Json[] | undefined ?? [])];
  const counted = new Set(ledger.map((entry) => String(object(object(entry).browser_usage).id ?? "")));
  const result = object(task.result);
  const checkpointResult = object(task.checkpoint.linkedin_collection_result);
  const receipts = [object(checkpointResult.browser_usage), object(object(result.linkedin_collection ?? result).browser_usage)];
  let spend = dollars(task.payload.browserSpendUsd ?? 0);
  if (spend === null) throw new Error("LinkedIn cumulative browser spend must be confirmed before retrying");
  let changed = false;
  for (const usage of receipts) {
    if (Object.keys(usage).length === 0) continue; // No session was allocated.
    const id = usage.id;
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error("LinkedIn browser receipt has no valid session ID");
    if (counted.has(id)) continue;
    const browser = dollars(usage.browserCost), network = dollars(usage.proxyCost);
    if (usage.status !== "stopped" || browser === null || network === null || spend === null) {
      throw new Error("Confirm LinkedIn browser shutdown and its usage before retrying this search");
    }
    const safeUsage = Object.fromEntries(["id", "status", "startedAt", "finishedAt", "timeoutAt", "browserCost", "proxyCost", "proxyUsedMb"]
      .filter((key) => key in usage).map((key) => [key, usage[key]]));
    ledger.push({ attempt: task.attemptCount, browser_usage: safeUsage });
    counted.add(id);
    spend = Math.round((spend + browser + network) * 1_000_000) / 1_000_000;
    changed = true;
  }
  const phase = checkpointResult.active_phase ?? object(task.checkpoint.linkedin_collection).activePhase;
  if (phase === "bootstrap_30d" || phase === "daily_1d") {
    const nextPayload = { ...task.payload, browserSpendUsd: spend };
    if (options.enforceBudget !== false && !linkedinBrowserBudgetAvailable(nextPayload, phase)) {
      throw new Error("The LinkedIn browser budget for this search has been reached");
    }
  }
  return changed ? {
    payload: { ...task.payload, browserSpendUsd: spend },
    checkpoint: { ...task.checkpoint, _server: { ...server, linkedinBrowserAttempts: ledger } },
  } : unchanged;
}
