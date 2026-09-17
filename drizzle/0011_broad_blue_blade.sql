CREATE TABLE "linkedin_search_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"linkedin_job_id" varchar(40) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linkedin_search_lanes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"lane_key" varchar(160) NOT NULL,
	"query" text NOT NULL,
	"search_url" text NOT NULL,
	"next_page" integer DEFAULT 1 NOT NULL,
	"next_cursor" text,
	"last_page_job_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exhausted" boolean DEFAULT false NOT NULL,
	"exhausted_at" timestamp with time zone,
	"stop_reason" varchar(80),
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linkedin_search_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"lane_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"job_ids" jsonb NOT NULL,
	"source_cursor" text,
	"next_cursor" text,
	"exhausted" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linkedin_search_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"scope_key" varchar(240) NOT NULL,
	"plan_hash" varchar(64) NOT NULL,
	"policy_hash" varchar(64) NOT NULL,
	"mode" varchar(20) NOT NULL,
	"scan_started_at" timestamp with time zone NOT NULL,
	"lookback_seconds" integer,
	"collection_complete" boolean DEFAULT false NOT NULL,
	"details_complete" boolean DEFAULT false NOT NULL,
	"stop_reason" varchar(80),
	"stopped_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "linkedin_ingest_receipts" ADD COLUMN "snapshot_ready_job_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "linkedin_search_details" ADD CONSTRAINT "linkedin_search_details_run_id_linkedin_search_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."linkedin_search_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_lanes" ADD CONSTRAINT "linkedin_search_lanes_run_id_linkedin_search_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."linkedin_search_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_pages" ADD CONSTRAINT "linkedin_search_pages_run_id_linkedin_search_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."linkedin_search_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_pages" ADD CONSTRAINT "linkedin_search_pages_lane_id_linkedin_search_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."linkedin_search_lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linkedin_search_runs" ADD CONSTRAINT "linkedin_search_runs_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_search_details_run_job_unique" ON "linkedin_search_details" USING btree ("run_id","linkedin_job_id");--> statement-breakpoint
CREATE INDEX "linkedin_search_details_run_status_idx" ON "linkedin_search_details" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_search_lanes_run_key_unique" ON "linkedin_search_lanes" USING btree ("run_id","lane_key");--> statement-breakpoint
CREATE INDEX "linkedin_search_lanes_run_idx" ON "linkedin_search_lanes" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_search_pages_lane_page_unique" ON "linkedin_search_pages" USING btree ("lane_id","page_number");--> statement-breakpoint
CREATE INDEX "linkedin_search_pages_run_idx" ON "linkedin_search_pages" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_search_runs_task_unique" ON "linkedin_search_runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "linkedin_search_runs_scope_plan_idx" ON "linkedin_search_runs" USING btree ("scope_key","plan_hash","scan_started_at");