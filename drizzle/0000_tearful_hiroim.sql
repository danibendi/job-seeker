CREATE TYPE "public"."actor" AS ENUM('owner', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."agency_status" AS ENUM('not_contacted', 'contacted', 'active', 'dead');--> statement-breakpoint
CREATE TYPE "public"."company_tier" AS ENUM('a', 'b', 'c');--> statement-breakpoint
CREATE TYPE "public"."feedback_verdict" AS ENUM('relevant', 'irrelevant', 'maybe');--> statement-breakpoint
CREATE TYPE "public"."interview_outcome" AS ENUM('pending', 'passed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."interview_stage" AS ENUM('recruiter_screen', 'hiring_manager', 'technical', 'panel', 'onsite', 'final', 'offer_discussion');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('sourced', 'to_apply', 'applied', 'screening', 'interviewing', 'offer', 'rejected', 'withdrawn', 'irrelevant', 'archived');--> statement-breakpoint
CREATE TYPE "public"."outreach_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('open', 'in_progress', 'answered');--> statement-breakpoint
CREATE TYPE "public"."tailoring_status" AS ENUM('proposed', 'reviewed');--> statement-breakpoint
CREATE TYPE "public"."watchlist_cadence" AS ENUM('weekly', 'daily');--> statement-breakpoint
CREATE TYPE "public"."watchlist_kind" AS ENUM('company', 'board', 'alert');--> statement-breakpoint
CREATE TYPE "public"."work_mode" AS ENUM('onsite', 'hybrid', 'remote');--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" "actor" NOT NULL,
	"type" varchar(120) NOT NULL,
	"job_id" uuid,
	"message" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(240) NOT NULL,
	"website" text,
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "agency_status" DEFAULT 'not_contacted' NOT NULL,
	"notes_md" text,
	"last_contact_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(240) NOT NULL,
	"slug" varchar(240) NOT NULL,
	"website" text,
	"careers_url" text,
	"location" text,
	"tier" "company_tier",
	"dossier_md" text,
	"notes_md" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cv_tailorings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"cv_variant_id" uuid NOT NULL,
	"proposal_md" text NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "tailoring_status" DEFAULT 'proposed' NOT NULL,
	"owner_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cv_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(120) NOT NULL,
	"name" varchar(240) NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"content_md" text DEFAULT '' NOT NULL,
	"drive_file_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest_date" date NOT NULL,
	"content_md" text NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" varchar(120) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	"ack_note" text
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"verdict" "feedback_verdict" NOT NULL,
	"reasons" text[] DEFAULT '{}' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interviewers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interview_id" uuid NOT NULL,
	"name" varchar(240) NOT NULL,
	"role_title" text,
	"linkedin_url" text,
	"research_md" text
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"stage" "interview_stage" NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"location_or_link" text,
	"notes_md" text,
	"outcome" "interview_outcome" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"from_status" "job_status",
	"to_status" "job_status" NOT NULL,
	"note" text,
	"actor" "actor" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" varchar(400) NOT NULL,
	"url" text NOT NULL,
	"source" varchar(160) NOT NULL,
	"location" text,
	"work_mode" "work_mode",
	"salary_text" text,
	"description_md" text,
	"posted_at" timestamp with time zone,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text NOT NULL,
	"fit_score" integer,
	"fit_analysis_md" text,
	"fit_factors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_cv_variant_id" uuid,
	"status" "job_status" DEFAULT 'sourced' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"triaged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "key_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(300) NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"location" text,
	"url" text,
	"notes" text,
	"rsvp_status" varchar(80)
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"ip" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"success" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_id" uuid,
	"company_id" uuid,
	"channel" varchar(120) NOT NULL,
	"direction" "outreach_direction" NOT NULL,
	"summary" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_action" text,
	"next_action_date" date
);
--> statement-breakpoint
CREATE TABLE "prep_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interview_id" uuid NOT NULL,
	"content_md" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text NOT NULL,
	"job_id" uuid,
	"status" "request_status" DEFAULT 'open' NOT NULL,
	"response_md" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "strategy_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(120) NOT NULL,
	"title" varchar(240) NOT NULL,
	"content_md" text DEFAULT '' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" varchar(240) NOT NULL,
	"url" text NOT NULL,
	"kind" "watchlist_kind" NOT NULL,
	"cadence" "watchlist_cadence" NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_findings_md" text
);
--> statement-breakpoint
CREATE TABLE "weekly_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_start" date NOT NULL,
	"applications_target" integer NOT NULL,
	"conversations_target" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_tailorings" ADD CONSTRAINT "cv_tailorings_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_tailorings" ADD CONSTRAINT "cv_tailorings_cv_variant_id_cv_variants_id_fk" FOREIGN KEY ("cv_variant_id") REFERENCES "public"."cv_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviewers" ADD CONSTRAINT "interviewers_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_status_history" ADD CONSTRAINT "job_status_history_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_recommended_cv_variant_id_cv_variants_id_fk" FOREIGN KEY ("recommended_cv_variant_id") REFERENCES "public"."cv_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_log" ADD CONSTRAINT "outreach_log_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_log" ADD CONSTRAINT "outreach_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prep_briefs" ADD CONSTRAINT "prep_briefs_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_created_idx" ON "activity_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agencies_name_unique" ON "agencies" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_slug_unique" ON "companies" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "cv_tailorings_job_idx" ON "cv_tailorings" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cv_variants_slug_unique" ON "cv_variants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "events_outbox_pending_idx" ON "events_outbox" USING btree ("acked_at","created_at");--> statement-breakpoint
CREATE INDEX "feedback_job_idx" ON "feedback" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "interviewers_interview_idx" ON "interviewers" USING btree ("interview_id");--> statement-breakpoint
CREATE INDEX "interviews_scheduled_idx" ON "interviews" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "job_status_history_job_idx" ON "job_status_history" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key_unique" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_triaged_idx" ON "jobs" USING btree ("triaged_at");--> statement-breakpoint
CREATE INDEX "jobs_discovered_idx" ON "jobs" USING btree ("discovered_at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_created_idx" ON "login_attempts" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "prep_briefs_interview_idx" ON "prep_briefs" USING btree ("interview_id");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_sections_key_unique" ON "strategy_sections" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_url_unique" ON "watchlist_items" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_targets_week_unique" ON "weekly_targets" USING btree ("week_start");
