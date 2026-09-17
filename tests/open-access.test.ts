import { afterEach, describe, expect, it } from "vitest";
import { isOpenAccess } from "../src/lib/open-access";

const originalNodeEnv = process.env.NODE_ENV;
const originalOpenAccess = process.env.COMPASS_OPEN_ACCESS;
const mutableEnv = process.env as Record<string, string | undefined>;

afterEach(() => {
  if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV;
  else mutableEnv.NODE_ENV = originalNodeEnv;
  if (originalOpenAccess === undefined) delete mutableEnv.COMPASS_OPEN_ACCESS;
  else mutableEnv.COMPASS_OPEN_ACCESS = originalOpenAccess;
});

describe("open access", () => {
  it("can only bypass authentication in explicit development mode", () => {
    Object.assign(process.env, { NODE_ENV: "production", COMPASS_OPEN_ACCESS: "1" });
    expect(isOpenAccess()).toBe(false);
    Object.assign(process.env, { NODE_ENV: "test", COMPASS_OPEN_ACCESS: "1" });
    expect(isOpenAccess()).toBe(false);
    Object.assign(process.env, { NODE_ENV: "development", COMPASS_OPEN_ACCESS: "1" });
    expect(isOpenAccess()).toBe(true);
  });
});
