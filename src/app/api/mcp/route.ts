import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { getDb } from "@/db";
import {
  activityLog,
  agentTasks,
  agencies,
  automationRuns,
  companies,
  cvTailorings,
  cvVariants,
  digests,
  eventsOutbox,
  feedback,
  interviews,
  interviewers,
  jobs,
  jobStatusHistory,
  keyEvents,
  linkedinSnapshots,
  notificationPreferences,
  outreachLog,
  prepBriefs,
  rejections,
  requests,
  searchSettings,
  strategySections,
  watchlistItems,
  weeklyTargets,
} from "@/db/schema";
import { cancelAgentTask, enqueueSearchTask, getAgentExecutionSettings, retryAgentTask } from "@/lib/agent-tasks";
import { publicAgentTask } from "@/lib/worker-tasks";
import { bearerIsValid, unauthorized } from "@/lib/api-auth";
import { makeDedupeKey } from "@/lib/format";
import { companyDisplayName, companyDisplayNameFitsStorage, companySlugCandidates, normalizeCompanyIdentity } from "@/lib/company-identity";
import { aggregateFeedbackReasons } from "@/lib/feedback-summary";
import { availableJobTransitions, canTransitionJob } from "@/lib/job-workflow";
import { createInterviewRecord, updateInterviewRecord } from "@/lib/interview-mutations";
import { loadEffectiveSearchPolicy } from "@/lib/search-settings-store";
import {
  DEFAULT_INTERVIEW_TIME_ZONE,
  INTERVIEW_OUTCOMES,
  INTERVIEW_STAGES,
  isValidTimeZone,
} from "@/lib/interview-workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const jobStatusSchema = z.enum(["sourced", "to_apply", "applied", "screening", "interviewing", "offer", "rejected", "withdrawn", "irrelevant", "archived"]);
const interviewStageSchema = z.enum(INTERVIEW_STAGES);
const interviewOutcomeSchema = z.enum(INTERVIEW_OUTCOMES);
const timeZoneSchema = z.string().min(1).refine(isValidTimeZone, "Invalid IANA timezone");
const scheduledInstantSchema = z.string().refine(
  (value) => /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && !Number.isNaN(new Date(value).getTime()),
  "scheduled_at must be an ISO 8601 timestamp with UTC offset",
);
const fitFactorSchema = z.object({ factor: z.string().min(1), weight: z.number(), direction: z.enum(["+", "-"]), note: z.string() });
const tailoringChangeSchema = z.object({ id: z.string().min(1), section: z.string().min(1), current: z.string(), proposed: z.string(), rationale: z.string() });

async function ownerSettings() {
  const [row] = await getDb().select().from(searchSettings).where(eq(searchSettings.id, "owner")).limit(1);
  return row ?? null;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function optionalDate(value?: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${value}`);
  return parsed;
}

async function ensureCompany(input: { company: string; tier?: "a" | "b" | "c"; location?: string }) {
  const db = getDb();
  if (!companyDisplayNameFitsStorage(input.company)) throw new Error("Company name must be 1 to 300 characters after normalization");
  const name = companyDisplayName(input.company);
  const identity = normalizeCompanyIdentity(name);
  const refresh = async (company: typeof companies.$inferSelect) => {
    const [updated] = await db.update(companies).set({
      name,
      ...(input.tier ? { tier: input.tier } : {}),
      ...(input.location ? { location: input.location } : {}),
      updatedAt: new Date(),
    }).where(eq(companies.id, company.id)).returning();
    return updated ?? company;
  };
  for (const slug of companySlugCandidates(name)) {
    const [existing] = await db.select().from(companies).where(eq(companies.slug, slug)).limit(1);
    if (existing) {
      if (normalizeCompanyIdentity(existing.name) === identity) return refresh(existing);
      continue;
    }
    const [created] = await db.insert(companies).values({ name, slug, tier: input.tier, location: input.location }).onConflictDoNothing({ target: companies.slug }).returning();
    if (created) return created;
    const [raced] = await db.select().from(companies).where(eq(companies.slug, slug)).limit(1);
    if (raced && normalizeCompanyIdentity(raced.name) === identity) return refresh(raced);
  }
  throw new Error("Could not create a unique company identity");
}

async function fullJob(jobId?: string, url?: string) {
  const db = getDb();
  const condition = jobId ? eq(jobs.id, jobId) : url ? eq(jobs.url, url) : undefined;
  if (!condition) throw new Error("Provide job_id or url");
  const rows = await db.select({ job: jobs, company: companies, recommended_cv: cvVariants }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).leftJoin(cvVariants, eq(jobs.recommendedCvVariantId, cvVariants.id)).where(condition).limit(1);
  if (!rows[0]) return null;
  const id = rows[0].job.id;
  const [history, jobFeedback, tailorings, jobInterviews, activity, rejection] = await Promise.all([
    db.select().from(jobStatusHistory).where(eq(jobStatusHistory.jobId, id)).orderBy(desc(jobStatusHistory.createdAt)),
    db.select().from(feedback).where(eq(feedback.jobId, id)).orderBy(desc(feedback.createdAt)),
    db.select().from(cvTailorings).where(eq(cvTailorings.jobId, id)).orderBy(desc(cvTailorings.createdAt)),
    db.select().from(interviews).where(eq(interviews.jobId, id)).orderBy(asc(interviews.scheduledAt)),
    db.select().from(activityLog).where(eq(activityLog.jobId, id)).orderBy(desc(activityLog.createdAt)).limit(50),
    db.select().from(rejections).where(eq(rejections.jobId, id)).limit(1),
  ]);
  return { ...rows[0], history, feedback: jobFeedback, tailorings, interviews: jobInterviews, activity, rejection: rejection[0] ?? null };
}

const handler = createMcpHandler((server) => {
  server.registerTool("request_search", { description: "Queue a search using current app settings; the assigned worker executes it. Repeated active searches coalesce.", inputSchema: z.object({}) }, async () => result(await enqueueSearchTask({ purpose: "search_now" })));
  server.registerTool("get_agent_task", { description: "Read durable task status, checkpoint and result. Does not launch work.", inputSchema: z.object({ task_id: z.uuid() }) }, async ({ task_id }) => {
    const [task] = await getDb().select().from(agentTasks).where(eq(agentTasks.id, task_id)).limit(1);
    return result({ task: task ? publicAgentTask(task) : null });
  });
  server.registerTool("list_agent_tasks", { description: "List recent durable tasks, including queued and waiting work.", inputSchema: z.object({ status: z.enum(["queued", "running", "waiting_for_user", "succeeded", "failed", "cancelled"]).optional(), limit: z.number().int().min(1).max(100).default(30) }) }, async ({ status, limit }) => result({ tasks: (await getDb().select().from(agentTasks).where(status ? eq(agentTasks.status, status) : undefined).orderBy(desc(agentTasks.createdAt)).limit(limit)).map(publicAgentTask) }));
  server.registerTool("cancel_agent_task", { description: "Cancel a specific task requested by the user; revokes its active write capability.", inputSchema: z.object({ task_id: z.uuid() }) }, async ({ task_id }) => result({ task: await cancelAgentTask(task_id) }));
  server.registerTool("retry_agent_task", { description: "Retry a failed, cancelled or waiting task after the user resolves the issue.", inputSchema: z.object({ task_id: z.uuid() }) }, async ({ task_id }) => result({ task: await retryAgentTask(task_id) }));
  server.registerTool("get_agent_execution_settings", { description: "Read search/evaluation executor choices, sources and budgets.", inputSchema: z.object({}) }, async () => result({ settings: await getAgentExecutionSettings() }));

  server.registerTool("upsert_job", {
    title: "Upsert job",
    description: "Create or refresh a discovered job using normalized company/title/city deduplication.",
    inputSchema: z.object({
      company: z.string().min(1), title: z.string().min(1), url: z.string().url(), location: z.string().optional(),
      work_mode: z.enum(["onsite", "hybrid", "remote"]).optional(), salary_text: z.string().optional(),
      description_md: z.string().optional(), source: z.string().min(1), posted_at: z.string().optional(), tier: z.enum(["a", "b", "c"]).optional(),
    }),
  }, async (input) => {
    const db = getDb();
    const company = await ensureCompany(input);
    const dedupeKey = makeDedupeKey(input.company, input.title, input.location);
    const [sameUrl] = await db.select().from(jobs).where(eq(jobs.url, input.url)).limit(1);
    if (sameUrl) {
      const [conflict] = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.dedupeKey, dedupeKey), ne(jobs.id, sameUrl.id))).limit(1);
      if (conflict) return result({ job_id: sameUrl.id, outcome: "conflict", conflicting_job_id: conflict.id, existing_url: input.url });
      const identityChanged = sameUrl.companyId !== company.id
        || sameUrl.title !== input.title
        || sameUrl.location !== (input.location ?? null)
        || sameUrl.workMode !== (input.work_mode ?? null);
      await db.update(jobs).set({
        companyId: company.id, title: input.title, url: input.url, source: input.source,
        location: input.location, workMode: input.work_mode, salaryText: input.salary_text,
        descriptionMd: input.description_md, postedAt: optionalDate(input.posted_at) ?? sameUrl.postedAt,
        dedupeKey,
        ...(identityChanged ? {
          fitScore: null, fitAnalysisMd: null, fitFactors: [], analysisStatus: "pending" as const,
          analysisError: null, recommendedCvVariantId: null,
        } : {}),
      }).where(eq(jobs.id, sameUrl.id));
      return result({ job_id: sameUrl.id, outcome: "updated", analysis_reset: identityChanged });
    }
    const [existing] = await db.select().from(jobs).where(eq(jobs.dedupeKey, dedupeKey)).limit(1);
    if (existing && existing.url !== input.url) return result({ job_id: existing.id, outcome: "duplicate", existing_url: existing.url });
    if (existing) {
      await db.update(jobs).set({
        url: input.url, source: input.source, location: input.location, workMode: input.work_mode,
        salaryText: input.salary_text, descriptionMd: input.description_md, postedAt: optionalDate(input.posted_at) ?? existing.postedAt,
      }).where(eq(jobs.id, existing.id));
      return result({ job_id: existing.id, outcome: "updated" });
    }
    const [created] = await db.insert(jobs).values({
      companyId: company.id, title: input.title, url: input.url, source: input.source, location: input.location,
      workMode: input.work_mode, salaryText: input.salary_text, descriptionMd: input.description_md,
      postedAt: optionalDate(input.posted_at), dedupeKey,
    }).returning({ id: jobs.id });
    await db.insert(activityLog).values({ actor: "assistant", type: "job_discovered", jobId: created.id, message: `Found ${input.title} at ${input.company}.`, payload: { source: input.source, url: input.url } });
    return result({ job_id: created.id, outcome: "created" });
  });

  server.registerTool("correct_job_metadata", {
    title: "Correct canonical job metadata",
    description: "Correct a known tracked job from canonical employer/ATS evidence, recompute its dedupe identity, and invalidate stale fit analysis.",
    inputSchema: z.object({
      job_id: z.string().uuid(), company: z.string().min(1), title: z.string().min(1),
      canonical_url: z.string().url(), source: z.string().min(1), location: z.string().nullable(),
      work_mode: z.enum(["onsite", "hybrid", "remote"]).nullable(), salary_text: z.string().nullable().optional(),
      description_md: z.string().nullable().optional(), posted_at: z.string().nullable().optional(),
      correction_note: z.string().min(1),
    }),
  }, async (input) => {
    const db = getDb();
    const company = await ensureCompany({ company: input.company, location: input.location ?? undefined });
    const dedupeKey = makeDedupeKey(input.company, input.title, input.location);
    const outcome = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(jobs).where(eq(jobs.id, input.job_id)).limit(1);
      if (!current) throw new Error("Job not found");
      const [conflict] = await tx.select({ id: jobs.id, url: jobs.url }).from(jobs).where(and(
        ne(jobs.id, input.job_id),
        or(eq(jobs.dedupeKey, dedupeKey), eq(jobs.url, input.canonical_url)),
      )).limit(1);
      if (conflict) return { outcome: "conflict" as const, conflictingJobId: conflict.id, conflictingUrl: conflict.url };

      await tx.update(jobs).set({
        companyId: company.id,
        title: input.title,
        url: input.canonical_url,
        source: input.source,
        location: input.location,
        workMode: input.work_mode,
        ...(input.salary_text !== undefined ? { salaryText: input.salary_text } : {}),
        ...(input.description_md !== undefined ? { descriptionMd: input.description_md } : {}),
        ...(input.posted_at !== undefined ? { postedAt: optionalDate(input.posted_at) } : {}),
        dedupeKey,
        fitScore: null,
        fitAnalysisMd: null,
        fitFactors: [],
        analysisStatus: "pending",
        analysisError: null,
        recommendedCvVariantId: null,
      }).where(eq(jobs.id, input.job_id));
      await tx.insert(activityLog).values({
        actor: "assistant",
        type: "job_metadata_corrected",
        jobId: input.job_id,
        message: input.correction_note,
        payload: {
          before: { company_id: current.companyId, title: current.title, url: current.url, location: current.location, work_mode: current.workMode },
          after: { company_id: company.id, title: input.title, url: input.canonical_url, location: input.location, work_mode: input.work_mode },
        },
      });
      return { outcome: "corrected" as const };
    });
    if (outcome.outcome === "conflict") {
      return result({ job_id: input.job_id, outcome: "conflict", conflicting_job_id: outcome.conflictingJobId, conflicting_url: outcome.conflictingUrl });
    }
    return result({ job_id: input.job_id, outcome: "corrected", analysis_status: "pending", canonical_url: input.canonical_url });
  });

  server.registerTool("set_fit_analysis", {
    title: "Set fit analysis",
    description: "Attach a scored, factorized fit analysis to a job.",
    inputSchema: z.object({ job_id: z.string().uuid(), fit_score: z.number().int().min(0).max(100), fit_analysis_md: z.string(), fit_factors: z.array(fitFactorSchema), recommended_cv_variant_slug: z.string().optional() }),
  }, async (input) => {
    const db = getDb();
    let cvId: string | null = null;
    if (input.recommended_cv_variant_slug) {
      const [cv] = await db.select({ id: cvVariants.id }).from(cvVariants).where(eq(cvVariants.slug, input.recommended_cv_variant_slug)).limit(1);
      cvId = cv?.id ?? null;
    }
    await db.update(jobs).set({ fitScore: input.fit_score, fitAnalysisMd: input.fit_analysis_md, fitFactors: input.fit_factors, recommendedCvVariantId: cvId, analysisStatus: "complete", analysisError: null }).where(eq(jobs.id, input.job_id));
    return result({ job_id: input.job_id, fit_score: input.fit_score, updated: true });
  });

  server.registerTool("set_job_status", {
    title: "Set job status",
    description: "Move a job in the pipeline as the assistant and record history.",
    inputSchema: z.object({ job_id: z.string().uuid(), status: jobStatusSchema, note: z.string().optional() }),
  }, async (input) => {
    const db = getDb();
    await db.transaction(async (tx) => {
      const [current] = await tx.select({ status: jobs.status, triagedAt: jobs.triagedAt }).from(jobs).where(eq(jobs.id, input.job_id)).limit(1);
      if (!current) throw new Error("Job not found");
      if (!canTransitionJob(current.status, input.status)) {
        if (current.status === input.status) return;
        throw new Error(`Cannot move a job from ${current.status} to ${input.status}. Available: ${availableJobTransitions(current.status).join(", ") || "none"}`);
      }
      await tx.update(jobs).set({ status: input.status, statusChangedAt: new Date() }).where(eq(jobs.id, input.job_id));
      await tx.insert(jobStatusHistory).values({ jobId: input.job_id, fromStatus: current.status, toStatus: input.status, note: input.note, fromTriaged: Boolean(current.triagedAt), actor: "assistant" });
      await tx.insert(activityLog).values({ actor: "assistant", type: "status_changed", jobId: input.job_id, message: `Moved role to ${input.status}.`, payload: { from_status: current.status, to_status: input.status, note: input.note } });
    });
    return result({ job_id: input.job_id, status: input.status });
  });

  server.registerTool("upsert_company_dossier", {
    title: "Upsert company dossier",
    description: "Create or update a company research dossier.",
    inputSchema: z.object({ name: z.string().min(1), website: z.string().url().optional(), careers_url: z.string().url().optional(), location: z.string().optional(), tier: z.enum(["a", "b", "c"]).optional(), dossier_md: z.string(), notes_md: z.string().optional() }),
  }, async (input) => {
    const existing = await ensureCompany({ company: input.name, location: input.location, tier: input.tier });
    const [company] = await getDb().update(companies).set({ website: input.website, careersUrl: input.careers_url, location: input.location, tier: input.tier, dossierMd: input.dossier_md, notesMd: input.notes_md, updatedAt: new Date() }).where(eq(companies.id, existing.id)).returning({ id: companies.id });
    return result({ company_id: company.id, updated: true });
  });

  server.registerTool("propose_cv_tailoring", {
    title: "Propose CV tailoring",
    description: "Propose reviewable changes to a CV variant for one job.",
    inputSchema: z.object({ job_id: z.string().uuid(), cv_variant_slug: z.string(), proposal_md: z.string(), changes: z.array(tailoringChangeSchema) }),
  }, async (input) => {
    const db = getDb();
    const [cv] = await db.select().from(cvVariants).where(eq(cvVariants.slug, input.cv_variant_slug)).limit(1);
    if (!cv) throw new Error("CV variant not found");
    const [tailoring] = await db.insert(cvTailorings).values({ jobId: input.job_id, cvVariantId: cv.id, proposalMd: input.proposal_md, changes: input.changes.map((change) => ({ ...change, decision: "pending" as const })) }).returning({ id: cvTailorings.id });
    return result({ tailoring_id: tailoring.id, status: "proposed" });
  });

  server.registerTool("add_prep_brief", {
    title: "Add prep brief",
    description: "Attach an interview preparation brief.",
    inputSchema: z.object({ interview_id: z.string().uuid(), content_md: z.string().min(1) }),
  }, async (input) => {
    const [brief] = await getDb().insert(prepBriefs).values({ interviewId: input.interview_id, contentMd: input.content_md }).returning({ id: prepBriefs.id });
    return result({ prep_brief_id: brief.id });
  });

  server.registerTool("set_interviewer_research", {
    title: "Set interviewer research",
    description: "Attach research to an interviewer.",
    inputSchema: z.object({ interviewer_id: z.string().uuid(), research_md: z.string() }),
  }, async (input) => {
    await getDb().update(interviewers).set({ researchMd: input.research_md }).where(eq(interviewers.id, input.interviewer_id));
    return result({ interviewer_id: input.interviewer_id, updated: true });
  });

  server.registerTool("update_strategy_section", {
    title: "Update strategy section",
    description: "Upsert a job-search strategy section.",
    inputSchema: z.object({ key: z.string().min(1), title: z.string().optional(), content_md: z.string(), sort: z.number().int().optional() }),
  }, async (input) => {
    const [section] = await getDb().insert(strategySections).values({ key: input.key, title: input.title ?? input.key.replaceAll("_", " "), contentMd: input.content_md, sort: input.sort ?? 0 }).onConflictDoUpdate({ target: strategySections.key, set: { ...(input.title ? { title: input.title } : {}), contentMd: input.content_md, ...(input.sort != null ? { sort: input.sort } : {}), updatedAt: new Date() } }).returning({ id: strategySections.id });
    return result({ section_id: section.id, key: input.key });
  });

  server.registerTool("upsert_watchlist_item", {
    title: "Upsert watchlist item",
    description: "Create or update a board/company/alert watchlist entry.",
    inputSchema: z.object({ label: z.string(), url: z.string().url(), kind: z.enum(["company", "board", "alert"]), cadence: z.enum(["weekly", "daily"]) }),
  }, async (input) => {
    const [item] = await getDb().insert(watchlistItems).values(input).onConflictDoUpdate({ target: watchlistItems.url, set: { label: input.label, kind: input.kind, cadence: input.cadence } }).returning({ id: watchlistItems.id });
    return result({ watchlist_item_id: item.id });
  });

  server.registerTool("record_watchlist_check", {
    title: "Record watchlist check",
    description: "Record findings from a watchlist re-check.",
    inputSchema: z.object({ id: z.string().uuid(), findings_md: z.string() }),
  }, async (input) => {
    await getDb().update(watchlistItems).set({ lastCheckedAt: new Date(), lastFindingsMd: input.findings_md }).where(eq(watchlistItems.id, input.id));
    return result({ id: input.id, checked: true });
  });

  server.registerTool("upsert_agency", {
    title: "Upsert agency",
    description: "Create or update a recruitment agency.",
    inputSchema: z.object({ name: z.string(), website: z.string().url().optional(), contacts: z.array(z.record(z.string(), z.unknown())).optional(), status: z.enum(["not_contacted", "contacted", "active", "dead"]).optional(), notes_md: z.string().optional() }),
  }, async (input) => {
    const [agency] = await getDb().insert(agencies).values({ name: input.name, website: input.website, contacts: input.contacts ?? [], status: input.status, notesMd: input.notes_md }).onConflictDoUpdate({ target: agencies.name, set: { website: input.website, contacts: input.contacts ?? [], status: input.status, notesMd: input.notes_md } }).returning({ id: agencies.id });
    return result({ agency_id: agency.id });
  });

  server.registerTool("log_outreach", {
    title: "Log outreach",
    description: "Record agency or company outreach.",
    inputSchema: z.object({ agency_id: z.string().uuid().optional(), company_id: z.string().uuid().optional(), channel: z.string(), direction: z.enum(["in", "out"]), summary: z.string(), occurred_at: z.string().optional(), next_action: z.string().optional(), next_action_date: z.string().optional() }),
  }, async (input) => {
    const [entry] = await getDb().insert(outreachLog).values({ agencyId: input.agency_id, companyId: input.company_id, channel: input.channel, direction: input.direction, summary: input.summary, occurredAt: optionalDate(input.occurred_at) ?? new Date(), nextAction: input.next_action, nextActionDate: input.next_action_date }).returning({ id: outreachLog.id });
    return result({ outreach_id: entry.id });
  });

  server.registerTool("seed_cv_variant", {
    title: "Seed CV variant",
    description: "Import or refresh a private CV variant.",
    inputSchema: z.object({ slug: z.string(), name: z.string(), summary: z.string(), content_md: z.string(), drive_file_id: z.string().optional() }),
  }, async (input) => {
    const [variant] = await getDb().insert(cvVariants).values({ slug: input.slug, name: input.name, summary: input.summary, contentMd: input.content_md, driveFileId: input.drive_file_id }).onConflictDoUpdate({ target: cvVariants.slug, set: { name: input.name, summary: input.summary, contentMd: input.content_md, driveFileId: input.drive_file_id, version: sql`${cvVariants.version} + 1`, updatedAt: new Date() } }).returning({ id: cvVariants.id, version: cvVariants.version });
    return result({ cv_variant_id: variant.id, slug: input.slug, version: variant.version });
  });

  server.registerTool("post_digest", {
    title: "Post digest",
    description: "Store a daily or weekly search digest.",
    inputSchema: z.object({ digest_date: z.string(), content_md: z.string(), stats: z.record(z.string(), z.unknown()) }),
  }, async (input) => {
    const [digest] = await getDb().insert(digests).values({ digestDate: input.digest_date, contentMd: input.content_md, stats: input.stats }).returning({ id: digests.id });
    return result({ digest_id: digest.id });
  });

  server.registerTool("set_request_status", {
    title: "Set request status",
    description: "Mark an assistant request in progress or failed so the owner can see what is happening.",
    inputSchema: z.object({ request_id: z.string().uuid(), status: z.enum(["in_progress", "failed"]), error_md: z.string().nullable().optional() }),
  }, async (input) => {
    if (input.status === "failed" && !input.error_md) throw new Error("error_md is required when a request fails");
    const [request] = await getDb().update(requests).set({ status: input.status, errorMd: input.error_md, updatedAt: new Date() }).where(and(eq(requests.id, input.request_id), sql`not exists (select 1 from agent_tasks where request_id = ${requests.id})`)).returning({ id: requests.id });
    if (!request) throw new Error("Request not found");
    return result({ request_id: request.id, status: input.status });
  });

  server.registerTool("answer_request", {
    title: "Answer request",
    description: "Answer an open assistant request.",
    inputSchema: z.object({ request_id: z.string().uuid(), response_md: z.string() }),
  }, async (input) => {
    const answered = await getDb().update(requests).set({ status: "answered", responseMd: input.response_md, errorMd: null, answeredAt: new Date(), updatedAt: new Date() }).where(and(eq(requests.id, input.request_id), sql`not exists (select 1 from agent_tasks where request_id = ${requests.id})`));
    if (!answered.count) throw new Error("Request not found or owned by a managed task; use the task worker contract");
    return result({ request_id: input.request_id, status: "answered" });
  });

  server.registerTool("log_activity", {
    title: "Log activity",
    description: "Append an assistant activity entry.",
    inputSchema: z.object({ type: z.string(), message: z.string(), job_id: z.string().uuid().optional(), payload: z.record(z.string(), z.unknown()).optional() }),
  }, async (input) => {
    const [entry] = await getDb().insert(activityLog).values({ actor: "assistant", type: input.type, message: input.message, jobId: input.job_id, payload: input.payload ?? {} }).returning({ id: activityLog.id });
    return result({ activity_id: entry.id });
  });

  server.registerTool("get_events", {
    title: "Get events",
    description: "Claim the oldest unacknowledged owner-originated outbox events.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
  }, async ({ limit }) => {
    const db = getDb();
    const rows = await db.select().from(eventsOutbox).where(and(isNull(eventsOutbox.ackedAt), sql`not (${eventsOutbox.type} in ('search_requested', 'request_created', 'linkedin_snapshot_ready') and (${eventsOutbox.payload} ? 'task_id' or ${eventsOutbox.payload} ? 'managedTaskId'))`)).orderBy(asc(eventsOutbox.createdAt)).limit(limit);
    if (!rows.length) return result({ events: [] });
    const claimedAt = new Date();
    await db.update(eventsOutbox).set({ claimedAt }).where(and(inArray(eventsOutbox.id, rows.map((row) => row.id)), isNull(eventsOutbox.ackedAt)));
    return result({ events: rows.map((row) => ({ ...row, claimedAt })) });
  });

  server.registerTool("ack_events", {
    title: "Acknowledge events",
    description: "Acknowledge processed outbox event IDs.",
    inputSchema: z.object({ ids: z.array(z.number().int().positive()).min(1), note: z.string().optional() }),
  }, async (input) => {
    await getDb().update(eventsOutbox).set({ ackedAt: new Date(), ackNote: input.note }).where(and(inArray(eventsOutbox.id, input.ids), isNull(eventsOutbox.ackedAt)));
    return result({ acknowledged: input.ids });
  });

  server.registerTool("claim_linkedin_snapshot", {
    title: "Claim LinkedIn snapshot",
    description: "Atomically claim one snapshot-ready LinkedIn job for evaluation. Transient failures may be reclaimed.",
    inputSchema: z.object({ snapshot_id: z.string().uuid() }),
  }, async ({ snapshot_id }) => {
    const db = getDb();
    const claimedAt = new Date();
    const [claimed] = await db.update(linkedinSnapshots).set({
      state: "claimed",
      claimedAt,
      claimCount: sql`${linkedinSnapshots.claimCount} + 1`,
      completionReason: null,
      completedAt: null,
      updatedAt: claimedAt,
    }).where(and(
      eq(linkedinSnapshots.id, snapshot_id),
      sql`not exists (select 1 from agent_tasks where snapshot_id = ${linkedinSnapshots.id})`,
      inArray(linkedinSnapshots.state, ["snapshot_ready", "failed_transient"]),
    )).returning({ id: linkedinSnapshots.id, state: linkedinSnapshots.state, claimedAt: linkedinSnapshots.claimedAt, claimCount: linkedinSnapshots.claimCount });
    if (claimed) return result({ outcome: "claimed", snapshot: claimed });
    const [existing] = await db.select({ id: linkedinSnapshots.id, state: linkedinSnapshots.state, claimedAt: linkedinSnapshots.claimedAt, claimCount: linkedinSnapshots.claimCount })
      .from(linkedinSnapshots).where(eq(linkedinSnapshots.id, snapshot_id)).limit(1);
    if (!existing) throw new Error("LinkedIn snapshot not found");
    return result({ outcome: "not_claimable", snapshot: existing });
  });

  server.registerTool("get_linkedin_snapshot", {
    title: "Get LinkedIn snapshot",
    description: "Return the collector's stored LinkedIn evidence and gate decisions without browsing LinkedIn.",
    inputSchema: z.object({ snapshot_id: z.string().uuid() }),
  }, async ({ snapshot_id }) => {
    const [snapshot] = await getDb().select().from(linkedinSnapshots).where(eq(linkedinSnapshots.id, snapshot_id)).limit(1);
    return result({ snapshot: snapshot ?? null });
  });

  server.registerTool("complete_linkedin_snapshot", {
    title: "Complete LinkedIn snapshot",
    description: "Record the assistant's durable LinkedIn evaluation outcome after a claim. Promoted outcomes must reference the created Job Seeker job.",
    inputSchema: z.object({
      snapshot_id: z.string().uuid(),
      status: z.enum(["promoted", "rejected", "needs_review", "failed_transient"]),
      job_id: z.string().uuid().optional(),
      reason: z.string().min(1).max(10_000),
    }).superRefine((value, context) => {
      if (value.status === "promoted" && !value.job_id) context.addIssue({ code: "custom", path: ["job_id"], message: "job_id is required for promoted status" });
      if (value.status !== "promoted" && value.job_id) context.addIssue({ code: "custom", path: ["job_id"], message: "job_id is only valid for promoted status" });
    }),
  }, async (input) => {
    const db = getDb();
    if (input.job_id) {
      const [job] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, input.job_id)).limit(1);
      if (!job) throw new Error("Promoted Job Seeker job not found");
    }
    const completedAt = new Date();
    const [completed] = await db.update(linkedinSnapshots).set({
      state: input.status,
      promotedJobId: input.job_id ?? null,
      completionReason: input.reason,
      completedAt,
      updatedAt: completedAt,
    }).where(and(eq(linkedinSnapshots.id, input.snapshot_id), eq(linkedinSnapshots.state, "claimed"), sql`not exists (select 1 from agent_tasks where snapshot_id = ${linkedinSnapshots.id})`)).returning({
      id: linkedinSnapshots.id,
      state: linkedinSnapshots.state,
      promotedJobId: linkedinSnapshots.promotedJobId,
      completionReason: linkedinSnapshots.completionReason,
      completedAt: linkedinSnapshots.completedAt,
    });
    if (!completed) {
      const [existing] = await db.select({ id: linkedinSnapshots.id, state: linkedinSnapshots.state, promotedJobId: linkedinSnapshots.promotedJobId, completionReason: linkedinSnapshots.completionReason, completedAt: linkedinSnapshots.completedAt })
        .from(linkedinSnapshots).where(eq(linkedinSnapshots.id, input.snapshot_id)).limit(1);
      if (!existing) throw new Error("LinkedIn snapshot not found");
      if (existing.state === input.status && existing.promotedJobId === (input.job_id ?? null)) return result({ outcome: "already_completed", snapshot: existing });
      throw new Error(`LinkedIn snapshot is ${existing.state}, not claimed`);
    }
    return result({ outcome: "completed", snapshot: completed });
  });

  server.registerTool("get_job", {
    title: "Get job",
    description: "Return a job and all related operational context.",
    inputSchema: z.object({ job_id: z.string().uuid().optional(), url: z.string().url().optional() }).refine((value) => Boolean(value.job_id || value.url), "Provide job_id or url"),
  }, async (input) => result({ job: await fullJob(input.job_id, input.url) }));

  server.registerTool("list_jobs", {
    title: "List jobs",
    description: "List jobs with optional status, freshness, text, and inbox filters.",
    inputSchema: z.object({ status: jobStatusSchema.optional(), since: z.string().optional(), query: z.string().optional(), untriaged_only: z.boolean().optional(), limit: z.number().int().min(1).max(200).default(50) }),
  }, async (input) => {
    const filters = [];
    if (input.status) filters.push(eq(jobs.status, input.status));
    if (input.since) filters.push(gte(jobs.discoveredAt, optionalDate(input.since)!));
    if (input.untriaged_only) filters.push(isNull(jobs.triagedAt));
    if (input.query) filters.push(or(ilike(jobs.title, `%${input.query}%`), ilike(companies.name, `%${input.query}%`), ilike(jobs.location, `%${input.query}%`))!);
    const rows = await getDb().select({ job: jobs, company: companies }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(filters.length ? and(...filters) : undefined).orderBy(desc(jobs.discoveredAt)).limit(input.limit);
    return result({ jobs: rows });
  });

  server.registerTool("get_pipeline", {
    title: "Get pipeline",
    description: "Return active jobs grouped by status.",
    inputSchema: z.object({}),
  }, async () => {
    const rows = await getDb().select({ job: jobs, company: companies }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(sql`${jobs.status} not in ('irrelevant','archived')`).orderBy(desc(jobs.statusChangedAt));
    const pipeline = Object.groupBy(rows, (row) => row.job.status);
    return result({ pipeline });
  });

  server.registerTool("get_feedback_summary", {
    title: "Get feedback summary",
    description: "Aggregate the owner's verdicts and reason taxonomy; repeated reasons are the search learning signal.",
    inputSchema: z.object({ since: z.string().optional() }),
  }, async (input) => {
    const since = optionalDate(input.since) ?? new Date(0);
    const db = getDb();
    const [verdicts, reasonRows] = await Promise.all([
      db.select({ verdict: feedback.verdict, count: sql<number>`count(*)::int` }).from(feedback).where(gte(feedback.createdAt, since)).groupBy(feedback.verdict),
      db.select({ reasons: feedback.reasons }).from(feedback).where(gte(feedback.createdAt, since)),
    ]);
    const reasons = aggregateFeedbackReasons(reasonRows);
    return result({ since: since.toISOString(), verdicts, reasons });
  });

  server.registerTool("get_strategy", {
    title: "Get strategy",
    description: "Return historical strategy references, key events, weekly targets, saved settings and the exact versioned effective_policy used for job decisions. effective_policy and policy_hash are authoritative; historical prose is not an operational rule source.",
    inputSchema: z.object({}),
  }, async () => {
    const db = getDb();
    const [sections, events, targets, settings, policy] = await Promise.all([db.select().from(strategySections).orderBy(asc(strategySections.sort)), db.select().from(keyEvents).orderBy(asc(keyEvents.startsOn)), db.select().from(weeklyTargets).orderBy(asc(weeklyTargets.weekStart)), ownerSettings(), db.transaction((tx) => loadEffectiveSearchPolicy(tx))]);
    const [preferences] = await db.select({ timeZone: notificationPreferences.timeZone }).from(notificationPreferences).where(eq(notificationPreferences.id, "owner")).limit(1);
    return result({ sections, events, weekly_targets: targets, settings, effective_policy: policy.effectivePolicy, policy_hash: policy.policyHash, time_zone: preferences?.timeZone ?? "UTC" });
  });

  server.registerTool("get_cv_variant", {
    title: "Get CV variant",
    description: "Return one private CV variant by slug.",
    inputSchema: z.object({ slug: z.string() }),
  }, async ({ slug }) => {
    const [variant] = await getDb().select().from(cvVariants).where(eq(cvVariants.slug, slug)).limit(1);
    return result({ variant: variant ?? null });
  });

  server.registerTool("list_cv_variants", {
    title: "List CV variants",
    description: "List CV variant metadata without full content.",
    inputSchema: z.object({}),
  }, async () => result({ variants: await getDb().select({ id: cvVariants.id, slug: cvVariants.slug, name: cvVariants.name, summary: cvVariants.summary, version: cvVariants.version, updated_at: cvVariants.updatedAt }).from(cvVariants).orderBy(asc(cvVariants.name)) }));

  server.registerTool("record_rejection", {
    title: "Record rejection",
    description: "Record a factual rejection outcome and learning, move the job to Rejected, and never send a reply.",
    inputSchema: z.object({
      job_id: z.string().uuid(),
      occurred_at: scheduledInstantSchema,
      stage: z.string().optional(),
      reason_category: z.string().optional(),
      reason_detail: z.string().optional(),
      learning_md: z.string().optional(),
      response_needed: z.boolean().default(false),
    }),
  }, async (input) => {
    const db = getDb();
    const occurredAt = new Date(input.occurred_at);
    await db.transaction(async (tx) => {
      const [current] = await tx.select({ status: jobs.status, triagedAt: jobs.triagedAt }).from(jobs).where(eq(jobs.id, input.job_id)).limit(1);
      if (!current) throw new Error("Job not found");
      await tx.insert(rejections).values({ jobId: input.job_id, occurredAt, stage: input.stage, reasonCategory: input.reason_category, reasonDetail: input.reason_detail, learningMd: input.learning_md, responseNeeded: input.response_needed }).onConflictDoUpdate({
        target: rejections.jobId,
        set: { occurredAt, stage: input.stage, reasonCategory: input.reason_category, reasonDetail: input.reason_detail, learningMd: input.learning_md, responseNeeded: input.response_needed, updatedAt: new Date() },
      });
      if (current.status !== "rejected") {
        await tx.update(jobs).set({ status: "rejected", statusChangedAt: occurredAt }).where(eq(jobs.id, input.job_id));
        await tx.insert(jobStatusHistory).values({ jobId: input.job_id, fromStatus: current.status, toStatus: "rejected", note: input.reason_detail ?? "Rejection recorded", fromTriaged: Boolean(current.triagedAt), actor: "assistant" });
      }
      await tx.insert(activityLog).values({ actor: "assistant", type: "rejection_recorded", jobId: input.job_id, message: "Recorded a rejection and its learning.", payload: { occurred_at: occurredAt.toISOString(), stage: input.stage, reason_category: input.reason_category, reason_detail: input.reason_detail, learning_md: input.learning_md, response_needed: input.response_needed } });
    });
    return result({ job_id: input.job_id, status: "rejected", recorded: true, response_needed: input.response_needed });
  });

  server.registerTool("create_interview", {
    title: "Create interview",
    description: "Create an interview and automatically promote the job to screening, interviewing, or offer when appropriate.",
    inputSchema: z.object({
      job_id: z.string().uuid(),
      stage: interviewStageSchema,
      scheduled_at: scheduledInstantSchema,
      time_zone: timeZoneSchema.default(DEFAULT_INTERVIEW_TIME_ZONE),
      location_or_link: z.string().nullable().optional(),
      notes_md: z.string().nullable().optional(),
    }),
  }, async (input) => {
    const { interview, statusChange, deduplicated } = await createInterviewRecord({
      jobId: input.job_id,
      stage: input.stage,
      scheduledAt: new Date(input.scheduled_at),
      timeZone: input.time_zone,
      locationOrLink: input.location_or_link,
      notesMd: input.notes_md,
    }, "assistant");
    return result({ interview_id: interview.id, job_id: interview.jobId, status_change: statusChange, deduplicated });
  });

  server.registerTool("update_interview", {
    title: "Update interview",
    description: "Update interview stage, schedule, timezone, meeting details, notes, or outcome. Schedule changes are recorded as reschedules.",
    inputSchema: z.object({
      interview_id: z.string().uuid(),
      stage: interviewStageSchema.optional(),
      scheduled_at: scheduledInstantSchema.optional(),
      time_zone: timeZoneSchema.optional(),
      location_or_link: z.string().nullable().optional(),
      notes_md: z.string().nullable().optional(),
      outcome: interviewOutcomeSchema.optional(),
    }).refine((value) => Object.keys(value).some((key) => key !== "interview_id"), "Provide at least one field to update"),
  }, async (input) => {
    const { interview, eventType, statusChange } = await updateInterviewRecord({
      interviewId: input.interview_id,
      stage: input.stage,
      scheduledAt: input.scheduled_at ? new Date(input.scheduled_at) : undefined,
      timeZone: input.time_zone,
      locationOrLink: input.location_or_link,
      notesMd: input.notes_md,
      outcome: input.outcome,
    }, "assistant");
    return result({ interview_id: interview.id, event_type: eventType, status_change: statusChange, updated: true });
  });

  server.registerTool("reschedule_interview", {
    title: "Reschedule interview",
    description: "Move an interview to a new ISO 8601 instant and optionally change its display timezone or notes.",
    inputSchema: z.object({
      interview_id: z.string().uuid(),
      scheduled_at: scheduledInstantSchema,
      time_zone: timeZoneSchema.optional(),
      notes_md: z.string().nullable().optional(),
    }),
  }, async (input) => {
    const { interview, eventType, statusChange } = await updateInterviewRecord({
      interviewId: input.interview_id,
      scheduledAt: new Date(input.scheduled_at),
      timeZone: input.time_zone,
      notesMd: input.notes_md,
    }, "assistant");
    return result({ interview_id: interview.id, event_type: eventType, status_change: statusChange, rescheduled: true });
  });

  server.registerTool("get_interview", {
    title: "Get interview",
    description: "Return an interview, role, interviewers, and prep briefs.",
    inputSchema: z.object({ interview_id: z.string().uuid() }),
  }, async ({ interview_id }) => {
    const db = getDb();
    const [interview] = await db.select({ interview: interviews, job: jobs, company: companies }).from(interviews).innerJoin(jobs, eq(interviews.jobId, jobs.id)).innerJoin(companies, eq(jobs.companyId, companies.id)).where(eq(interviews.id, interview_id)).limit(1);
    if (!interview) return result({ interview: null });
    const [people, briefs] = await Promise.all([db.select().from(interviewers).where(eq(interviewers.interviewId, interview_id)), db.select().from(prepBriefs).where(eq(prepBriefs.interviewId, interview_id)).orderBy(desc(prepBriefs.createdAt))]);
    return result({ ...interview, interviewers: people, prep_briefs: briefs });
  });

  server.registerTool("get_upcoming_interviews", {
    title: "Get upcoming interviews",
    description: "List upcoming pending interviews.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
  }, async ({ limit }) => result({ interviews: await getDb().select({ interview: interviews, job: jobs, company: companies }).from(interviews).innerJoin(jobs, eq(interviews.jobId, jobs.id)).innerJoin(companies, eq(jobs.companyId, companies.id)).where(and(gte(interviews.scheduledAt, new Date()), eq(interviews.outcome, "pending"))).orderBy(asc(interviews.scheduledAt)).limit(limit) }));

  server.registerTool("get_open_requests", {
    title: "Get open requests",
    description: "List unanswered requests. `purpose` distinguishes question (answer it), search_now (run a job search immediately; payload.search_settings is the snapshot to use), and scheduled_search. Never infer purpose from the text.",
    inputSchema: z.object({}),
  }, async () => result({ requests: await getDb().select().from(requests).where(and(or(eq(requests.status, "open"), eq(requests.status, "in_progress")), sql`not exists (select 1 from agent_tasks where request_id = ${requests.id})`)).orderBy(asc(requests.createdAt)) }));

  server.registerTool("set_analysis_state", {
    title: "Set analysis state",
    description: "Mark a job fit analysis pending, in progress, or failed. Completed analysis must use set_fit_analysis.",
    inputSchema: z.object({ job_id: z.string().uuid(), status: z.enum(["pending", "in_progress", "failed"]), error: z.string().nullable().optional() }),
  }, async (input) => {
    await getDb().update(jobs).set({ analysisStatus: input.status, analysisError: input.status === "failed" ? input.error ?? "Analysis failed without a recorded reason." : null }).where(eq(jobs.id, input.job_id));
    return result({ job_id: input.job_id, analysis_status: input.status });
  });

  server.registerTool("start_automation_run", {
    title: "Start automation run",
    description: "Create or idempotently restart a durable assistant workflow run before doing its work.",
    inputSchema: z.object({ run_key: z.string().min(1), workflow: z.string().min(1), scheduled_for: scheduledInstantSchema.optional(), payload: z.record(z.string(), z.unknown()).optional() }),
  }, async (input) => {
    const now = new Date();
    const [run] = await getDb().insert(automationRuns).values({ runKey: input.run_key, workflow: input.workflow, scheduledFor: optionalDate(input.scheduled_for), status: "running", startedAt: now, payload: input.payload ?? {} }).onConflictDoUpdate({
      target: automationRuns.runKey,
      set: { workflow: input.workflow, scheduledFor: optionalDate(input.scheduled_for), status: "running", startedAt: now, completedAt: null, errorMd: null, payload: input.payload ?? {} },
    }).returning({ id: automationRuns.id, startedAt: automationRuns.startedAt });
    return result({ run_id: run.id, run_key: input.run_key, status: "running", started_at: run.startedAt });
  });

  server.registerTool("complete_automation_run", {
    title: "Complete automation run",
    description: "Finish an instrumented assistant workflow with counts, summary, or a visible failure.",
    inputSchema: z.object({ run_key: z.string().min(1), status: z.enum(["succeeded", "failed", "skipped"]), jobs_found: z.number().int().min(0).optional(), jobs_analyzed: z.number().int().min(0).optional(), summary_md: z.string().nullable().optional(), error_md: z.string().nullable().optional(), payload: z.record(z.string(), z.unknown()).optional() }),
  }, async (input) => {
    if (input.status === "failed" && !input.error_md) throw new Error("error_md is required for a failed run");
    const [run] = await getDb().update(automationRuns).set({ status: input.status, completedAt: new Date(), jobsFound: input.jobs_found ?? 0, jobsAnalyzed: input.jobs_analyzed ?? 0, summaryMd: input.summary_md, errorMd: input.error_md, payload: input.payload ?? {} }).where(eq(automationRuns.runKey, input.run_key)).returning({ id: automationRuns.id });
    if (!run) throw new Error("Automation run not found; call start_automation_run first");
    return result({ run_id: run.id, run_key: input.run_key, status: input.status });
  });

  server.registerTool("get_automation_state", {
    title: "Get automation state",
    description: "Return recent automation runs, analysis backlog, open requests, search settings, and the owner's notification preferences (each switch names one notification kind; interview_reminder_hours is the lead time; minimum_fit_score gates high-fit alerts).",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(30) }),
  }, async ({ limit }) => {
    const db = getDb();
    const followUpDays = (await ownerSettings())?.followUpDays ?? 14;
    const followUpCutoff = new Date(Date.now() - followUpDays * 86_400_000);
    const [runs, analysisBacklog, openRequests, preferences, dueFollowUps, upcomingInterviews, settings] = await Promise.all([
      db.select().from(automationRuns).orderBy(desc(automationRuns.startedAt)).limit(limit),
      db.select({ job: jobs, company: companies }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(inArray(jobs.analysisStatus, ["pending", "in_progress", "failed"])).orderBy(asc(jobs.discoveredAt)).limit(100),
      db.select().from(requests).where(and(inArray(requests.status, ["open", "in_progress", "failed"]), sql`not exists (select 1 from agent_tasks where request_id = ${requests.id})`)).orderBy(asc(requests.createdAt)),
      db.select().from(notificationPreferences).where(eq(notificationPreferences.id, "owner")).limit(1),
      db.select({ job: jobs, company: companies }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(and(eq(jobs.status, "applied"), lte(jobs.statusChangedAt, followUpCutoff), sql`not exists (select 1 from activity_log followup where followup.job_id = ${jobs.id} and followup.type = 'followup_completed' and followup.created_at > ${jobs.statusChangedAt})`)).orderBy(asc(jobs.statusChangedAt)).limit(50),
      db.select({ interview: interviews, job: jobs, company: companies }).from(interviews).innerJoin(jobs, eq(interviews.jobId, jobs.id)).innerJoin(companies, eq(jobs.companyId, companies.id)).where(and(gte(interviews.scheduledAt, new Date()), lte(interviews.scheduledAt, new Date(Date.now() + 48 * 60 * 60 * 1000)), eq(interviews.outcome, "pending"))).orderBy(asc(interviews.scheduledAt)),
      ownerSettings(),
    ]);
    return result({ runs, analysis_backlog: analysisBacklog, requests: openRequests, notification_preferences: preferences[0] ?? null, search_settings: settings, due_follow_ups: dueFollowUps, upcoming_interviews: upcomingInterviews });
  });

  server.registerTool("get_metrics", {
    title: "Get metrics",
    description: "Return funnel and target metrics for a week or the current week.",
    inputSchema: z.object({ week: z.string().optional() }),
  }, async (input) => {
    const week = input.week ?? new Date(Date.now() - ((new Date().getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
    const db = getDb();
    const [funnel, target, feedbackMix] = await Promise.all([
      db.select({ status: jobs.status, count: sql<number>`count(*)::int` }).from(jobs).groupBy(jobs.status),
      db.select().from(weeklyTargets).where(eq(weeklyTargets.weekStart, week)).limit(1),
      db.select({ verdict: feedback.verdict, count: sql<number>`count(*)::int` }).from(feedback).where(gte(feedback.createdAt, new Date(`${week}T00:00:00Z`))).groupBy(feedback.verdict),
    ]);
    return result({ week, target: target[0] ?? null, funnel, feedback: feedbackMix });
  });
}, { serverInfo: { name: "jobhunt", version: "1.0.0" } });

async function authorized(request: Request) {
  if (!bearerIsValid(request.headers.get("authorization"))) return unauthorized();
  return handler(request);
}

export { authorized as GET, authorized as POST };
