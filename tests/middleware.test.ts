import { describe, expect, it } from "vitest";
import { isPublicPath } from "../src/lib/public-paths";

describe("middleware public paths", () => {
  it("allows the login page and authentication endpoints", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/auth/login")).toBe(true);
    expect(isPublicPath("/manifest.webmanifest")).toBe(true);
    expect(isPublicPath("/icons/icon-192.png")).toBe(true);
    expect(isPublicPath("/sw.js")).toBe(true);
    expect(isPublicPath("/api/auth/logout")).toBe(true);
    expect(isPublicPath("/api/linkedin/ingest")).toBe(true);
  });

  it("continues to protect application and lookalike paths", () => {
    expect(isPublicPath("/jobs")).toBe(false);
    expect(isPublicPath("/api/authentic")).toBe(false);
  });
});
