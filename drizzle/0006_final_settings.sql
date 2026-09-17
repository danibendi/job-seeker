CREATE TABLE "cv_documents" (
	"variant_id" uuid PRIMARY KEY NOT NULL,
	"file_name" varchar(240) NOT NULL,
	"content_base64" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "daily_summary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "weekly_digest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "tailoring_ready" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "request_answered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "watchlist_findings" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "interview_reminder_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "purpose" varchar(80) DEFAULT 'question' NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "search_settings" ADD COLUMN "target_roles" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "search_settings" ADD COLUMN "locations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "search_settings" ADD COLUMN "remote" jsonb DEFAULT '{"enabled":false,"countries":[],"includeWorldwide":false,"includeUnspecified":false}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "search_settings" ADD COLUMN "schedule" jsonb DEFAULT '{"enabled":false,"frequency":"weekdays","time":"09:00","days":[],"maxJobs":15}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "search_settings" ADD COLUMN "tailor_cv_suggestions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "cv_documents" ADD CONSTRAINT "cv_documents_variant_id_cv_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."cv_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_settings" DROP COLUMN "target_locations";--> statement-breakpoint
ALTER TABLE "search_settings" DROP COLUMN "remote_eligibility";--> statement-breakpoint
ALTER TABLE "search_settings" DROP COLUMN "lanes";--> statement-breakpoint
ALTER TABLE "search_settings" DROP COLUMN "available_from";
