import "server-only";
import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { activityLog, agentTasks, companies, cvVariants, feedback, jobs, linkedinSnapshots, requests, strategySections } from "@/db/schema";
import { companyDisplayName, companyDisplayNameFitsStorage, companySlugCandidates, normalizeCompanyIdentity } from "@/lib/company-identity";
import { sha256OpaqueToken, stableJsonHash } from "@/lib/agent-task-contract";
import { buildLinkedinEvaluationContext, buildTaskContextInstructions, presentTaskContext, readTaskContextSection, selectTaskContextStrategy, taskContextNeedsRawLearning, type TaskContextSectionName } from "@/lib/agent-task-context";
import { makeDedupeKey } from "@/lib/format";
import { linkedinPolicy } from "@/lib/linkedin-store";
import { linkedinSnapshotIsClosed } from "@/lib/linkedin-availability";
import { trustedPublicSourceReceiptSchema, type TrustedPublicSourceReceipt } from "@/lib/public-source-fetch";
import { publicSourceVerificationIssue, publicSourceVerificationSchema, trustedPublicSourceReceiptIssue } from "@/lib/public-source-verification";
import { WorkerHttpError } from "@/lib/worker-auth";
import { publicAgentTask } from "@/lib/worker-tasks";

export type TaskTx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];
export type TaskRow = typeof agentTasks.$inferSelect;
export type TaskPrincipal = { token: string };
export const taskIdentitySchema = z.object({ task_id: z.uuid(), attempt: z.number().int().min(1), execution_ref: z.string().min(1).max(500).optional() });

const nullableEvidenceQuote = z.string().min(1).max(2_000).nullable();
export const evaluationSourceFactsSchema = z.object({
  work_mode: z.enum(["onsite", "hybrid", "remote", "unknown"]),
  work_mode_quote: nullableEvidenceQuote,
  location: z.object({
    raw: z.string().min(1).max(1_000).nullable(),
    city: z.string().min(1).max(160).nullable(),
    country_code: z.string().regex(/^[A-Z]{2}$/).nullable(),
    evidence_quote: nullableEvidenceQuote,
  }),
  remote_eligibility: z.object({
    scope: z.enum(["countries", "worldwide", "unspecified"]),
    eligible_country_codes: z.array(z.string().regex(/^[A-Z]{2}$/)).max(30),
    evidence_quote: nullableEvidenceQuote,
  }),
  language_requirements: z.array(z.object({
    language: z.string().min(1).max(120),
    required: z.boolean(),
    evidence_quote: z.string().min(1).max(2_000),
  })).max(20),
});

export const evaluationPolicyEvidenceSchema = z.object({
  location_eligible: z.boolean().nullable(),
  language_eligible: z.boolean().nullable(),
  role_eligible: z.boolean().nullable(),
  exclusions_clear: z.boolean().nullable(),
  explanation: z.string().min(20).max(10_000),
});

export const linkedinEvaluationSchema = z.object({
  fit_score: z.number().int().min(0).max(100),
  policy_evidence: evaluationPolicyEvidenceSchema,
  source_facts: evaluationSourceFactsSchema,
});

export async function withTask<T>(identity: z.infer<typeof taskIdentitySchema>, principal: TaskPrincipal, fn: (task: TaskRow, tx: TaskTx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    const [task] = await tx.select().from(agentTasks).where(and(
      eq(agentTasks.id, identity.task_id), eq(agentTasks.attemptCount, identity.attempt), eq(agentTasks.status, "running"), gt(agentTasks.leaseExpiresAt, new Date()),
      eq(agentTasks.claimTokenHash, sha256OpaqueToken(principal.token)),
    )).for("update").limit(1);
    if (!task) throw new WorkerHttpError("Task claim is invalid or expired", 403);
    return fn(task, tx);
  });
}

export async function authorizeTaskClaim(identity: z.infer<typeof taskIdentitySchema>, principal: TaskPrincipal) {
  const [task] = await getDb().select().from(agentTasks).where(and(
    eq(agentTasks.id, identity.task_id), eq(agentTasks.attemptCount, identity.attempt), eq(agentTasks.status, "running"), gt(agentTasks.leaseExpiresAt, new Date()),
    eq(agentTasks.claimTokenHash, sha256OpaqueToken(principal.token)),
  )).limit(1);
  if (!task) throw new WorkerHttpError("Task claim is invalid or expired", 403);
  return task;
}

function publicSourceReceipts(task: TaskRow) {
  const serverState = task.checkpoint._server;
  if (!serverState || typeof serverState !== "object" || Array.isArray(serverState)) return {};
  const receipts = (serverState as Record<string, unknown>).publicSourceReceipts;
  if (!receipts || typeof receipts !== "object" || Array.isArray(receipts)) return {};
  return receipts as Record<string, unknown>;
}

export async function storePublicSourceReceipt(task: TaskRow, receipt: TrustedPublicSourceReceipt, tx: TaskTx) {
  requireTaskKind(task, ["search"]);
  if (!Array.isArray(task.payload.sources) || !task.payload.sources.includes("public")) throw new WorkerHttpError("Public search is not enabled for this task", 403);
  const parsed = trustedPublicSourceReceiptSchema.parse(receipt);
  if (parsed.task_id !== task.id || parsed.attempt !== task.attemptCount) throw new WorkerHttpError("Server source receipt belongs to another task attempt", 400);
  const serverState = task.checkpoint._server && typeof task.checkpoint._server === "object" && !Array.isArray(task.checkpoint._server)
    ? task.checkpoint._server as Record<string, unknown>
    : {};
  const existing = Object.entries(publicSourceReceipts(task))
    .filter(([id, value]) => id !== parsed.receipt_id && trustedPublicSourceReceiptSchema.safeParse(value).success)
    .sort(([, left], [, right]) => String((left as Record<string, unknown>).checked_at).localeCompare(String((right as Record<string, unknown>).checked_at)))
    .slice(-9);
  const receipts = Object.fromEntries([...existing, [parsed.receipt_id, parsed]]);
  await tx.update(agentTasks).set({ checkpoint: { ...task.checkpoint, _server: { ...serverState, publicSourceReceipts: receipts } }, updatedAt: new Date() }).where(eq(agentTasks.id, task.id));
  return {
    server_receipt_id: parsed.receipt_id,
    authority: parsed.authority,
    checked_at: parsed.checked_at,
    initial_url: parsed.initial_url,
    final_url: parsed.final_url,
    http_status: parsed.http_status,
    static_html_vacancy_shaped: parsed.static_html_vacancy_shaped,
    body_sha256: parsed.body_sha256,
  };
}

export function requireTaskKind(task: TaskRow, kinds: TaskRow["kind"][]) {
  if (!kinds.includes(task.kind)) throw new WorkerHttpError("Capability is not available for this task kind", 403);
}

async function loadTaskContext(task: TaskRow, tx: TaskTx) {
  const serverNowUtc = new Date().toISOString();
  const policy = await linkedinPolicy(tx);
  if (task.kind === "linkedin_evaluate") {
    const [snapshot] = task.snapshotId
      ? await tx.select().from(linkedinSnapshots).where(eq(linkedinSnapshots.id, task.snapshotId)).limit(1)
      : [];
    const variants = await tx.select({ id: cvVariants.id, slug: cvVariants.slug, name: cvVariants.name, summary: cvVariants.summary, contentMd: cvVariants.contentMd }).from(cvVariants);
    return {
      task: publicAgentTask(task),
      serverNowUtc,
      evaluationContext: buildLinkedinEvaluationContext({
        candidateId: String(task.payload.candidateId ?? ""),
        policyHash: policy.policyHash,
        effectivePolicy: policy.effectivePolicy,
        snapshot: snapshot ?? null,
        cvVariants: variants,
      }),
    };
  }
  const allStrategy = await tx.select().from(strategySections).orderBy(strategySections.sort);
  const strategy = selectTaskContextStrategy(task.kind, allStrategy);
  const cvs = await tx.select({ id: cvVariants.id, name: cvVariants.name, contentMd: cvVariants.contentMd, version: cvVariants.version }).from(cvVariants);
  const learning = taskContextNeedsRawLearning(task.kind, strategy)
    ? await tx.select({ verdict: feedback.verdict, reasons: feedback.reasons, note: feedback.note }).from(feedback).orderBy(desc(feedback.createdAt)).limit(50)
    : [];
  let snapshot = null;
  if (task.snapshotId) [snapshot] = await tx.select().from(linkedinSnapshots).where(eq(linkedinSnapshots.id, task.snapshotId)).limit(1);
  let request = null;
  let relatedJobs: unknown[] = [];
  if (task.requestId) {
    [request] = await tx.select().from(requests).where(eq(requests.id, task.requestId)).limit(1);
    if (task.kind === "question") relatedJobs = await tx.select({ job: jobs, company: companies.name }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(request?.jobId ? eq(jobs.id, request.jobId) : undefined).orderBy(desc(jobs.discoveredAt)).limit(100);
  }
  return {
    task: publicAgentTask(task), request, snapshot, serverNowUtc, settings: policy.settings, effectivePolicy: policy.effectivePolicy, policyHash: policy.policyHash, strategy, cvs, learning, relatedJobs,
    instructions: buildTaskContextInstructions(task),
  };
}

export async function getTaskContext(task: TaskRow, tx: TaskTx) {
  const context = await loadTaskContext(task, tx);
  // Trusted adapter code consumes this once and supplies only the nested object
  // to a tool-free evaluator. Keeping the full snapshot here avoids reintroducing
  // model-driven context pagination.
  return task.kind === "linkedin_evaluate" ? context : presentTaskContext(context);
}

export async function getTaskContextSection(task: TaskRow, input: {
  context_version: string;
  section: TaskContextSectionName;
  item_index?: number;
  whole_section?: boolean;
  cursor?: number;
}, tx: TaskTx) {
  const context = await loadTaskContext(task, tx);
  try {
    return readTaskContextSection(context, input);
  } catch (error) {
    throw new WorkerHttpError(error instanceof Error ? error.message : "Task context section could not be read", 409);
  }
}

export const discoveredJobSchema = z.object({
  company: z.string().min(1).max(300).refine(companyDisplayNameFitsStorage, "Company name must be 1 to 300 characters after normalization"), title: z.string().min(1).max(500), url: z.url().max(4000), source: z.string().min(1).max(160),
  location: z.string().max(1000).optional(), work_mode: z.enum(["onsite", "hybrid", "remote"]), salary_text: z.string().max(1000).optional(),
  description_md: z.string().min(1).max(100_000), fit_score: z.number().int().min(0).max(100), fit_analysis_md: z.string().min(1).max(30_000),
  fit_factors: z.array(z.object({ factor: z.string().max(300), weight: z.number(), direction: z.enum(["+", "-"]), note: z.string().max(3000) })).max(30).default([]),
  recommended_cv_variant_id: z.uuid().optional(),
  policy_hash: z.string().length(64), policy_evidence: z.object({ location_eligible: z.literal(true), language_eligible: z.literal(true), role_eligible: z.literal(true), exclusions_clear: z.literal(true), explanation: z.string().min(20).max(10_000) }),
  source_facts: evaluationSourceFactsSchema.optional(),
});

export const publicDiscoveredJobSchema = discoveredJobSchema.extend({
  source_verification: publicSourceVerificationSchema,
});

function normalizedEvidenceText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
}

function storedTextValues(value: unknown, values: string[] = []): string[] {
  if (typeof value === "string") values.push(normalizedEvidenceText(value));
  else if (Array.isArray(value)) value.forEach((item) => storedTextValues(item, values));
  else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach((item) => storedTextValues(item, values));
  return values;
}

function quoteIsStored(quote: string | null, snapshot: typeof linkedinSnapshots.$inferSelect) {
  if (!quote) return false;
  const needle = normalizedEvidenceText(quote);
  return needle.length > 0 && storedTextValues({
    title: snapshot.title,
    company: snapshot.company,
    location: snapshot.location,
    workModeText: snapshot.workModeText,
    compactEvidence: snapshot.compactEvidence,
    snapshotEvidence: snapshot.snapshotEvidence,
  }).some((text) => text.includes(needle));
}

function normalizedPlace(value: string) {
  return normalizedEvidenceText(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

type LinkedinPromotionEvidenceFinding = {
  message: string;
  gate: Exclude<keyof z.infer<typeof evaluationPolicyEvidenceSchema>, "explanation">;
  status: "rejected" | "needs_review";
};

function linkedinPromotionEvidenceFinding(
  input: z.infer<typeof discoveredJobSchema>,
  snapshot: typeof linkedinSnapshots.$inferSelect,
  effectivePolicy: Awaited<ReturnType<typeof linkedinPolicy>>["effectivePolicy"],
): LinkedinPromotionEvidenceFinding | null {
  const reviewLocation = (message: string): LinkedinPromotionEvidenceFinding => ({ message, gate: "location_eligible", status: "needs_review" });
  const rejectLocation = (message: string): LinkedinPromotionEvidenceFinding => ({ message, gate: "location_eligible", status: "rejected" });
  if (linkedinSnapshotIsClosed(snapshot)) {
    return { message: "Stored LinkedIn evidence marks this vacancy closed; it cannot be promoted", gate: "exclusions_clear", status: "rejected" };
  }
  const facts = input.source_facts;
  if (!facts) return reviewLocation("Structured source facts are required for LinkedIn promotion");
  if (facts.work_mode === "unknown" || !facts.work_mode_quote || !quoteIsStored(facts.work_mode_quote, snapshot)) {
    return reviewLocation("Stored evidence does not verify the submitted work mode; use needs_review");
  }
  if (facts.work_mode !== input.work_mode) return reviewLocation("Submitted work mode conflicts with structured source facts");
  if ((input.location ?? null) !== (snapshot.location ?? null) || facts.location.raw !== (snapshot.location ?? null)) {
    return reviewLocation("Promotion location must match the complete stored snapshot");
  }
  if (!facts.location.evidence_quote || !quoteIsStored(facts.location.evidence_quote, snapshot)) {
    return reviewLocation("Stored evidence does not verify the submitted location; use needs_review");
  }
  for (const requirement of facts.language_requirements) {
    if (!quoteIsStored(requirement.evidence_quote, snapshot)) {
      return { message: "A language requirement quote is absent from stored evidence", gate: "language_eligible", status: "needs_review" };
    }
    if (requirement.required && !effectivePolicy.languages.accepted.some((language) => normalizedEvidenceText(language) === normalizedEvidenceText(requirement.language))) {
      return { message: "A required language is outside the configured eligibility", gate: "language_eligible", status: "rejected" };
    }
  }
  if (facts.remote_eligibility.evidence_quote && !quoteIsStored(facts.remote_eligibility.evidence_quote, snapshot)) {
    return reviewLocation("The remote-eligibility quote is absent from stored evidence");
  }
  if (facts.work_mode !== "remote") {
    if (!effectivePolicy.office.workModes.includes(facts.work_mode)) return rejectLocation("Office work mode is disabled by the configured policy");
    if (!facts.location.city || !facts.location.country_code) return reviewLocation("Office geography is uncertain; use needs_review");
    const matchingCountry = effectivePolicy.office.locations.filter((location) => location.countryCode === facts.location.country_code);
    if (!matchingCountry.length) return rejectLocation("Office country is outside the configured geography");
    // The stored policy preserves the radius. Without trusted coordinates the
    // server can prove only the configured city itself; nearby cities are held.
    if (!matchingCountry.some((location) => normalizedPlace(location.city) === normalizedPlace(facts.location.city!))) {
      return reviewLocation("Office distance from the configured city is unverified; use needs_review");
    }
  } else {
    if (!effectivePolicy.remote.enabled) return rejectLocation("Remote work is disabled by the configured policy");
    const remote = facts.remote_eligibility;
    if (remote.scope === "countries") {
      if (!remote.evidence_quote || !remote.eligible_country_codes.length) return reviewLocation("Remote country eligibility is unverified; use needs_review");
      if (!remote.eligible_country_codes.some((country) => effectivePolicy.remote.eligibleCountryCodes.includes(country))) return rejectLocation("Remote countries are outside the configured eligibility");
    } else if (remote.scope === "worldwide") {
      if (!remote.evidence_quote) return reviewLocation("Worldwide remote eligibility is unverified; use needs_review");
      if (!effectivePolicy.remote.includeWorldwide) return rejectLocation("Worldwide remote roles are disabled by the configured policy");
    } else if (remote.scope === "unspecified") {
      if (!effectivePolicy.remote.includeUnspecified) return reviewLocation("Remote-country eligibility is unspecified; use needs_review");
    }
  }
  return null;
}

export function linkedinPromotionEvidenceIssue(
  input: z.infer<typeof discoveredJobSchema>,
  snapshot: typeof linkedinSnapshots.$inferSelect,
  effectivePolicy: Awaited<ReturnType<typeof linkedinPolicy>>["effectivePolicy"],
) {
  return linkedinPromotionEvidenceFinding(input, snapshot, effectivePolicy)?.message ?? null;
}

function assertLinkedinPromotionEvidence(
  input: z.infer<typeof discoveredJobSchema>,
  snapshot: typeof linkedinSnapshots.$inferSelect,
  effectivePolicy: Awaited<ReturnType<typeof linkedinPolicy>>["effectivePolicy"],
) {
  const issue = linkedinPromotionEvidenceIssue(input, snapshot, effectivePolicy);
  if (issue) throw new WorkerHttpError(issue, 400);
}

async function ensureDiscoveredCompany(inputName: string, tx: TaskTx) {
  const name = companyDisplayName(inputName);
  if (!companyDisplayNameFitsStorage(inputName)) throw new WorkerHttpError("Company name must be 1 to 300 characters after normalization", 400);
  const identity = normalizeCompanyIdentity(name);
  for (const slug of companySlugCandidates(name)) {
    const [existing] = await tx.select().from(companies).where(eq(companies.slug, slug)).limit(1);
    if (existing) {
      if (normalizeCompanyIdentity(existing.name) === identity) return existing;
      continue;
    }
    const [created] = await tx.insert(companies).values({ name, slug }).onConflictDoNothing({ target: companies.slug }).returning();
    if (created) return created;
    const [raced] = await tx.select().from(companies).where(eq(companies.slug, slug)).limit(1);
    if (raced && normalizeCompanyIdentity(raced.name) === identity) return raced;
  }
  throw new WorkerHttpError("Could not create a unique company identity");
}

export async function saveDiscoveredJob(task: TaskRow, input: z.infer<typeof discoveredJobSchema> | z.infer<typeof publicDiscoveredJobSchema>, tx: TaskTx, snapshot?: typeof linkedinSnapshots.$inferSelect) {
  requireTaskKind(task, snapshot ? ["linkedin_evaluate"] : ["search"]);
  const url = new URL(input.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new WorkerHttpError("A public HTTPS source URL is required", 400);
  if (snapshot) {
    if (input.url !== snapshot.canonicalUrl || input.title !== snapshot.title || !snapshot.company || input.company !== snapshot.company) throw new WorkerHttpError("Promotion must match the stored LinkedIn identity");
    if (linkedinSnapshotIsClosed(snapshot)) throw new WorkerHttpError("Stored LinkedIn evidence marks this vacancy closed; it cannot be promoted", 400);
  } else {
    if (!Array.isArray(task.payload.sources) || !task.payload.sources.includes("public")) throw new WorkerHttpError("Public search is not enabled for this task", 403);
    if (/(^|\.)linkedin\.com$/i.test(url.hostname) || input.source.toLowerCase() === "linkedin") throw new WorkerHttpError("LinkedIn jobs must go through snapshot evaluation", 400);
    const publicInput = input as z.infer<typeof publicDiscoveredJobSchema>;
    if (!publicInput.source_verification) throw new WorkerHttpError("Current direct-employer source verification is required", 400);
    const sourceIssue = publicSourceVerificationIssue({ jobUrl: input.url, taskStartedAt: task.startedAt, verification: publicInput.source_verification });
    if (sourceIssue) throw new WorkerHttpError(sourceIssue, 400);
    const receipt = publicSourceReceipts(task)[publicInput.source_verification.server_receipt_id];
    const receiptIssue = trustedPublicSourceReceiptIssue({ taskId: task.id, attempt: task.attemptCount, taskStartedAt: task.startedAt, jobUrl: input.url, title: input.title, company: input.company, verification: publicInput.source_verification, receipt });
    if (receiptIssue) throw new WorkerHttpError(receiptIssue, 400);
  }
  // Hold the canonical settings row through every admission write so a policy
  // update cannot commit between validation and persistence.
  const { settings, effectivePolicy, policyHash } = await linkedinPolicy(tx, { lock: true });
  if (input.policy_hash !== policyHash) throw new WorkerHttpError("Search policy changed; reload context and reevaluate");
  if (input.fit_score < settings.minimumFitScore) throw new WorkerHttpError("Fit score is below the configured minimum");
  const companyIdentity = normalizeCompanyIdentity(input.company);
  if (settings.excludedCompanies.some((company) => normalizeCompanyIdentity(company) === companyIdentity)) throw new WorkerHttpError("Company is excluded by the search policy");
  if (input.work_mode === "remote" ? !settings.remote.enabled : !settings.workModes.includes(input.work_mode)) throw new WorkerHttpError("Work mode is excluded by the search policy");
  if (snapshot) assertLinkedinPromotionEvidence(input, snapshot, effectivePolicy);
  // Serializes URL/dedupe admission and per-search quotas across evaluation tasks.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('compass:save-job'))`);
  const dedupeKey = makeDedupeKey(input.company, input.title, input.location);
  const [existing] = await tx.select().from(jobs).where(or(eq(jobs.dedupeKey, dedupeKey), eq(jobs.url, input.url))).limit(1);
  if (existing) return { job_id: existing.id, outcome: "already_known" as const };
  if (input.recommended_cv_variant_id) {
    const [variant] = await tx.select({ id: cvVariants.id }).from(cvVariants).where(eq(cvVariants.id, input.recommended_cv_variant_id)).limit(1);
    if (!variant) throw new WorkerHttpError("Recommended CV variant does not exist; use a supplied context CV ID", 400);
  }
  const quotaId = task.parentTaskId ?? task.id;
  if (task.payload.admissionMode !== "full_ingestion") {
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(activityLog).where(and(eq(activityLog.type, "job_discovered"), sql`${activityLog.payload}->>'search_task_id' = ${quotaId}`));
    if ((count?.total ?? 0) >= settings.schedule.maxJobs) throw new WorkerHttpError("Search has reached its configured maximum new jobs");
  }
  const company = await ensureDiscoveredCompany(input.company, tx);
  const [job] = await tx.insert(jobs).values({ companyId: company.id, title: input.title, url: input.url, source: snapshot ? "linkedin" : input.source, location: input.location, workMode: input.work_mode, salaryText: input.salary_text, descriptionMd: input.description_md, fitScore: input.fit_score, fitAnalysisMd: input.fit_analysis_md, fitFactors: input.fit_factors, recommendedCvVariantId: input.recommended_cv_variant_id, dedupeKey, analysisStatus: "complete" }).returning({ id: jobs.id });
  const sourceVerification = snapshot ? undefined : (input as z.infer<typeof publicDiscoveredJobSchema>).source_verification;
  const serverSourceReceipt = sourceVerification ? trustedPublicSourceReceiptSchema.parse(publicSourceReceipts(task)[sourceVerification.server_receipt_id]) : undefined;
  await tx.insert(activityLog).values({ actor: "system", type: "job_discovered", jobId: job.id, message: `${task.executor === "api" ? "API worker" : task.executor === "codex" ? "Codex" : "Hermes"} found ${input.title} at ${input.company}.`, payload: { task_id: task.id, search_task_id: quotaId, policyHash, policyEvidence: input.policy_evidence, ...(sourceVerification ? { sourceVerification, serverSourceReceipt, sourceVerificationAuthority: "server_direct_fetch" } : {}) } });
  return { job_id: job.id, outcome: "created" as const };
}

export type LinkedinEvaluationCompletion = {
  policy_hash: string;
  status: "promoted" | "rejected" | "needs_review";
  reason: string;
  evaluation: z.infer<typeof linkedinEvaluationSchema>;
  job?: z.infer<typeof discoveredJobSchema>;
};

export async function finishLinkedinEvaluation(task: TaskRow, input: LinkedinEvaluationCompletion, tx: TaskTx) {
  requireTaskKind(task, ["linkedin_evaluate"]);
  if (!task.snapshotId) throw new WorkerHttpError("Task has no LinkedIn snapshot");
  const [snapshot] = await tx.select().from(linkedinSnapshots).where(eq(linkedinSnapshots.id, task.snapshotId)).for("update").limit(1);
  if (!snapshot) throw new WorkerHttpError("Snapshot not found", 404);
  const hash = stableJsonHash({ status: input.status, reason: input.reason, policy_hash: input.policy_hash, evaluation: input.evaluation, job: input.job });
  const serverState = (task.checkpoint._server ?? {}) as Record<string, unknown>;
  if (serverState.evaluationDecisionHash) {
    if (serverState.evaluationDecisionHash !== hash) throw new WorkerHttpError("Evaluation already completed with a different result");
    return { outcome: "already_completed", state: snapshot.state, job_id: snapshot.promotedJobId };
  }
  if (!["snapshot_ready", "failed_transient"].includes(snapshot.state)) throw new WorkerHttpError("Snapshot is not available for managed evaluation");
  if (task.payload.evidenceHash && task.payload.evidenceHash !== snapshot.evidenceHash) throw new WorkerHttpError("Snapshot evidence changed; this evaluation is stale");
  // Evaluation decisions also persist the policy hash they were checked against.
  const { settings, effectivePolicy, policyHash } = await linkedinPolicy(tx, { lock: true });
  if (input.policy_hash !== policyHash) throw new WorkerHttpError("Search policy changed; reload context and reevaluate");
  const gates = ["location_eligible", "language_eligible", "role_eligible", "exclusions_clear"] as const;
  const gateValues = gates.map((gate) => input.evaluation.policy_evidence[gate]);
  if (input.status === "promoted" && (!gateValues.every((value) => value === true) || input.evaluation.fit_score < settings.minimumFitScore)) {
    throw new WorkerHttpError("Promotion requires every policy gate and the configured fit score", 400);
  }
  if (input.status === "rejected" && !gateValues.some((value) => value === false) && input.evaluation.fit_score >= settings.minimumFitScore) {
    throw new WorkerHttpError("A rejection requires an evidenced failed gate or below-threshold fit score", 400);
  }
  if (input.status === "needs_review" && !gateValues.some((value) => value === null)) {
    throw new WorkerHttpError("needs_review requires at least one uncertain policy gate", 400);
  }
  let jobId: string | null = null;
  let finalStatus = input.status;
  let finalReason = input.reason;
  let finalEvaluation = input.evaluation;
  if (input.status === "promoted") {
    if (!input.job) throw new WorkerHttpError("job is required for promotion", 400);
    if (!input.job.source_facts || stableJsonHash(input.job.source_facts) !== stableJsonHash(input.evaluation.source_facts)
      || input.job.fit_score !== input.evaluation.fit_score
      || stableJsonHash(input.job.policy_evidence) !== stableJsonHash(input.evaluation.policy_evidence)) {
      throw new WorkerHttpError("Promoted job must exactly match the structured evaluation", 400);
    }
    const evidenceFinding = linkedinPromotionEvidenceFinding(input.job, snapshot, effectivePolicy);
    if (evidenceFinding) {
      finalStatus = evidenceFinding.status;
      finalReason = `Job Seeker source-evidence guard: ${evidenceFinding.message}`;
      finalEvaluation = {
        ...input.evaluation,
        policy_evidence: {
          ...input.evaluation.policy_evidence,
          [evidenceFinding.gate]: evidenceFinding.status === "rejected" ? false : null,
          explanation: `${input.evaluation.policy_evidence.explanation} Server verification: ${evidenceFinding.message}`.slice(0, 10_000),
        },
      };
    } else {
      jobId = (await saveDiscoveredJob(task, input.job, tx, snapshot)).job_id;
    }
  } else if (input.job) throw new WorkerHttpError("job is only accepted for promotion", 400);
  await tx.update(linkedinSnapshots).set({ state: finalStatus, promotedJobId: jobId, completionReason: finalReason, detailDecision: { ...(snapshot.detailDecision ?? {}), evaluation: finalEvaluation }, completedAt: new Date(), updatedAt: new Date(), evaluatedPolicyHash: policyHash }).where(eq(linkedinSnapshots.id, snapshot.id));
  await tx.update(agentTasks).set({ checkpoint: { ...task.checkpoint, _server: { ...serverState, evaluationDecisionHash: hash } }, updatedAt: new Date() }).where(eq(agentTasks.id, task.id));
  await tx.insert(activityLog).values({ actor: "system", type: "linkedin_evaluated", jobId, message: `LinkedIn evaluation: ${finalStatus.replaceAll("_", " ")}.`, payload: { task_id: task.id, snapshot_id: snapshot.id, policyHash, submittedStatus: input.status, reason: finalReason, evaluation: finalEvaluation } });
  return { outcome: "completed", state: finalStatus, job_id: jobId };
}
