import { createHmac } from "node:crypto";

export const DERIVED_HERMES_WORKER_ID = "hermes-vps";
export const WORKER_TOKEN_DOMAIN = "job-seeker:v1:worker:hermes";
export const SCHEDULER_TOKEN_DOMAIN = "job-seeker:v1:scheduler";

/** Explicit deployment opt-in; distinct capabilities rotate with the app key. */
export function derivedHermesCredentials(environment: Record<string, string | undefined> = process.env) {
  if (environment.COMPASS_HERMES_DERIVED_WORKER_ENABLED !== "true") return [];
  const workerDomain = environment.COMPASS_DERIVED_WORKER_DOMAIN ?? WORKER_TOKEN_DOMAIN;
  const schedulerDomain = environment.COMPASS_DERIVED_SCHEDULER_DOMAIN ?? SCHEDULER_TOKEN_DOMAIN;
  if ([workerDomain, schedulerDomain].some(value => !value.trim() || value.length > 200) || workerDomain === schedulerDomain) {
    throw new Error("Derived worker and scheduler domains must be nonempty, distinct, and at most 200 characters");
  }
  const seeds = [...new Set((environment.OWNER_MCP_TOKEN ?? environment.HERMES_API_TOKEN ?? "").split(",").map(value => value.trim()).filter(Boolean))];
  if (!seeds.length || seeds.some(seed => seed.length < 32 || seed.startsWith("op://"))) {
    throw new Error("Derived legacy credentials require a resolved owner key of at least 32 characters");
  }
  return seeds.map(seed => ({
    worker: createHmac("sha256", seed).update(workerDomain).digest("hex"),
    scheduler: createHmac("sha256", seed).update(schedulerDomain).digest("hex"),
  }));
}
