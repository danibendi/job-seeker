import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agentTasks, companies, cvVariants, jobs, linkedinSnapshots } from "../src/db/schema";
import { discoveredJobSchema, finishLinkedinEvaluation, linkedinPromotionEvidenceIssue, publicDiscoveredJobSchema, saveDiscoveredJob, type LinkedinEvaluationCompletion, type TaskRow, type TaskTx } from "../src/lib/task-capabilities";
import { effectiveSearchPolicy, DEFAULT_SEARCH_SETTINGS } from "../src/lib/settings";

const { policy } = vi.hoisted(() => ({ policy: vi.fn(async () => ({
  policyHash: "a".repeat(64),
  settings: { minimumFitScore: 70, excludedCompanies: [], remote: { enabled: true }, workModes: ["hybrid", "onsite"], schedule: { maxJobs: 10 } },
  effectivePolicy: { languages: { accepted: ["English", "Russian"] } },
})) }));
vi.mock("@/lib/linkedin-store", () => ({ linkedinPolicy: policy }));

const cvId = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const now = new Date();
  const taskId = "22222222-2222-4222-8222-222222222222";
  const receiptId = "33333333-3333-4333-8333-333333333333";
  const url = "https://employer.example/jobs/engineer";
  const receipt = { receipt_id: receiptId, authority: "server_direct_fetch", task_id: taskId, attempt: 2, initial_url: url, final_url: url, checked_at: now.toISOString(), http_status: 200, content_type: "text/html", body_sha256: "b".repeat(64), body_bytes: 10_000, expected_title: "Engineer", expected_company: "Synthetic Employer", static_html_vacancy_shaped: true, soft_closed: false, title_matched: true, company_matched: true, apply_signal: true, vacancy_section_signal_count: 3 };
  const task = { id: taskId, kind: "search", executor: "hermes", attemptCount: 2, payload: { sources: ["public"] }, checkpoint: { _server: { publicSourceReceipts: { [receiptId]: receipt } } }, startedAt: new Date(now.getTime() - 1000) } as unknown as TaskRow;
  const input = publicDiscoveredJobSchema.parse({ company: "Synthetic Employer", title: "Engineer", url, source: "employer", work_mode: "remote", description_md: "Complete synthetic vacancy", fit_score: 79, fit_analysis_md: "Synthetic fit rationale", policy_hash: "a".repeat(64), policy_evidence: { location_eligible: true, language_eligible: true, role_eligible: true, exclusions_clear: true, explanation: "Synthetic policy eligibility explanation" }, source_verification: { server_receipt_id: receiptId, retrieval_method: "direct_live_fetch", checked_at: now.toISOString(), direct_employer_url: url, http_status: 200, direct_employer: true, full_vacancy_page: true, vacancy_open: true, closing_date: null, evidence_summary: "Full employer vacancy remains open for applications" } });
  return { task, input };
}

function database({ known = false, cvExists = true } = {}) {
  const writes: { table: unknown; value: Record<string, unknown> }[] = [];
  const selected: unknown[] = [];
  const tx = {
    execute: vi.fn(async () => undefined),
    select: () => ({ from: (table: unknown) => {
      selected.push(table);
      const rows = table === jobs ? (known ? [{ id: "existing", recommendedCvVariantId: "owner-selected" }] : [])
        : table === cvVariants ? (cvExists ? [{ id: cvId }] : [])
        : table === companies ? [{ id: "company", name: "Synthetic Employer" }]
        : table === activityLog ? [{ total: 0 }] : [];
      return { where: () => ({ limit: async () => rows, then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve) }) };
    } }),
    insert: (table: unknown) => ({ values: (value: Record<string, unknown>) => {
      writes.push({ table, value });
      return { returning: async () => [{ id: "new-job" }] };
    } }),
  };
  return { tx: tx as unknown as TaskTx, writes, selected };
}

function evaluationDatabase(snapshot: Record<string, unknown>) {
  const writes: { table: unknown; value: Record<string, unknown> }[] = [];
  const updates: { table: unknown; value: Record<string, unknown> }[] = [];
  const tx = {
    select: () => ({ from: (table: unknown) => {
      if (table !== linkedinSnapshots) throw new Error("Unexpected evaluation select");
      return { where: () => ({ for: () => ({ limit: async () => [snapshot] }) }) };
    } }),
    update: (table: unknown) => ({ set: (value: Record<string, unknown>) => {
      updates.push({ table, value });
      return { where: async () => undefined };
    } }),
    insert: (table: unknown) => ({ values: async (value: Record<string, unknown>) => { writes.push({ table, value }); } }),
  };
  return { tx: tx as unknown as TaskTx, writes, updates };
}

function linkedinEvaluationFixture(options: { closed?: boolean; requiredLanguage?: string } = {}) {
  const snapshotId = "44444444-4444-4444-8444-444444444444";
  const description = options.requiredLanguage
    ? `This hybrid role is based in Prague, Czechia. ${options.requiredLanguage} is required.`
    : "This hybrid role is based in Prague, Czechia.";
  const sourceFacts = {
    work_mode: "hybrid" as const,
    work_mode_quote: "hybrid role",
    location: { raw: "Prague, Czechia", city: "Prague", country_code: "CZ", evidence_quote: "Prague, Czechia" },
    remote_eligibility: { scope: "unspecified" as const, eligible_country_codes: [], evidence_quote: null },
    language_requirements: options.requiredLanguage ? [{ language: options.requiredLanguage, required: true, evidence_quote: `${options.requiredLanguage} is required` }] : [],
  };
  const policyEvidence = { location_eligible: true as const, language_eligible: true as const, role_eligible: true as const, exclusions_clear: true as const, explanation: "The evaluator asserted every configured policy gate from stored evidence." };
  const job = discoveredJobSchema.parse({
    company: "Synthetic Employer", title: "Programme Manager", url: "https://www.linkedin.com/jobs/view/123456789/", source: "linkedin",
    location: "Prague, Czechia", work_mode: "hybrid", description_md: description, fit_score: 90, fit_analysis_md: "Strong synthetic fit.",
    policy_hash: "a".repeat(64), policy_evidence: policyEvidence, source_facts: sourceFacts,
  });
  const evaluation = { fit_score: 90, policy_evidence: policyEvidence, source_facts: sourceFacts };
  const input = { policy_hash: "a".repeat(64), status: "promoted", reason: "The role passes every policy gate.", evaluation, job } satisfies LinkedinEvaluationCompletion;
  const task = { id: "22222222-2222-4222-8222-222222222222", snapshotId, kind: "linkedin_evaluate", executor: "hermes", attemptCount: 1, payload: {}, checkpoint: {}, startedAt: new Date() } as unknown as TaskRow;
  const snapshot = { id: snapshotId, state: "snapshot_ready", canonicalUrl: job.url, company: job.company, title: job.title, location: job.location, workModeText: "Hybrid", compactEvidence: {}, snapshotEvidence: { description, closed: options.closed === true }, evidenceHash: "b".repeat(64), detailDecision: null, promotedJobId: null };
  return { task, input, snapshot };
}

beforeEach(() => policy.mockClear());

describe("actual source admission", () => {
  it("blocks evidenced Israel office roles under the Prague policy and holds unverified radius cases", () => {
    const effectivePolicy = effectiveSearchPolicy({
      ...DEFAULT_SEARCH_SETTINGS,
      locations: [{ city: "Prague", country: "CZ", radiusKm: 50 }],
      workModes: ["onsite", "hybrid"],
      remote: { enabled: true, countries: ["CZ", "IL"], includeWorldwide: true, includeUnspecified: false },
    });
    const base = discoveredJobSchema.parse({
      company: "Synthetic Employer", title: "Programme Manager", url: "https://www.linkedin.com/jobs/view/123456789/", source: "linkedin",
      location: "Holon, Israel", work_mode: "onsite", description_md: "This position is on-site in Holon, Israel.", fit_score: 90,
      fit_analysis_md: "Strong synthetic fit.", policy_hash: "a".repeat(64),
      policy_evidence: { location_eligible: true, language_eligible: true, role_eligible: true, exclusions_clear: true, explanation: "All policy gates were asserted by the evaluator." },
      source_facts: { work_mode: "onsite", work_mode_quote: "On-site", location: { raw: "Holon, Israel", city: "Holon", country_code: "IL", evidence_quote: "Holon, Israel" }, remote_eligibility: { scope: "unspecified", eligible_country_codes: [], evidence_quote: null }, language_requirements: [] },
    });
    const holon = { title: base.title, company: base.company, location: "Holon, Israel", workModeText: "On-site", compactEvidence: {}, snapshotEvidence: { description: base.description_md } } as never;
    expect(linkedinPromotionEvidenceIssue(base, holon, effectivePolicy)).toBe("Office country is outside the configured geography");

    const pragueInput = { ...base, location: "Prague, Czechia", source_facts: { ...base.source_facts!, location: { raw: "Prague, Czechia", city: "Prague", country_code: "CZ", evidence_quote: "Prague, Czechia" } } };
    const prague = { title: base.title, company: base.company, location: "Prague, Czechia", workModeText: "On-site", compactEvidence: {}, snapshotEvidence: { description: "This position is on-site in Prague, Czechia." } } as never;
    expect(linkedinPromotionEvidenceIssue(pragueInput, prague, effectivePolicy)).toBeNull();

    const nearbyInput = { ...pragueInput, location: "Kladno, Czechia", source_facts: { ...pragueInput.source_facts, location: { raw: "Kladno, Czechia", city: "Kladno", country_code: "CZ", evidence_quote: "Kladno, Czechia" } } };
    const nearby = { title: base.title, company: base.company, location: "Kladno, Czechia", workModeText: "On-site", compactEvidence: {}, snapshotEvidence: { description: "This position is on-site in Kladno, Czechia." } } as never;
    expect(linkedinPromotionEvidenceIssue(nearbyInput, nearby, effectivePolicy)).toContain("distance");
  });

  it("requires source quotes for structured work-mode and location facts", () => {
    const effectivePolicy = effectiveSearchPolicy({ ...DEFAULT_SEARCH_SETTINGS, locations: [{ city: "Prague", country: "CZ", radiusKm: 50 }] });
    const input = discoveredJobSchema.parse({
      company: "Synthetic Employer", title: "Programme Manager", url: "https://www.linkedin.com/jobs/view/123456789/", source: "linkedin",
      location: "Prague, Czechia", work_mode: "hybrid", description_md: "Role based in Prague.", fit_score: 90, fit_analysis_md: "Strong synthetic fit.", policy_hash: "a".repeat(64),
      policy_evidence: { location_eligible: true, language_eligible: true, role_eligible: true, exclusions_clear: true, explanation: "All policy gates were asserted by the evaluator." },
      source_facts: { work_mode: "hybrid", work_mode_quote: "Hybrid work", location: { raw: "Prague, Czechia", city: "Prague", country_code: "CZ", evidence_quote: "Prague, Czechia" }, remote_eligibility: { scope: "unspecified", eligible_country_codes: [], evidence_quote: null }, language_requirements: [] },
    });
    const snapshot = { title: input.title, company: input.company, location: input.location, workModeText: null, compactEvidence: {}, snapshotEvidence: { description: input.description_md } } as never;
    expect(linkedinPromotionEvidenceIssue(input, snapshot, effectivePolicy)).toContain("work mode");
  });

  it("enforces remote country and unspecified-location policy independently of office geography", () => {
    const effectivePolicy = effectiveSearchPolicy({
      ...DEFAULT_SEARCH_SETTINGS,
      locations: [{ city: "Prague", country: "CZ", radiusKm: 50 }],
      remote: { enabled: true, countries: ["CZ", "IL"], includeWorldwide: false, includeUnspecified: false },
    });
    const input = discoveredJobSchema.parse({
      company: "Synthetic Employer", title: "Programme Manager", url: "https://www.linkedin.com/jobs/view/123456789/", source: "linkedin",
      location: "Israel", work_mode: "remote", description_md: "This is a remote role available in Israel.", fit_score: 90, fit_analysis_md: "Strong synthetic fit.", policy_hash: "a".repeat(64),
      policy_evidence: { location_eligible: true, language_eligible: true, role_eligible: true, exclusions_clear: true, explanation: "All policy gates were asserted by the evaluator." },
      source_facts: { work_mode: "remote", work_mode_quote: "remote role", location: { raw: "Israel", city: null, country_code: "IL", evidence_quote: "Israel" }, remote_eligibility: { scope: "countries", eligible_country_codes: ["IL"], evidence_quote: "available in Israel" }, language_requirements: [] },
    });
    const israel = { title: input.title, company: input.company, location: "Israel", workModeText: "Remote", compactEvidence: {}, snapshotEvidence: { description: input.description_md } } as never;
    expect(linkedinPromotionEvidenceIssue(input, israel, effectivePolicy)).toBeNull();

    const euInput = { ...input, location: "European Union", source_facts: { ...input.source_facts!, location: { raw: "European Union", city: null, country_code: null, evidence_quote: "European Union" }, remote_eligibility: { scope: "countries" as const, eligible_country_codes: ["DE", "CZ"], evidence_quote: "European Union" } } };
    const eu = { title: input.title, company: input.company, location: "European Union", workModeText: "Remote", compactEvidence: {}, snapshotEvidence: { description: "This remote role is open throughout the European Union." } } as never;
    expect(linkedinPromotionEvidenceIssue(euInput, eu, effectivePolicy)).toBeNull();

    const usInput = { ...input, location: "United States", source_facts: { ...input.source_facts!, location: { raw: "United States", city: null, country_code: "US", evidence_quote: "United States" }, remote_eligibility: { scope: "countries" as const, eligible_country_codes: ["US"], evidence_quote: "United States only" } } };
    const us = { title: input.title, company: input.company, location: "United States", workModeText: "Remote", compactEvidence: {}, snapshotEvidence: { description: "This remote role is available in the United States only." } } as never;
    expect(linkedinPromotionEvidenceIssue(usInput, us, { ...effectivePolicy, remote: { ...effectivePolicy.remote, includeWorldwide: true } })).toContain("Remote countries");

    const worldwideInput = { ...input, location: "Worldwide", source_facts: { ...input.source_facts!, location: { raw: "Worldwide", city: null, country_code: null, evidence_quote: "Worldwide" }, remote_eligibility: { scope: "worldwide" as const, eligible_country_codes: [], evidence_quote: "available worldwide" } } };
    const worldwide = { title: input.title, company: input.company, location: "Worldwide", workModeText: "Remote", compactEvidence: {}, snapshotEvidence: { description: "This remote role is available worldwide." } } as never;
    expect(linkedinPromotionEvidenceIssue(worldwideInput, worldwide, { ...effectivePolicy, remote: { ...effectivePolicy.remote, includeWorldwide: true } })).toBeNull();

    const unspecifiedInput = { ...input, location: "Remote", source_facts: { ...input.source_facts!, location: { raw: "Remote", city: null, country_code: null, evidence_quote: "Remote" }, remote_eligibility: { scope: "unspecified" as const, eligible_country_codes: [], evidence_quote: null } } };
    const unspecified = { title: input.title, company: input.company, location: "Remote", workModeText: "Remote", compactEvidence: {}, snapshotEvidence: { description: "This is a remote role." } } as never;
    expect(linkedinPromotionEvidenceIssue(unspecifiedInput, unspecified, effectivePolicy)).toContain("unspecified");
  });

  it("rejects absent, cached, 404 and expired source evidence before database admission", async () => {
    const { task, input } = fixture();
    expect(publicDiscoveredJobSchema.safeParse(discoveredJobSchema.parse(input)).success).toBe(false);
    for (const evidence of [undefined, { ...input.source_verification, retrieval_method: "cached_snippet" }, { ...input.source_verification, http_status: 404 }, { ...input.source_verification, closing_date: "2026-08-12" }]) {
      const db = database();
      await expect(saveDiscoveredJob(task, { ...input, source_verification: evidence } as typeof input, db.tx)).rejects.toThrow();
      expect(db.writes).toEqual([]);
      expect(db.selected).toEqual([]);
    }
    expect(policy).not.toHaveBeenCalled();
  });

  it.each([
    { closed: true },
    { applicantMetadata: "24 applicants; LinkedIn states no longer accepting applications" },
    { closed: false, applicantMetadata: "No longer accepting applications" },
  ])("rejects explicitly closed LinkedIn evidence before any policy or admission write: %j", async (snapshotEvidence) => {
    const { task, input } = fixture();
    const db = database();
    const snapshot = { canonicalUrl: input.url, company: input.company, title: input.title, snapshotEvidence };
    await expect(saveDiscoveredJob({ ...task, kind: "linkedin_evaluate" }, input, db.tx, snapshot as never)).rejects.toThrow(/vacancy closed/);
    expect(db.writes).toEqual([]);
    expect(policy).not.toHaveBeenCalled();
  });

  it.each([
    { closed: true },
    { applicantMetadata: "24 applicants; LinkedIn states no longer accepting applications" },
    { closed: false, applicantMetadata: "No longer accepting applications" },
  ])("terminalizes a submitted promotion when the complete snapshot marks the vacancy closed: %j", async (availability) => {
    const { task, input, snapshot } = linkedinEvaluationFixture({ closed: true });
    snapshot.snapshotEvidence = { description: snapshot.snapshotEvidence.description, ...availability } as typeof snapshot.snapshotEvidence;
    const db = evaluationDatabase(snapshot);
    await expect(finishLinkedinEvaluation(task, input, db.tx)).resolves.toEqual({ outcome: "completed", state: "rejected", job_id: null });
    const savedSnapshot = db.updates.find((write) => write.table === linkedinSnapshots)?.value;
    expect(savedSnapshot).toMatchObject({
      state: "rejected",
      promotedJobId: null,
      completionReason: expect.stringContaining("vacancy closed"),
      detailDecision: { evaluation: { policy_evidence: { location_eligible: true, language_eligible: true, role_eligible: true, exclusions_clear: false } } },
    });
    expect(db.updates.some((write) => write.table === agentTasks)).toBe(true);
    expect(db.writes.find((write) => write.table === activityLog)?.value.payload).toMatchObject({ submittedStatus: "promoted", reason: expect.stringContaining("vacancy closed") });
    expect(db.writes.some((write) => write.table === jobs || write.table === companies)).toBe(false);
  });

  it("attributes quoted unsupported-language evidence to the language gate", async () => {
    const { task, input, snapshot } = linkedinEvaluationFixture({ requiredLanguage: "Czech" });
    const db = evaluationDatabase(snapshot);
    await expect(finishLinkedinEvaluation(task, input, db.tx)).resolves.toEqual({ outcome: "completed", state: "rejected", job_id: null });
    const savedEvaluation = (db.updates.find((write) => write.table === linkedinSnapshots)?.value.detailDecision as { evaluation: LinkedinEvaluationCompletion["evaluation"] }).evaluation;
    expect(savedEvaluation.policy_evidence).toMatchObject({ location_eligible: true, language_eligible: false, role_eligible: true, exclusions_clear: true });
    expect(db.writes.some((write) => write.table === jobs || write.table === companies)).toBe(false);
  });

  it("stores the server receipt, worker attestation and an explicitly selected existing CV", async () => {
    const { task, input } = fixture();
    const db = database();
    expect(await saveDiscoveredJob(task, { ...input, recommended_cv_variant_id: cvId }, db.tx)).toEqual({ job_id: "new-job", outcome: "created" });
    expect(db.writes.find(write => write.table === jobs)?.value.recommendedCvVariantId).toBe(cvId);
    const payload = db.writes.find(write => write.table === activityLog)?.value.payload;
    expect(payload).toMatchObject({ sourceVerification: input.source_verification, sourceVerificationAuthority: "server_direct_fetch", serverSourceReceipt: { receipt_id: input.source_verification.server_receipt_id, authority: "server_direct_fetch" } });
  });

  it("rejects an unknown CV and never replaces an existing job's selection", async () => {
    const { task, input } = fixture();
    const invalid = database({ cvExists: false });
    await expect(saveDiscoveredJob(task, { ...input, recommended_cv_variant_id: cvId }, invalid.tx)).rejects.toThrow(/CV variant does not exist/);
    expect(invalid.writes).toEqual([]);
    const existing = database({ known: true });
    expect(await saveDiscoveredJob(task, { ...input, recommended_cv_variant_id: cvId }, existing.tx)).toEqual({ job_id: "existing", outcome: "already_known" });
    expect(existing.writes).toEqual([]);
    expect(existing.selected).not.toContain(cvVariants);
  });

  it("does not invent a CV recommendation when one is omitted", async () => {
    const { task, input } = fixture();
    const db = database();
    await saveDiscoveredJob(task, input, db.tx);
    expect(db.writes.find(write => write.table === jobs)?.value.recommendedCvVariantId).toBeUndefined();
    expect(db.selected).not.toContain(cvVariants);
  });
});
