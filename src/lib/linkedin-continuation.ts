/** Cash ceilings are checked between browser sessions; provider usage can lag. */
export const DEFAULT_LINKEDIN_BROWSER_BUDGETS_USD = { bootstrap_30d: 1, daily_1d: 0.10 } as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function dollars(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function linkedinContinuation(input: {
  result: Record<string, unknown>;
  coverage: unknown;
  payload: Record<string, unknown>;
  currentPolicyHash: string;
}) {
  const coverage = record(input.coverage);
  const collection = record(input.result.linkedin_collection ?? input.result);
  const phase = coverage.phase;
  if (phase !== "bootstrap_30d" && phase !== "daily_1d") return null;
  const state = record(phase === "daily_1d" ? coverage.fresh : coverage.backfill);
  const usage = record(collection.browser_usage);
  const browserCost = dollars(usage.browserCost), networkCost = dollars(usage.proxyCost);
  const previousSpend = dollars(input.payload.browserSpendUsd ?? 0);
  const budgets = record(input.payload.browserBudgetsUsd);
  const ceiling = dollars(budgets[phase]) ?? DEFAULT_LINKEDIN_BROWSER_BUDGETS_USD[phase];
  const spent = previousSpend !== null && browserCost !== null && networkCost !== null
    ? previousSpend + browserCost + networkCost : null;
  const base = { phase, planHash: state.plan_hash, browserSpendUsd: spent, browserBudgetUsd: ceiling };
  if (coverage.complete === true) return { ...base, resume: false, reason: "complete" };
  if (state.policy_hash !== input.currentPolicyHash) return { ...base, resume: false, reason: "policy_changed" };
  if (usage.status !== "stopped" || spent === null) return { ...base, resume: false, reason: "browser_usage_unconfirmed" };
  if (spent >= ceiling) return { ...base, resume: false, reason: "browser_budget" };
  const gaps = Array.isArray(coverage.gaps) ? coverage.gaps.map(record) : [];
  // A source limit in one lane must not strand accessible pages or stored
  // detail IDs elsewhere. The collector retains terminal lane/detail gaps and
  // explicitly reports whether any accessible work remains.
  const blockers = new Set(["authentication_required", "browser_unavailable"]);
  if (collection.provider_blocked === true || gaps.some((gap) => blockers.has(String(gap.reason)))) return { ...base, resume: false, reason: "source_gap" };
  const budgetStop = gaps.some((gap) => ["page_budget", "detail_budget", "time_budget"].includes(String(gap.reason)));
  const counts = record(collection.collection);
  const advanced = Number(counts.page_receipts ?? 0) > 0 || Number(counts.detail_acknowledgements ?? 0) > 0
    || Number(counts.terminal_gap_receipts ?? 0) > 0;
  if (!budgetStop || !advanced || collection.resume_required !== true) return { ...base, resume: false, reason: "no_resumable_progress" };
  return { ...base, resume: true, reason: "continue" };
}
