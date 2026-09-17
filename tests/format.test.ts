import { describe, expect, it } from "vitest";
import { fitBand, formatDate, makeDedupeKey, normalizeDedupePart, slugify } from "../src/lib/format";

describe("job normalization", () => {
  it("deduplicates cosmetic company and location differences", () => {
    expect(makeDedupeKey("Example GmbH", "Senior Program Manager", "Prague, Czechia"))
      .toBe(makeDedupeKey("Example", "Senior  Program Manager", "Prague–Central"));
  });

  it("normalizes accents and legal suffixes", () => {
    expect(normalizeDedupePart("Škoda Auto a.s.")).toBe("skoda auto");
    expect(slugify("R&D / Safety — Europe")).toBe("r-and-d-safety-europe");
  });
});

describe("presentation rules", () => {
  it("uses dd/mm/yyyy dates", () => expect(formatDate("2026-07-31T12:00:00Z")).toBe("31/07/2026"));
  it("maps the agreed fit bands", () => {
    expect(fitBand(80)).toBe("Apply now");
    expect(fitBand(60)).toBe("Worth a review");
    expect(fitBand(40)).toBe("Possible with caveats");
    expect(fitBand(39)).toBe("Low fit");
  });
});
