CREATE TYPE "public"."linkedin_search_track" AS ENUM('fresh', 'backfill');--> statement-breakpoint
DROP INDEX "linkedin_search_runs_task_unique";--> statement-breakpoint
DROP INDEX "linkedin_search_runs_scope_plan_idx";--> statement-breakpoint
ALTER TABLE "linkedin_search_lanes" ADD COLUMN "lookback_seconds" integer;--> statement-breakpoint
ALTER TABLE "linkedin_search_runs" ADD COLUMN "track" "linkedin_search_track" DEFAULT 'backfill' NOT NULL;--> statement-breakpoint
UPDATE "linkedin_search_runs" SET "track" = 'fresh' WHERE "mode" = 'incremental';--> statement-breakpoint
UPDATE "linkedin_search_lanes" AS "lane"
SET "lookback_seconds" = "run"."lookback_seconds"
FROM "linkedin_search_runs" AS "run"
WHERE "lane"."run_id" = "run"."id" AND "run"."track" = 'fresh';--> statement-breakpoint
WITH "inserted" AS (
  INSERT INTO "linkedin_search_details" ("run_id", "linkedin_job_id")
  SELECT DISTINCT "run"."id", "accepted"."linkedin_job_id"
  FROM "linkedin_search_runs" AS "run"
  JOIN "linkedin_ingest_receipts" AS "receipt"
    ON "receipt"."collector_run_key" LIKE 'task:' || "run"."task_id"::text || ':%'
  CROSS JOIN LATERAL jsonb_array_elements_text(CASE
    WHEN jsonb_typeof("receipt"."accepted_job_ids") = 'array' THEN "receipt"."accepted_job_ids"
    ELSE '[]'::jsonb
  END) AS "accepted"("linkedin_job_id")
  JOIN "linkedin_snapshots" AS "snapshot"
    ON "snapshot"."candidate_id" = "receipt"."candidate_id"
   AND "snapshot"."linkedin_job_id" = "accepted"."linkedin_job_id"
  WHERE "snapshot"."state" IN ('discovered_compact', 'failed_transient')
     OR ("snapshot"."state" = 'rejected' AND (
       "snapshot"."evaluated_policy_hash" IS DISTINCT FROM "run"."policy_hash"
       OR "snapshot"."completed_at" IS NULL
       OR "snapshot"."completed_at" < now() - interval '7 days'
     ))
  ON CONFLICT ("run_id", "linkedin_job_id") DO NOTHING
  RETURNING "run_id"
)
UPDATE "linkedin_search_runs"
SET "details_complete" = false, "completed_at" = NULL, "updated_at" = now()
WHERE "id" IN (SELECT "run_id" FROM "inserted");--> statement-breakpoint
CREATE UNIQUE INDEX "linkedin_search_runs_task_track_unique" ON "linkedin_search_runs" USING btree ("task_id","track");--> statement-breakpoint
CREATE INDEX "linkedin_search_runs_scope_plan_track_idx" ON "linkedin_search_runs" USING btree ("scope_key","plan_hash","track","scan_started_at");
