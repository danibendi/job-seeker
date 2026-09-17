import { describe, expect, it } from "vitest";
import { COMPANY_SLUG_MAX_LENGTH, companyDisplayName, companyDisplayNameFitsStorage, companySlugCandidates, normalizeCompanyIdentity } from "../src/lib/company-identity";
import { makeDedupeKey } from "../src/lib/format";
import { readFileSync } from "node:fs";

describe("company identity", () => {
  it("normalizes harmless spelling differences to one identity", () => {
    expect(companyDisplayName("  Acme   Labs  ")).toBe("Acme Labs");
    expect(normalizeCompanyIdentity("ACME Labs")).toBe(normalizeCompanyIdentity("acme labs"));
    expect(companySlugCandidates("ACME Labs")).toEqual(companySlugCandidates("acme labs"));
  });

  it("gives distinct collision fallbacks to distinct names with the same base slug", () => {
    const ampersand = companySlugCandidates("A&B");
    const word = companySlugCandidates("A and B");
    expect(ampersand[0]).toBe("a-and-b");
    expect(word[0]).toBe("a-and-b");
    expect(ampersand[1]).not.toBe(word[1]);
    expect(makeDedupeKey("A&B", "Same role", "Same place")).not.toBe(makeDedupeKey("A and B", "Same role", "Same place"));
  });

  it("keeps every candidate within the database slug limit", () => {
    expect(companyDisplayNameFitsStorage("x".repeat(300))).toBe(true);
    expect(companySlugCandidates("x".repeat(300)).every((slug) => slug.length <= COMPANY_SLUG_MAX_LENGTH)).toBe(true);
  });

  it("detects compatibility normalization that expands beyond database storage", () => {
    const expanding = "ﬃ".repeat(101);
    expect(expanding.length).toBeLessThanOrEqual(300);
    expect(companyDisplayName(expanding).length).toBeGreaterThan(300);
    expect(companyDisplayNameFitsStorage(expanding)).toBe(false);
  });

  it("rejects a raw company name that normalizes to an empty identity", () => {
    expect(companyDisplayNameFitsStorage(" \t \n ")).toBe(false);
  });

  it("keeps manual jobs for slug-colliding company identities separate", () => {
    const dotted = companySlugCandidates("A.B");
    const spaced = companySlugCandidates("A B");
    expect(dotted[0]).toBe(spaced[0]);
    expect(dotted[1]).not.toBe(spaced[1]);
    expect(normalizeCompanyIdentity("A.B")).not.toBe(normalizeCompanyIdentity("A B"));

    const actions = readFileSync(new URL("../src/lib/actions.ts", import.meta.url), "utf8");
    const manualCreate = actions.slice(actions.indexOf("export async function createManualJob"), actions.indexOf("export async function createCvVariant"));
    expect(manualCreate).toContain("companySlugCandidates(companyName)");
    expect(manualCreate).toContain("normalizeCompanyIdentity(existing.name) === identity");
    expect(manualCreate).toContain("onConflictDoNothing");
    expect(manualCreate).not.toContain("onConflictDoUpdate");

    const ownerMcp = readFileSync(new URL("../src/app/api/mcp/route.ts", import.meta.url), "utf8");
    const ensureCompany = ownerMcp.slice(ownerMcp.indexOf("async function ensureCompany"), ownerMcp.indexOf("async function fullJob"));
    expect(ensureCompany).toContain("companySlugCandidates(name)");
    expect(ensureCompany).toContain("normalizeCompanyIdentity(existing.name) === identity");
    expect(ensureCompany).toContain("onConflictDoNothing");
    expect(ensureCompany).not.toContain("onConflictDoUpdate");
    expect(ownerMcp.match(/insert\(companies\)/g)).toHaveLength(1);
  });
});
