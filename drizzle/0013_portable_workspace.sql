DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'actor' AND e.enumlabel = 'anna') THEN
    ALTER TYPE "public"."actor" RENAME VALUE 'anna' TO 'owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'actor' AND e.enumlabel = 'hermes') THEN
    ALTER TYPE "public"."actor" RENAME VALUE 'hermes' TO 'assistant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'agent_task_executor' AND e.enumlabel = 'api') THEN
    ALTER TYPE "public"."agent_task_executor" ADD VALUE 'api' BEFORE 'unassigned';
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cv_tailorings' AND column_name = 'anna_note'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cv_tailorings' AND column_name = 'owner_note'
  ) THEN
    ALTER TABLE "cv_tailorings" RENAME COLUMN "anna_note" TO "owner_note";
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "notification_preferences" ALTER COLUMN "id" SET DEFAULT 'owner';--> statement-breakpoint
ALTER TABLE "notification_preferences" ALTER COLUMN "time_zone" SET DEFAULT 'UTC';--> statement-breakpoint
ALTER TABLE "search_settings" ALTER COLUMN "id" SET DEFAULT 'owner';--> statement-breakpoint
ALTER TABLE "search_settings" ALTER COLUMN "remote" SET DEFAULT '{"enabled":false,"countries":[],"includeWorldwide":false,"includeUnspecified":false}'::jsonb;--> statement-breakpoint
ALTER TABLE "search_settings" ALTER COLUMN "schedule" SET DEFAULT '{"enabled":false,"frequency":"weekdays","time":"09:00","days":[],"maxJobs":15}'::jsonb;--> statement-breakpoint
ALTER TABLE "agent_execution_settings" ALTER COLUMN "id" SET DEFAULT 'owner';--> statement-breakpoint
ALTER TABLE "agent_execution_settings" ALTER COLUMN "search_sources" SET DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "interviews" ALTER COLUMN "time_zone" SET DEFAULT 'UTC';--> statement-breakpoint

DO $$ BEGIN
  IF (EXISTS (SELECT 1 FROM "notification_preferences" WHERE id = 'anna') AND EXISTS (SELECT 1 FROM "notification_preferences" WHERE id = 'owner'))
    OR (EXISTS (SELECT 1 FROM "search_settings" WHERE id = 'anna') AND EXISTS (SELECT 1 FROM "search_settings" WHERE id = 'owner'))
    OR (EXISTS (SELECT 1 FROM "agent_execution_settings" WHERE id = 'anna') AND EXISTS (SELECT 1 FROM "agent_execution_settings" WHERE id = 'owner')) THEN
    RAISE EXCEPTION 'Ambiguous singleton upgrade: both legacy and owner rows exist. Reconcile them before running migration 0013.';
  END IF;
END $$;--> statement-breakpoint
UPDATE "notification_preferences" SET id = 'owner' WHERE id = 'anna';--> statement-breakpoint
UPDATE "search_settings" SET id = 'owner' WHERE id = 'anna';--> statement-breakpoint
UPDATE "agent_execution_settings" SET id = 'owner' WHERE id = 'anna';--> statement-breakpoint
UPDATE "agent_schedule_occurrences" SET "occurrence_key" = regexp_replace("occurrence_key", '^anna:', 'owner:') WHERE "occurrence_key" LIKE 'anna:%';--> statement-breakpoint

CREATE TABLE "workspaces" (
  "id" varchar(40) PRIMARY KEY DEFAULT 'owner' NOT NULL,
  "candidate_id" varchar(120) DEFAULT 'workspace-owner' NOT NULL,
  "display_name" varchar(160) DEFAULT 'Job Seeker' NOT NULL,
  "owner_name" varchar(160) DEFAULT '' NOT NULL,
  "assistant_label" varchar(160) DEFAULT 'Assistant' NOT NULL,
  "locale" varchar(35) DEFAULT 'en' NOT NULL,
  "time_zone" varchar(80) DEFAULT 'UTC' NOT NULL,
  "onboarding_completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

INSERT INTO "workspaces" ("id", "candidate_id", "time_zone")
SELECT 'owner',
  COALESCE(
    (SELECT candidate_id FROM linkedin_snapshots WHERE candidate_id <> '' GROUP BY candidate_id ORDER BY count(*) DESC, candidate_id LIMIT 1),
    (SELECT candidate_id FROM linkedin_ingest_receipts WHERE candidate_id <> '' GROUP BY candidate_id ORDER BY count(*) DESC, candidate_id LIMIT 1),
    (SELECT payload->>'candidateId' FROM agent_tasks WHERE coalesce(payload->>'candidateId', '') <> '' GROUP BY payload->>'candidateId' ORDER BY count(*) DESC, payload->>'candidateId' LIMIT 1),
    'workspace-owner'
  ),
  COALESCE((SELECT time_zone FROM notification_preferences WHERE id = 'owner'), 'UTC')
ON CONFLICT (id) DO NOTHING;
