CREATE TABLE "search_settings" (
	"id" varchar(40) PRIMARY KEY DEFAULT 'owner' NOT NULL,
	"minimum_fit_score" integer DEFAULT 60 NOT NULL,
	"follow_up_days" integer DEFAULT 14 NOT NULL,
	"target_locations" text[] DEFAULT '{}' NOT NULL,
	"work_modes" text[] DEFAULT '{}' NOT NULL,
	"remote_eligibility" text[] DEFAULT '{}' NOT NULL,
	"lanes" text[] DEFAULT '{}' NOT NULL,
	"languages" text[] DEFAULT '{}' NOT NULL,
	"excluded_companies" text[] DEFAULT '{}' NOT NULL,
	"excluded_keywords" text[] DEFAULT '{}' NOT NULL,
	"available_from" date,
	"notes_md" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
