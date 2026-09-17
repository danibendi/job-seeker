import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { OfficeLocation, RemoteSettings, SearchSchedule } from "../lib/settings";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const companyTier = pgEnum("company_tier", ["a", "b", "c"]);
export const workMode = pgEnum("work_mode", ["onsite", "hybrid", "remote"]);
export const jobStatus = pgEnum("job_status", [
  "sourced", "to_apply", "applied", "screening", "interviewing", "offer",
  "rejected", "withdrawn", "irrelevant", "archived",
]);
export const actor = pgEnum("actor", ["owner", "assistant", "system"]);
export const linkedinSearchTrack = pgEnum("linkedin_search_track", ["fresh", "backfill"]);
export const feedbackVerdict = pgEnum("feedback_verdict", ["relevant", "irrelevant", "maybe"]);
export const tailoringStatus = pgEnum("tailoring_status", ["proposed", "reviewed"]);
export const interviewStage = pgEnum("interview_stage", [
  "recruiter_screen", "hiring_manager", "technical", "panel", "onsite", "final", "offer_discussion",
]);
export const interviewOutcome = pgEnum("interview_outcome", ["pending", "passed", "failed", "cancelled"]);
export const agencyStatus = pgEnum("agency_status", ["not_contacted", "contacted", "active", "dead"]);
export const outreachDirection = pgEnum("outreach_direction", ["in", "out"]);
export const watchlistKind = pgEnum("watchlist_kind", ["company", "board", "alert"]);
export const watchlistCadence = pgEnum("watchlist_cadence", ["weekly", "daily"]);
export const requestStatus = pgEnum("request_status", ["open", "in_progress", "answered", "failed"]);
export const analysisStatus = pgEnum("analysis_status", ["pending", "in_progress", "complete", "failed"]);
export const automationStatus = pgEnum("automation_status", ["running", "succeeded", "failed", "skipped"]);
export const linkedinSnapshotState = pgEnum("linkedin_snapshot_state", [
  "discovered_compact",
  "snapshot_ready",
  "claimed",
  "promoted",
  "rejected",
  "needs_review",
  "failed_transient",
]);
export const agentTaskKind = pgEnum("agent_task_kind", ["search", "question", "linkedin_evaluate"]);
export const agentTaskExecutor = pgEnum("agent_task_executor", ["hermes", "codex", "api", "unassigned"]);
export const agentTaskStatus = pgEnum("agent_task_status", ["queued", "running", "waiting_for_user", "succeeded", "failed", "cancelled"]);

export type FitFactor = {
  factor: string;
  weight: number;
  direction: "+" | "-";
  note: string;
};

export type TailoringChange = {
  id: string;
  section: string;
  current: string;
  proposed: string;
  rationale: string;
  decision: "pending" | "accepted" | "rejected";
};

export type InterviewChecklistItem = {
  id: string;
  label: string;
  done: boolean;
};

export const workspaces = pgTable("workspaces", {
  id: varchar("id", { length: 40 }).primaryKey().default("owner"),
  candidateId: varchar("candidate_id", { length: 120 }).notNull().default("workspace-owner"),
  displayName: varchar("display_name", { length: 160 }).notNull().default("Job Seeker"),
  ownerName: varchar("owner_name", { length: 160 }).notNull().default(""),
  assistantLabel: varchar("assistant_label", { length: 160 }).notNull().default("Assistant"),
  locale: varchar("locale", { length: 35 }).notNull().default("en"),
  timeZone: varchar("time_zone", { length: 80 }).notNull().default("UTC"),
  onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
  ...timestamps,
});

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 300 }).notNull(),
  slug: varchar("slug", { length: 240 }).notNull(),
  website: text("website"),
  careersUrl: text("careers_url"),
  location: text("location"),
  tier: companyTier("tier"),
  dossierMd: text("dossier_md"),
  notesMd: text("notes_md"),
  ...timestamps,
}, (table) => [uniqueIndex("companies_slug_unique").on(table.slug)]);

export const cvVariants = pgTable("cv_variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 120 }).notNull(),
  name: varchar("name", { length: 240 }).notNull(),
  summary: text("summary").notNull().default(""),
  contentMd: text("content_md").notNull().default(""),
  driveFileId: text("drive_file_id"),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cv_variants_slug_unique").on(table.slug)]);

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 500 }).notNull(),
  url: text("url").notNull(),
  source: varchar("source", { length: 160 }).notNull(),
  location: text("location"),
  workMode: workMode("work_mode"),
  salaryText: text("salary_text"),
  descriptionMd: text("description_md"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  dedupeKey: text("dedupe_key").notNull(),
  fitScore: integer("fit_score"),
  fitAnalysisMd: text("fit_analysis_md"),
  fitFactors: jsonb("fit_factors").$type<FitFactor[]>().notNull().default([]),
  analysisStatus: analysisStatus("analysis_status").notNull().default("pending"),
  analysisError: text("analysis_error"),
  recommendedCvVariantId: uuid("recommended_cv_variant_id").references(() => cvVariants.id, { onDelete: "set null" }),
  status: jobStatus("status").notNull().default("sourced"),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
  triagedAt: timestamp("triaged_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("jobs_dedupe_key_unique").on(table.dedupeKey),
  index("jobs_status_idx").on(table.status),
  index("jobs_triaged_idx").on(table.triagedAt),
  index("jobs_discovered_idx").on(table.discoveredAt),
]);

export const jobStatusHistory = pgTable("job_status_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  fromStatus: jobStatus("from_status"),
  toStatus: jobStatus("to_status").notNull(),
  note: text("note"),
  /** Whether the job had already been looked at (triaged) before this move; lets undo put it back in the right bucket. */
  fromTriaged: boolean("from_triaged"),
  actor: actor("actor").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("job_status_history_job_idx").on(table.jobId)]);

export const feedback = pgTable("feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  verdict: feedbackVerdict("verdict").notNull(),
  reasons: text("reasons").array().notNull().default([]),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("feedback_job_idx").on(table.jobId)]);

export const cvTailorings = pgTable("cv_tailorings", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  cvVariantId: uuid("cv_variant_id").notNull().references(() => cvVariants.id, { onDelete: "cascade" }),
  proposalMd: text("proposal_md").notNull(),
  changes: jsonb("changes").$type<TailoringChange[]>().notNull().default([]),
  status: tailoringStatus("status").notNull().default("proposed"),
  ownerNote: text("owner_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (table) => [index("cv_tailorings_job_idx").on(table.jobId)]);

export const interviews = pgTable("interviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  stage: interviewStage("stage").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  timeZone: varchar("time_zone", { length: 80 }).notNull().default("UTC"),
  locationOrLink: text("location_or_link"),
  notesMd: text("notes_md"),
  questionsMd: text("questions_md"),
  postInterviewNotesMd: text("post_interview_notes_md"),
  checklist: jsonb("checklist").$type<InterviewChecklistItem[]>().notNull().default([]),
  outcome: interviewOutcome("outcome").notNull().default("pending"),
}, (table) => [
  index("interviews_scheduled_idx").on(table.scheduledAt),
  uniqueIndex("interviews_unique_slot").on(table.jobId, table.stage, table.scheduledAt),
]);

export const interviewers = pgTable("interviewers", {
  id: uuid("id").primaryKey().defaultRandom(),
  interviewId: uuid("interview_id").notNull().references(() => interviews.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 240 }).notNull(),
  roleTitle: text("role_title"),
  linkedinUrl: text("linkedin_url"),
  researchMd: text("research_md"),
}, (table) => [
  index("interviewers_interview_idx").on(table.interviewId),
  uniqueIndex("interviewers_unique_name").on(table.interviewId, table.name),
]);

export const prepBriefs = pgTable("prep_briefs", {
  id: uuid("id").primaryKey().defaultRandom(),
  interviewId: uuid("interview_id").notNull().references(() => interviews.id, { onDelete: "cascade" }),
  contentMd: text("content_md").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
}, (table) => [index("prep_briefs_interview_idx").on(table.interviewId)]);

export const agencies = pgTable("agencies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 240 }).notNull(),
  website: text("website"),
  contacts: jsonb("contacts").$type<Record<string, unknown>[]>().notNull().default([]),
  status: agencyStatus("status").notNull().default("not_contacted"),
  notesMd: text("notes_md"),
  lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
}, (table) => [uniqueIndex("agencies_name_unique").on(table.name)]);

export const outreachLog = pgTable("outreach_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  agencyId: uuid("agency_id").references(() => agencies.id, { onDelete: "set null" }),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
  channel: varchar("channel", { length: 120 }).notNull(),
  direction: outreachDirection("direction").notNull(),
  summary: text("summary").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  nextAction: text("next_action"),
  nextActionDate: date("next_action_date"),
});

export const watchlistItems = pgTable("watchlist_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: varchar("label", { length: 240 }).notNull(),
  url: text("url").notNull(),
  kind: watchlistKind("kind").notNull(),
  cadence: watchlistCadence("cadence").notNull(),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastFindingsMd: text("last_findings_md"),
}, (table) => [uniqueIndex("watchlist_url_unique").on(table.url)]);

export const strategySections = pgTable("strategy_sections", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: varchar("key", { length: 120 }).notNull(),
  title: varchar("title", { length: 240 }).notNull(),
  contentMd: text("content_md").notNull().default(""),
  sort: integer("sort").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("strategy_sections_key_unique").on(table.key)]);

export const keyEvents = pgTable("key_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 300 }).notNull(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on"),
  location: text("location"),
  url: text("url"),
  notes: text("notes"),
  rsvpStatus: varchar("rsvp_status", { length: 80 }),
});

export const weeklyTargets = pgTable("weekly_targets", {
  id: uuid("id").primaryKey().defaultRandom(),
  weekStart: date("week_start").notNull(),
  applicationsTarget: integer("applications_target").notNull(),
  conversationsTarget: integer("conversations_target").notNull(),
}, (table) => [uniqueIndex("weekly_targets_week_unique").on(table.weekStart)]);

export const requests = pgTable("requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  text: text("text").notNull(),
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
  status: requestStatus("status").notNull().default("open"),
  purpose: varchar("purpose", { length: 80 }).notNull().default("question"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  responseMd: text("response_md"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
  errorMd: text("error_md"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rejections = pgTable("rejections", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  stage: varchar("stage", { length: 120 }),
  reasonCategory: varchar("reason_category", { length: 120 }),
  reasonDetail: text("reason_detail"),
  learningMd: text("learning_md"),
  responseNeeded: boolean("response_needed").notNull().default(false),
  responseSent: boolean("response_sent").notNull().default(false),
  ...timestamps,
}, (table) => [uniqueIndex("rejections_job_unique").on(table.jobId)]);

export const automationRuns = pgTable("automation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  runKey: varchar("run_key", { length: 240 }).notNull(),
  workflow: varchar("workflow", { length: 120 }).notNull(),
  status: automationStatus("status").notNull().default("running"),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  jobsFound: integer("jobs_found").notNull().default(0),
  jobsAnalyzed: integer("jobs_analyzed").notNull().default(0),
  summaryMd: text("summary_md"),
  errorMd: text("error_md"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  uniqueIndex("automation_runs_key_unique").on(table.runKey),
  index("automation_runs_started_idx").on(table.startedAt),
]);

export const notificationPreferences = pgTable("notification_preferences", {
  id: varchar("id", { length: 40 }).primaryKey().default("owner"),
  highFitJobs: boolean("high_fit_jobs").notNull().default(false),
  interviewReminders: boolean("interview_reminders").notNull().default(false),
  followUpsDue: boolean("follow_ups_due").notNull().default(false),
  automationFailures: boolean("automation_failures").notNull().default(false),
  dailySummary: boolean("daily_summary").notNull().default(false),
  weeklyDigest: boolean("weekly_digest").notNull().default(false),
  tailoringReady: boolean("tailoring_ready").notNull().default(false),
  requestAnswered: boolean("request_answered").notNull().default(false),
  watchlistFindings: boolean("watchlist_findings").notNull().default(false),
  interviewReminderHours: integer("interview_reminder_hours").notNull().default(24),
  minimumFitScore: integer("minimum_fit_score").notNull().default(80),
  timeZone: varchar("time_zone", { length: 80 }).notNull().default("UTC"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const searchSettings = pgTable("search_settings", {
  id: varchar("id", { length: 40 }).primaryKey().default("owner"),
  minimumFitScore: integer("minimum_fit_score").notNull().default(60),
  followUpDays: integer("follow_up_days").notNull().default(14),
  targetRoles: text("target_roles").array().notNull().default([]),
  languages: text("languages").array().notNull().default([]),
  excludedCompanies: text("excluded_companies").array().notNull().default([]),
  excludedKeywords: text("excluded_keywords").array().notNull().default([]),
  locations: jsonb("locations").$type<OfficeLocation[]>().notNull().default([]),
  workModes: text("work_modes").array().notNull().default([]),
  remote: jsonb("remote").$type<RemoteSettings>().notNull().default({ enabled: false, countries: [], includeWorldwide: false, includeUnspecified: false }),
  schedule: jsonb("schedule").$type<SearchSchedule>().notNull().default({ enabled: false, frequency: "weekdays", time: "09:00", days: [], maxJobs: 15 }),
  tailorCvSuggestions: boolean("tailor_cv_suggestions").notNull().default(true),
  notesMd: text("notes_md"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cvDocuments = pgTable("cv_documents", {
  variantId: uuid("variant_id").primaryKey().references(() => cvVariants.id, { onDelete: "cascade" }),
  fileName: varchar("file_name", { length: 240 }).notNull(),
  contentBase64: text("content_base64").notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const digests = pgTable("digests", {
  id: uuid("id").primaryKey().defaultRandom(),
  digestDate: date("digest_date").notNull(),
  contentMd: text("content_md").notNull(),
  stats: jsonb("stats").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const activityLog = pgTable("activity_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: actor("actor").notNull(),
  type: varchar("type", { length: 120 }).notNull(),
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
  message: text("message").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("activity_log_created_idx").on(table.createdAt)]);

export const eventsOutbox = pgTable("events_outbox", {
  id: serial("id").primaryKey(),
  type: varchar("type", { length: 120 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  ackedAt: timestamp("acked_at", { withTimezone: true }),
  ackNote: text("ack_note"),
}, (table) => [index("events_outbox_pending_idx").on(table.ackedAt, table.createdAt)]);

export const linkedinSnapshots = pgTable("linkedin_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  candidateId: varchar("candidate_id", { length: 120 }).notNull(),
  linkedinJobId: varchar("linkedin_job_id", { length: 40 }).notNull(),
  canonicalUrl: text("canonical_url").notNull(),
  title: varchar("title", { length: 500 }).notNull(),
  company: varchar("company", { length: 300 }),
  location: text("location"),
  workModeText: varchar("work_mode_text", { length: 120 }),
  searchLane: varchar("search_lane", { length: 160 }),
  resultRank: integer("result_rank"),
  collectorRunKey: varchar("collector_run_key", { length: 240 }).notNull(),
  firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
  lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull().defaultNow(),
  compactEvidence: jsonb("compact_evidence").$type<Record<string, unknown>>().notNull().default({}),
  snapshotEvidence: jsonb("snapshot_evidence").$type<Record<string, unknown>>(),
  evidenceHash: varchar("evidence_hash", { length: 64 }),
  evaluatedPolicyHash: varchar("evaluated_policy_hash", { length: 64 }),
  titleDecision: jsonb("title_decision").$type<Record<string, unknown>>(),
  detailDecision: jsonb("detail_decision").$type<Record<string, unknown>>(),
  state: linkedinSnapshotState("state").notNull().default("discovered_compact"),
  claimCount: integer("claim_count").notNull().default(0),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completionReason: text("completion_reason"),
  promotedJobId: uuid("promoted_job_id").references(() => jobs.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => [
  uniqueIndex("linkedin_snapshots_job_id_unique").on(table.linkedinJobId),
  uniqueIndex("linkedin_snapshots_url_unique").on(table.canonicalUrl),
  index("linkedin_snapshots_state_created_idx").on(table.state, table.createdAt),
]);

export const linkedinIngestReceipts = pgTable("linkedin_ingest_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: varchar("idempotency_key", { length: 240 }).notNull(),
  candidateId: varchar("candidate_id", { length: 120 }).notNull(),
  collectorRunKey: varchar("collector_run_key", { length: 240 }).notNull(),
  acceptedJobIds: jsonb("accepted_job_ids").$type<string[]>().notNull(),
  snapshotReadyJobIds: jsonb("snapshot_ready_job_ids").$type<string[]>().notNull().default([]),
  itemCount: integer("item_count").notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("linkedin_ingest_receipts_idempotency_unique").on(table.idempotencyKey)]);

export const agentTasks = pgTable("agent_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id").references(() => requests.id, { onDelete: "set null" }),
  snapshotId: uuid("snapshot_id").references(() => linkedinSnapshots.id, { onDelete: "set null" }),
  parentTaskId: uuid("parent_task_id"),
  kind: agentTaskKind("kind").notNull(),
  executor: agentTaskExecutor("executor").notNull().default("unassigned"),
  status: agentTaskStatus("status").notNull().default("queued"),
  dedupeKey: varchar("dedupe_key", { length: 240 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  checkpoint: jsonb("checkpoint").$type<Record<string, unknown>>().notNull().default({}),
  result: jsonb("result").$type<Record<string, unknown>>(),
  resultHash: varchar("result_hash", { length: 64 }),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  claimedBy: varchar("claimed_by", { length: 240 }),
  claimTokenHash: varchar("claim_token_hash", { length: 64 }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  externalRef: text("external_ref"),
  lastError: text("last_error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("agent_tasks_dedupe_key_unique").on(table.dedupeKey),
  index("agent_tasks_claim_idx").on(table.status, table.executor, table.availableAt),
  index("agent_tasks_lease_idx").on(table.status, table.leaseExpiresAt),
  index("agent_tasks_request_idx").on(table.requestId),
  index("agent_tasks_snapshot_idx").on(table.snapshotId),
  index("agent_tasks_parent_idx").on(table.parentTaskId),
]);

export const agentExecutionSettings = pgTable("agent_execution_settings", {
  id: varchar("id", { length: 40 }).primaryKey().default("owner"),
  searchExecutor: agentTaskExecutor("search_executor").notNull().default("unassigned"),
  evaluationExecutor: agentTaskExecutor("evaluation_executor").notNull().default("unassigned"),
  searchSources: text("search_sources").array().notNull().default([]),
  maxPages: integer("max_pages").notNull().default(10),
  maxDetailFetches: integer("max_detail_fetches").notNull().default(30),
  maxDurationSeconds: integer("max_duration_seconds").notNull().default(1200),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentScheduleOccurrences = pgTable("agent_schedule_occurrences", {
  occurrenceKey: varchar("occurrence_key", { length: 240 }).primaryKey(),
  localDate: date("local_date").notNull(),
  taskId: uuid("task_id").notNull().references(() => agentTasks.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("agent_schedule_occurrences_task_idx").on(table.taskId)]);

export const linkedinSearchRuns = pgTable("linkedin_search_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id").notNull().references(() => agentTasks.id, { onDelete: "cascade" }),
  track: linkedinSearchTrack("track").notNull().default("backfill"),
  scopeKey: varchar("scope_key", { length: 240 }).notNull(),
  planHash: varchar("plan_hash", { length: 64 }).notNull(),
  policyHash: varchar("policy_hash", { length: 64 }).notNull(),
  mode: varchar("mode", { length: 20 }).notNull(),
  scanStartedAt: timestamp("scan_started_at", { withTimezone: true }).notNull(),
  lookbackSeconds: integer("lookback_seconds"),
  collectionComplete: boolean("collection_complete").notNull().default(false),
  detailsComplete: boolean("details_complete").notNull().default(false),
  stopReason: varchar("stop_reason", { length: 80 }),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("linkedin_search_runs_task_track_unique").on(table.taskId, table.track),
  index("linkedin_search_runs_scope_plan_track_idx").on(table.scopeKey, table.planHash, table.track, table.scanStartedAt),
]);

export const linkedinSearchLanes = pgTable("linkedin_search_lanes", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => linkedinSearchRuns.id, { onDelete: "cascade" }),
  laneKey: varchar("lane_key", { length: 160 }).notNull(),
  query: text("query").notNull(),
  searchUrl: text("search_url").notNull(),
  lookbackSeconds: integer("lookback_seconds"),
  nextPage: integer("next_page").notNull().default(1),
  nextCursor: text("next_cursor"),
  lastPageJobIds: jsonb("last_page_job_ids").$type<string[]>().notNull().default([]),
  exhausted: boolean("exhausted").notNull().default(false),
  exhaustedAt: timestamp("exhausted_at", { withTimezone: true }),
  stopReason: varchar("stop_reason", { length: 80 }),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("linkedin_search_lanes_run_key_unique").on(table.runId, table.laneKey),
  index("linkedin_search_lanes_run_idx").on(table.runId),
]);

export const linkedinSearchPages = pgTable("linkedin_search_pages", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => linkedinSearchRuns.id, { onDelete: "cascade" }),
  laneId: uuid("lane_id").notNull().references(() => linkedinSearchLanes.id, { onDelete: "cascade" }),
  pageNumber: integer("page_number").notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  jobIds: jsonb("job_ids").$type<string[]>().notNull(),
  sourceCursor: text("source_cursor"),
  nextCursor: text("next_cursor"),
  exhausted: boolean("exhausted").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("linkedin_search_pages_lane_page_unique").on(table.laneId, table.pageNumber),
  index("linkedin_search_pages_run_idx").on(table.runId),
]);

export const linkedinSearchDetails = pgTable("linkedin_search_details", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => linkedinSearchRuns.id, { onDelete: "cascade" }),
  linkedinJobId: varchar("linkedin_job_id", { length: 40 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex("linkedin_search_details_run_job_unique").on(table.runId, table.linkedinJobId),
  index("linkedin_search_details_run_status_idx").on(table.runId, table.status),
]);

export const loginAttempts = pgTable("login_attempts", {
  id: serial("id").primaryKey(),
  ip: varchar("ip", { length: 128 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  success: integer("success").notNull().default(0),
}, (table) => [index("login_attempts_ip_created_idx").on(table.ip, table.createdAt)]);

export const FEEDBACK_REASONS = [
  "location", "seniority_too_low", "seniority_too_high", "domain_mismatch",
  "language_requirement", "salary", "company", "role_type", "start_date",
  "visa", "already_applied", "other",
] as const;

export type JobStatus = (typeof jobStatus.enumValues)[number];
export type InterviewOutcome = (typeof interviewOutcome.enumValues)[number];
export type InterviewStage = (typeof interviewStage.enumValues)[number];
