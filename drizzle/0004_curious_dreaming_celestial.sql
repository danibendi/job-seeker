CREATE TYPE "public"."linkedin_snapshot_state" AS ENUM('discovered_compact', 'snapshot_ready', 'claimed', 'promoted', 'rejected', 'needs_review', 'failed_transient');--> statement-breakpoint
CREATE TABLE "linkedin_ingest_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" varchar(240) NOT NULL,
	"candidate_id" varchar(120) NOT NULL,
	"collector_run_key" varchar(240) NOT NULL,
	"accepted_job_ids" jsonb NOT NULL,
	"item_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linkedin_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" varchar(120) NOT NULL,
	"linkedin_job_id" varchar(40) NOT NULL,
	"canonical_url" text NOT NULL,
	"title" varchar(500) NOT NULL,
	"company" varchar(300),
	"location" text,
	"work_mode_text" varchar(120),
	"search_lane" varchar(160),
	"result_rank" integer,
	"collector_run_key" varchar(240) NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"compact_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot_evidence" jsonb,
	"title_decision" jsonb,
	"detail_decision" jsonb,
	"state" "linkedin_snapshot_state" DEFAULT 'discovered_compact' NOT NULL,
	"claim_count" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completion_reason" text,
	"promoted_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "linkedin_snapshots" ADD CONSTRAINT "linkedin_snapshots_promoted_job_id_jobs_id_fk" FOREIGN KEY ("promoted_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_ingest_receipts_idempotency_unique" ON "linkedin_ingest_receipts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_snapshots_job_id_unique" ON "linkedin_snapshots" USING btree ("linkedin_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_snapshots_url_unique" ON "linkedin_snapshots" USING btree ("canonical_url");--> statement-breakpoint
CREATE INDEX "linkedin_snapshots_state_created_idx" ON "linkedin_snapshots" USING btree ("state","created_at");