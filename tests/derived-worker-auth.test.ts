import { describe, expect, it } from "vitest";
import vectors from "./fixtures/derived-credentials.json";
import { derivedHermesCredentials } from "../src/lib/derived-worker-auth";

describe("derived parent credentials", () => {
  it("requires an exact opt-in and a resolved strong seed", () => {
    expect(derivedHermesCredentials({ HERMES_API_TOKEN: "x".repeat(32) })).toEqual([]);
    expect(derivedHermesCredentials({ COMPASS_HERMES_DERIVED_WORKER_ENABLED: "TRUE" })).toEqual([]);
    expect(() => derivedHermesCredentials({ COMPASS_HERMES_DERIVED_WORKER_ENABLED: "true", HERMES_API_TOKEN: "short" })).toThrow();
  });
  it("separates worker, scheduler and app capabilities and accepts rotation seeds", () => {
    const credentials = derivedHermesCredentials({ COMPASS_HERMES_DERIVED_WORKER_ENABLED: "true", HERMES_API_TOKEN: `${"a".repeat(32)}, ${"b".repeat(32)}` });
    expect(new Set(credentials.flatMap(value => [value.worker, value.scheduler])).size).toBe(4);
    expect(credentials[0].worker).not.toBe("a".repeat(32));
    expect(credentials[0].worker).toHaveLength(64);
    expect(credentials[0]).toEqual(derivedHermesCredentials({ COMPASS_HERMES_DERIVED_WORKER_ENABLED: "true", HERMES_API_TOKEN: "a".repeat(32) })[0]);
  });
  it("accepts the neutral owner token only behind the explicit legacy derivation flag", () => {
    const owner = "o".repeat(32);
    expect(derivedHermesCredentials({ OWNER_MCP_TOKEN: owner })).toEqual([]);
    const [credentials] = derivedHermesCredentials({ COMPASS_HERMES_DERIVED_WORKER_ENABLED: "true", OWNER_MCP_TOKEN: owner });
    expect(credentials.worker).not.toBe(owner);
    expect(credentials.scheduler).not.toBe(owner);
    expect(credentials.worker).not.toBe(credentials.scheduler);
  });
  it("matches the shared Python/TypeScript credential vectors", () => {
    const environment = { COMPASS_HERMES_DERIVED_WORKER_ENABLED: "true", OWNER_MCP_TOKEN: vectors.seed };
    expect(derivedHermesCredentials(environment)).toEqual([vectors.default]);
    expect(derivedHermesCredentials({ ...environment,
      COMPASS_DERIVED_WORKER_DOMAIN: vectors.customDomains.worker,
      COMPASS_DERIVED_SCHEDULER_DOMAIN: vectors.customDomains.scheduler,
    })).toEqual([vectors.custom]);
  });
  it("rejects empty or colliding derivation domains", () => {
    const environment = { COMPASS_HERMES_DERIVED_WORKER_ENABLED: "true", OWNER_MCP_TOKEN: vectors.seed };
    expect(() => derivedHermesCredentials({ ...environment, COMPASS_DERIVED_WORKER_DOMAIN: "" })).toThrow();
    expect(() => derivedHermesCredentials({ ...environment, COMPASS_DERIVED_WORKER_DOMAIN: "same", COMPASS_DERIVED_SCHEDULER_DOMAIN: "same" })).toThrow();
  });

});
