import { describe, expect, it } from "vitest";
import {
  buildTaskContextInstructions,
  buildLinkedinEvaluationContext,
  hermesMcpFormattedChars,
  presentTaskContext,
  readTaskContextSection,
  selectTaskContextStrategy,
  TASK_CONTEXT_FORMATTED_LIMIT_CHARS,
  TASK_CONTEXT_SAFE_RESPONSE_CHARS,
  taskContextNeedsRawLearning,
} from "../src/lib/agent-task-context";
import { DEFAULT_SEARCH_SETTINGS, effectiveSearchPolicy } from "../src/lib/settings";

const sections = [
  { key: "search_objective", contentMd: "Objective" },
  { key: "feedback_adjustments", contentMd: "Use the reviewed feedback digest." },
  { key: "cover_letter_library", contentMd: "Large writing library" },
  { key: "future_eligibility_rule", contentMd: "A future hard rule" },
];

describe("agent task context selection", () => {
  it("keeps historical prose only for explicit questions", () => {
    expect(selectTaskContextStrategy("search", sections)).toEqual([]);
    expect(selectTaskContextStrategy("linkedin_evaluate", sections)).toEqual([]);
    expect(selectTaskContextStrategy("question", sections)).toEqual(sections);
  });

  it("keeps raw learning out of operational search and evaluation context", () => {
    expect(taskContextNeedsRawLearning("search", sections)).toBe(false);
    expect(taskContextNeedsRawLearning("linkedin_evaluate", sections)).toBe(false);
    expect(taskContextNeedsRawLearning("search", [])).toBe(false);
    expect(taskContextNeedsRawLearning("question", sections)).toBe(true);
  });
});

describe("agent task context instructions", () => {
  it("gives a public-only search eligibility, batched schema, persistence and time-reserve guidance without LinkedIn prompts", () => {
    const instructions = buildTaskContextInstructions({ kind: "search", payload: { sources: ["public"] } });
    const text = instructions.join("\n");

    expect(text).not.toContain("LinkedIn");
    expect(text).toContain("effectivePolicy and policyHash");
    expect(text).toContain("location/language/role eligibility");
    expect(text).toContain("excludedKeywords");
    expect(text).toContain("company, role, language and location rules");
    expect(text).toContain("tool_describe");
    expect(text).toContain("one tool_describe call");
    expect(text).toContain("at least 60 seconds left");
    expect(text).toContain("save_job");
    expect(text).toContain("exact canonical vacancy page directly from the employer");
    expect(text).toContain("HTTP 200 full vacancy page");
    expect(text).toContain("cached tool responses");
    expect(text).toContain("call verify_public_source");
    expect(text).toContain("save promptly");
    expect(text).toContain("server_receipt_id and checked_at in source_verification");
    expect(text).toContain("direct_live_fetch");
    expect(text).toContain("server receipt independently establishes current HTTP 200");
    expect(text).toContain("recommended_cv_variant_id");
    expect(text).toContain("never invent an ID or rewrite CV facts");
    expect(text).toContain("does not replace its existing recommendation");
    expect(text).toContain("terminal completion handoff");
  });

  it("keeps durable scan guidance for LinkedIn and adds public guidance to a mixed search", () => {
    const linkedin = buildTaskContextInstructions({ kind: "search", payload: { sources: ["linkedin"] } }).join("\n");
    expect(linkedin).toContain("get_linkedin_scan_state");
    expect(linkedin).toContain("record detail completion separately");
    expect(linkedin).not.toContain("tool_describe");

    const mixed = buildTaskContextInstructions({ kind: "search", payload: { sources: ["linkedin", "public"] } }).join("\n");
    expect(mixed).toContain("get_linkedin_scan_state");
    expect(mixed).toContain("tool_describe");
    expect(mixed).toContain("save_job");
  });

  it("retains broader source instructions for questions and keeps evaluation instructions compact", () => {
    const question = buildTaskContextInstructions({ kind: "question", payload: {} }).join("\n");
    expect(question).toContain("For question: answer the request");
    expect(question).toContain("get_linkedin_scan_state");

    const evaluation = buildTaskContextInstructions({ kind: "linkedin_evaluate", payload: {} }).join("\n");
    expect(evaluation).toContain("complete stored snapshot");
    expect(evaluation).toContain("effectivePolicy");
    expect(evaluation).not.toContain("get_linkedin_scan_state");
    expect(evaluation).not.toContain("tool_describe");
  });
});

describe("compact LinkedIn evaluation context", () => {
  it.each([undefined, false])("prepares legacy closure metadata without altering source evidence or its hash (closed=%s)", (closed) => {
    const snapshot = { evidenceHash: "retained-hash", snapshotEvidence: { description: "Full description", closed, applicantMetadata: "24 applicants; LinkedIn states no longer accepting applications" } };
    const context = buildLinkedinEvaluationContext({
      candidateId: "synthetic-candidate", policyHash: "a".repeat(64),
      effectivePolicy: effectiveSearchPolicy(DEFAULT_SEARCH_SETTINGS), snapshot, cvVariants: [],
    });
    expect(context.snapshot).toEqual({ ...snapshot, snapshotEvidence: { ...snapshot.snapshotEvidence, closed: true } });
    expect(snapshot.snapshotEvidence.closed).toBe(closed);
  });

  it("does not interpret arbitrary description text as a provider closure signal", () => {
    const snapshot = { snapshotEvidence: { description: "Build software that displays 'no longer accepting applications' on filled vacancies.", applicantMetadata: "24 applicants" } };
    const context = buildLinkedinEvaluationContext({
      candidateId: "synthetic-candidate", policyHash: "a".repeat(64),
      effectivePolicy: effectiveSearchPolicy(DEFAULT_SEARCH_SETTINGS), snapshot, cvVariants: [],
    });
    expect(context.snapshot).toBe(snapshot);
  });

  it("contains the complete snapshot, one factual CV and only short metadata for alternatives", () => {
    const snapshot = { id: "snapshot-1", snapshotEvidence: { description: "Complete stored vacancy text" } };
    const context = buildLinkedinEvaluationContext({
      candidateId: "synthetic-candidate",
      policyHash: "a".repeat(64),
      effectivePolicy: effectiveSearchPolicy({ ...DEFAULT_SEARCH_SETTINGS, locations: [{ city: "Prague", country: "CZ", radiusKm: 50 }] }),
      snapshot,
      cvVariants: [
        { id: "adas-id", slug: "adas", name: "ADAS", summary: "Safety-critical and ADAS roles", contentMd: "Alternative private CV body must stay out" },
        { id: "general-id", slug: "v3-general-tpm", name: "General TPM", summary: "Broad technical programme leadership", contentMd: "Full factual experience profile" },
      ],
    });
    expect(context.schemaVersion).toBe(1);
    expect(context.snapshot).toBe(snapshot);
    expect(context.effectivePolicy.office.locations[0]).toEqual({ city: "Prague", countryCode: "CZ", radiusKm: 50 });
    expect(context.candidate.factualProfile).toEqual({ sourceCvVariantId: "general-id", contentMd: "Full factual experience profile" });
    expect(context.candidate.cvVariants).toEqual([
      { id: "adas-id", name: "ADAS", purpose: "Safety-critical and ADAS roles" },
      { id: "general-id", name: "General TPM", purpose: "Broad technical programme leadership" },
    ]);
    expect(JSON.stringify(context)).not.toContain("Alternative private CV body");
    expect(context).not.toHaveProperty("strategy");
    expect(context).not.toHaveProperty("instructions");
  });
});

describe("large task context sections", () => {
  type TestContext = {
    task: Record<string, unknown>;
    request: unknown;
    snapshot: unknown;
    serverNowUtc: string;
    settings: unknown;
    policyHash: string;
    strategy: unknown[];
    cvs: unknown[];
    learning: unknown[];
    relatedJobs: unknown[];
    instructions: string[];
  };

  const base: TestContext = {
    task: { id: "task-1", kind: "question", attemptCount: 1, payload: {}, checkpoint: {}, leaseExpiresAt: "soon", updatedAt: "now" },
    request: { id: "request-1", text: "Compare relevant evidence" },
    snapshot: null,
    serverNowUtc: "2026-09-14T12:00:00.000Z",
    settings: { minimumFitScore: 60, targetRoles: ["Technical Program Manager"] },
    policyHash: "a".repeat(64),
    strategy: [],
    cvs: [],
    learning: [],
    relatedJobs: [],
    instructions: ["Use every applicable source."],
  };

  function sectioned(context: TestContext) {
    const result = presentTaskContext(context);
    expect(result).toHaveProperty("context_mode", "sectioned");
    return result as Exclude<typeof result, typeof context> & { context_mode: "sectioned" };
  }

  function readWhole(context: TestContext, version: string, section: "strategy" | "cvs" | "related_jobs" | "snapshot") {
    const chunks: string[] = [];
    let cursor: number | undefined;
    do {
      const result = readTaskContextSection(context, {
        context_version: version,
        section,
        ...(section === "snapshot" ? {} : { whole_section: true }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(result.context_mode).toBe("section_chunk");
      expect(hermesMcpFormattedChars(result)).toBeLessThanOrEqual(TASK_CONTEXT_SAFE_RESPONSE_CHARS);
      if (result.context_mode !== "section_chunk") throw new Error("Expected a section chunk");
      chunks.push(result.data_json_chunk);
      cursor = result.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return JSON.parse(chunks.join(""));
  }

  it("keeps ordinary public context shape-compatible", () => {
    const context = {
      ...base,
      strategy: [{ key: "operative", contentMd: "s".repeat(20_000) }],
      cvs: [{ id: "cv-1", name: "CV", contentMd: "c".repeat(20_000) }],
    };
    const result = presentTaskContext(context);
    expect(result).toBe(context);
    expect(hermesMcpFormattedChars(result)).toBeLessThan(TASK_CONTEXT_FORMATTED_LIMIT_CHARS);
  });

  it("indexes and losslessly chunks a retained-size 13-section question", () => {
    // Exact section keys and serialized-size scale from the retained production
    // corpus; contents remain synthetic so private strategy/CV text is not put
    // in a test fixture.
    const retainedSectionSizes = [
      ["search_objective", 4023], ["calibration_search_lanes", 2629], ["search_scope_authorization", 1518],
      ["target_tiers", 10778], ["positioning", 2987], ["search_channels", 1834], ["feedback_adjustments", 1593],
      ["full_strategy_source", 29577], ["cover_letter_library", 19740], ["outreach_message_library", 17227],
      ["cv_style_references", 913], ["consulting_aviation_cv_source", 4498], ["source_document_inventory", 2465],
    ] as const;
    const context = {
      ...base,
      strategy: retainedSectionSizes.map(([key, size]) => ({ key, contentMd: "s".repeat(size) })),
      cvs: [0, 1, 2].map((index) => ({ id: `cv-${index}`, name: `CV ${index}`, contentMd: "private CV evidence ".repeat(500) })),
      relatedJobs: Array.from({ length: 600 }, (_, index) => ({ job: { id: `job-${index}`, title: `Job ${index}`, status: "sourced" }, company: `Company ${index}` })),
    };
    const manifest = sectioned(context);
    expect(hermesMcpFormattedChars(manifest)).toBeLessThan(TASK_CONTEXT_FORMATTED_LIMIT_CHARS);

    const firstIndex = readTaskContextSection(context, { context_version: manifest.context_version, section: "related_jobs" });
    expect(firstIndex.context_mode).toBe("section_index");
    expect(hermesMcpFormattedChars(firstIndex)).toBeLessThanOrEqual(TASK_CONTEXT_SAFE_RESPONSE_CHARS);
    if (firstIndex.context_mode !== "section_index") throw new Error("Expected a section index");
    expect(firstIndex.complete).toBe(false);
    expect(firstIndex.next_cursor).toBe(250);
    expect(firstIndex.items[0].item_ref).toEqual({ id: "job-0", title: "Job 0", company: "Company 0", status: "sourced" });

    expect(readWhole(context, manifest.context_version, "strategy")).toEqual(context.strategy);
    expect(readWhole(context, manifest.context_version, "cvs")).toEqual(context.cvs);
  });

  it("losslessly chunks a permitted 100k LinkedIn description with adversarial escaping", () => {
    const context = {
      ...base,
      task: { ...base.task, kind: "linkedin_evaluate" },
      snapshot: {
        id: "snapshot-1",
        snapshotEvidence: {
          description: "\\\"🙂\n".repeat(20_000).slice(0, 100_000),
          nested: { source: "direct", complete: true },
        },
      },
    };
    const manifest = sectioned(context);
    expect(readWhole(context, manifest.context_version, "snapshot")).toEqual(context.snapshot);
  });

  it("rejects mixed content versions but ignores lease heartbeat timestamps", () => {
    const context = { ...base, strategy: [{ key: "large", contentMd: "x".repeat(100_000) }] };
    const manifest = sectioned(context);
    const renewed = { ...context, task: { ...context.task, leaseExpiresAt: "later", updatedAt: "later" } };
    expect(() => readTaskContextSection(renewed, { context_version: manifest.context_version, section: "core" })).not.toThrow();
    const changed = { ...context, strategy: [{ key: "large", contentMd: `changed${"x".repeat(100_000)}` }] };
    expect(() => readTaskContextSection(changed, { context_version: manifest.context_version, section: "core" })).toThrow("Task context changed");
  });
});
