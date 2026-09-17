CREATE TYPE "public"."agent_task_executor" AS ENUM('hermes', 'codex', 'api', 'unassigned');--> statement-breakpoint
CREATE TYPE "public"."agent_task_kind" AS ENUM('search', 'question', 'linkedin_evaluate');--> statement-breakpoint
CREATE TYPE "public"."agent_task_status" AS ENUM('queued', 'running', 'waiting_for_user', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "agent_execution_settings" (
	"id" varchar(40) PRIMARY KEY DEFAULT 'owner' NOT NULL,
	"search_executor" "agent_task_executor" DEFAULT 'unassigned' NOT NULL,
	"evaluation_executor" "agent_task_executor" DEFAULT 'unassigned' NOT NULL,
	"search_sources" text[] DEFAULT '{}' NOT NULL,
	"max_pages" integer DEFAULT 10 NOT NULL,
	"max_detail_fetches" integer DEFAULT 30 NOT NULL,
	"max_duration_seconds" integer DEFAULT 1200 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_schedule_occurrences" (
	"occurrence_key" varchar(240) PRIMARY KEY NOT NULL,
	"local_date" date NOT NULL,
	"task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid,
	"snapshot_id" uuid,
	"parent_task_id" uuid,
	"kind" "agent_task_kind" NOT NULL,
	"executor" "agent_task_executor" DEFAULT 'unassigned' NOT NULL,
	"status" "agent_task_status" DEFAULT 'queued' NOT NULL,
	"dedupe_key" varchar(240) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"result_hash" varchar(64),
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"claimed_by" varchar(240),
	"claim_token_hash" varchar(64),
	"lease_expires_at" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_for" timestamp with time zone,
	"external_ref" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "linkedin_ingest_receipts" ADD COLUMN "payload_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "linkedin_snapshots" ADD COLUMN "last_observed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "linkedin_snapshots" SET "last_observed_at" = "first_observed_at";--> statement-breakpoint
ALTER TABLE "linkedin_snapshots" ALTER COLUMN "last_observed_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "linkedin_snapshots" ALTER COLUMN "last_observed_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "linkedin_snapshots" ADD COLUMN "evidence_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "linkedin_snapshots" ADD COLUMN "evaluated_policy_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_schedule_occurrences" ADD CONSTRAINT "agent_schedule_occurrences_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_snapshot_id_linkedin_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."linkedin_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_schedule_occurrences_task_idx" ON "agent_schedule_occurrences" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tasks_dedupe_key_unique" ON "agent_tasks" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "agent_tasks_claim_idx" ON "agent_tasks" USING btree ("status","executor","available_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_lease_idx" ON "agent_tasks" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_request_idx" ON "agent_tasks" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "agent_tasks_snapshot_idx" ON "agent_tasks" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "agent_tasks_parent_idx" ON "agent_tasks" USING btree ("parent_task_id");--> statement-breakpoint
INSERT INTO "agent_execution_settings" ("id") VALUES ('owner') ON CONFLICT ("id") DO NOTHING;
