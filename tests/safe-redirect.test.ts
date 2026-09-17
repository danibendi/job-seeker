import { describe, expect, it } from "vitest";
import { safeInternalPath } from "../src/lib/safe-redirect";

describe("safeInternalPath", () => {
  it("keeps ordinary internal paths, query strings, and fragments", () => {
    expect(safeInternalPath("/jobs/123?tab=cv#change")).toBe("/jobs/123?tab=cv#change");
  });

  it("rejects protocol-relative, absolute, slash-confused, and control-character redirects", () => {
    for (const value of ["//evil.example", "https://evil.example", "/\\evil.example", "/jobs\n/evil", "javascript:alert(1)", "/%5cevil.example", "/%252f%252fevil.example"]) {
      expect(safeInternalPath(value)).toBe("/");
    }
  });
});
