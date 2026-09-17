CREATE TYPE "public"."analysis_status" AS ENUM('pending', 'in_progress', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."automation_status" AS ENUM('running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
ALTER TYPE "public"."request_status" ADD VALUE 'failed';--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_key" varchar(240) NOT NULL,
	"workflow" varchar(120) NOT NULL,
	"status" "automation_status" DEFAULT 'running' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"jobs_found" integer DEFAULT 0 NOT NULL,
	"jobs_analyzed" integer DEFAULT 0 NOT NULL,
	"summary_md" text,
	"error_md" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" varchar(40) PRIMARY KEY DEFAULT 'owner' NOT NULL,
	"high_fit_jobs" boolean DEFAULT false NOT NULL,
	"interview_reminders" boolean DEFAULT false NOT NULL,
	"follow_ups_due" boolean DEFAULT false NOT NULL,
	"automation_failures" boolean DEFAULT false NOT NULL,
	"minimum_fit_score" integer DEFAULT 80 NOT NULL,
	"time_zone" varchar(80) DEFAULT 'UTC' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rejections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stage" varchar(120),
	"reason_category" varchar(120),
	"reason_detail" text,
	"learning_md" text,
	"response_needed" boolean DEFAULT false NOT NULL,
	"response_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "questions_md" text;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "post_interview_notes_md" text;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "checklist" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "analysis_status" "analysis_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
UPDATE "jobs" SET "analysis_status" = 'complete' WHERE "fit_score" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "analysis_error" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "error_md" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "rejections" ADD CONSTRAINT "rejections_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_key_unique" ON "automation_runs" USING btree ("run_key");--> statement-breakpoint
CREATE INDEX "automation_runs_started_idx" ON "automation_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rejections_job_unique" ON "rejections" USING btree ("job_id");
