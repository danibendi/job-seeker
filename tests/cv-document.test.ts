import { describe, expect, it } from "vitest";
import { cvDocumentUrls, driveFileId, parseCvDocument } from "../src/lib/cv-document";

const sample = `## JANE DOE

Validation Technical Project Manager — ADAS  |  ISO 26262

jane@example.com   |   +420 123 456 789   |   linkedin.com/in/jane

## PROFILE

Program manager with ten years in safety-critical engineering.

## CORE COMPETENCIES

Functional Safety (ISO 26262): HARA, FMEA, FTA.

Test Environments: SIL / HIL / VIL.

## EXPERIENCE

Technical Program Manager — Functional Safety

Example Corp, Prague   |   Aug 2022 – Present

Lead validation-readiness execution for ADAS product lines.

Coordinate stakeholders to support SIVV activities.

Head of Engineering Group

Air Force   |   Jan 2021 – Aug 2022

Managed safety-critical projects from planning to delivery.

## EDUCATION

B.Sc. Materials Science — Technion (2009–2014)

## LANGUAGES

English (fluent) • Hebrew (native)`;

describe("CV document parser", () => {
  const blocks = parseCvDocument(sample);

  it("recognises the header block", () => {
    expect(blocks[0]).toMatchObject({ kind: "name", text: "JANE DOE" });
    expect(blocks[1]).toMatchObject({ kind: "headline" });
    expect(blocks[2]).toMatchObject({ kind: "contact" });
  });

  it("splits experience into titled entries with bullets", () => {
    const kinds = blocks.map((block) => block.kind);
    const experienceStart = blocks.findIndex((block) => block.kind === "section" && block.text === "EXPERIENCE");
    expect(kinds.slice(experienceStart + 1, experienceStart + 8)).toEqual([
      "entry-title", "entry-sub", "bullet", "bullet", "entry-title", "entry-sub", "bullet",
    ]);
  });

  it("labels competencies and keeps raw text for editing", () => {
    const competency = blocks.find((block) => block.kind === "competency");
    expect(competency).toMatchObject({ label: "Functional Safety (ISO 26262)", text: "HARA, FMEA, FTA." });
    for (const block of blocks) expect(sample).toContain(block.raw);
  });

  it("treats education and languages as list items", () => {
    const education = blocks.filter((block) => block.kind === "bullet" && /Technion/.test(block.text));
    expect(education).toHaveLength(1);
    expect(blocks.at(-1)).toMatchObject({ kind: "bullet", text: "English (fluent) • Hebrew (native)" });
  });
});

describe("driveFileId", () => {
  it("accepts share links, docs links, and bare ids", () => {
    expect(driveFileId("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing")).toBe("1AbCdEfGhIjKlMnOp");
    expect(driveFileId("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit")).toBe("1AbCdEfGhIjKlMnOp");
    expect(driveFileId("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp")).toBe("1AbCdEfGhIjKlMnOp");
    expect(driveFileId("1AbCdEfGhIjKlMnOp")).toBe("1AbCdEfGhIjKlMnOp");
  });
  it("rejects other hosts and junk", () => {
    expect(driveFileId("https://example.com/file/d/1AbCdEfGhIjKlMnOp/view")).toBeNull();
    expect(driveFileId("http://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view")).toBeNull();
    expect(driveFileId("short")).toBeNull();
    expect(cvDocumentUrls(null)).toBeNull();
    expect(cvDocumentUrls("1AbCdEfGhIjKlMnOp")?.preview).toBe("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/preview");
  });
});
