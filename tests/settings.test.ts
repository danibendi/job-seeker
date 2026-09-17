import { describe, expect, it } from "vitest";
import { DEFAULT_SEARCH_SETTINGS, effectiveSearchPolicy, normalizeLocations, normalizeRemote, normalizeRemoteSearchLocations, normalizeSchedule, parseList, scheduleSummary, uniqueTokens } from "../src/lib/settings";

describe("settings", () => {
  it("parses comma, semicolon, and newline separated lists without duplicates", () => {
    expect(parseList("Prague, Brno\nBudapest; Prague ,")).toEqual(["Prague", "Brno", "Budapest"]);
    expect(parseList(undefined)).toEqual([]);
  });

  it("keeps tokens unique, trimmed, and bounded", () => {
    expect(uniqueTokens([" TPM ", "tpm", "", "Head of validation"], 5)).toEqual(["TPM", "Head of validation"]);
    expect(uniqueTokens(["a", "b", "c"], 2)).toEqual(["a", "b"]);
  });

  it("normalises stored JSON defensively", () => {
    expect(normalizeLocations([{ city: "Prague", country: "cz", radiusKm: "40" }, { city: "", country: "CZ" }, { city: "Prague", country: "CZ" }])).toEqual([{ city: "Prague", country: "CZ", radiusKm: 40 }]);
    expect(normalizeRemote({ enabled: true, countries: ["cz", "XX1"], includeWorldwide: "yes" })).toEqual({ enabled: true, countries: ["CZ"], searchLocations: [], includeWorldwide: true, includeUnspecified: false });
    expect(normalizeRemoteSearchLocations([
      { city: " Prague ", country: "cz" },
      { city: "prague", countryCode: "CZ" },
      { city: "", country: "CZ" },
      { city: "Berlin", country: "DEU" },
    ])).toEqual([{ city: "Prague", country: "CZ" }]);
    expect(normalizeSchedule({ frequency: "weekly", time: "25:00", days: ["fri", "mon", "nope"], maxJobs: 500 })).toEqual({ enabled: false, frequency: "weekly", time: "09:00", days: ["mon"], maxJobs: 100 });
    expect(normalizeSchedule(null)).toEqual(DEFAULT_SEARCH_SETTINGS.schedule);
  });

  it("summarises the schedule for the activity screen", () => {
    expect(scheduleSummary({ enabled: false, frequency: "daily", time: "09:00", days: [], maxJobs: 15 }, "Europe/Prague")).toBe("Paused");
    expect(scheduleSummary({ enabled: true, frequency: "custom", time: "08:30", days: ["mon", "thu"], maxJobs: 15 }, "Europe/Prague")).toBe("Mon, Thu · 08:30 Prague");
  });

  it("builds one structured fit policy while excluding operational schedule fields", () => {
    const policy = effectiveSearchPolicy({
      ...DEFAULT_SEARCH_SETTINGS,
      minimumFitScore: 70,
      targetRoles: ["Technical programme manager"],
      languages: ["English"],
      locations: [{ city: "Prague", country: "CZ", radiusKm: 50 }],
      remote: { enabled: true, countries: ["CZ", "IL"], searchLocations: [{ city: "Brno", country: "CZ" }], includeWorldwide: true, includeUnspecified: false },
      notesMd: "Prefer safety-critical programmes.",
    });
    expect(policy).toMatchObject({
      schemaVersion: 1,
      minimumFitScore: 70,
      office: { locations: [{ city: "Prague", countryCode: "CZ", radiusKm: 50 }] },
      remote: {
        eligibleCountryCodes: ["CZ", "IL"],
        searchLocations: [{ city: "Brno", countryCode: "CZ" }],
        includeWorldwide: true,
        includeUnspecified: false,
      },
      additionalRequirements: { scope: "semantic_role_fit_only", values: ["Prefer safety-critical programmes."] },
    });
    expect(policy).not.toHaveProperty("schedule");
    expect(policy).not.toHaveProperty("followUpDays");
  });

  it("falls back to office locations for legacy remote settings without changing eligibility", () => {
    const settings = {
      ...DEFAULT_SEARCH_SETTINGS,
      locations: [
        { city: "Prague", country: "CZ", radiusKm: 50 },
        { city: "prague", country: "CZ", radiusKm: 10 },
      ],
      remote: normalizeRemote({
        enabled: true,
        countries: ["IL"],
        includeWorldwide: false,
        includeUnspecified: false,
      }),
    };

    expect(effectiveSearchPolicy(settings).remote).toEqual({
      enabled: true,
      eligibleCountryCodes: ["IL"],
      searchLocations: [{ city: "Prague", countryCode: "CZ" }],
      includeWorldwide: false,
      includeUnspecified: false,
    });
  });

});
