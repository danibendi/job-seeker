-- Lets the owner dismiss stale CV proposals and failed requests. IF NOT EXISTS keeps
-- this a no-op on databases that already carry either label from an earlier install.
ALTER TYPE "public"."request_status" ADD VALUE IF NOT EXISTS 'dismissed';--> statement-breakpoint
ALTER TYPE "public"."tailoring_status" ADD VALUE IF NOT EXISTS 'dismissed';
