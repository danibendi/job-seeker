UPDATE "workspaces"
SET "candidate_id" = 'candidate-' || replace(gen_random_uuid()::text, '-', ''), "updated_at" = now()
WHERE "id" = 'owner'
  AND "candidate_id" = 'workspace-owner'
  AND NOT EXISTS (SELECT 1 FROM "linkedin_snapshots")
  AND NOT EXISTS (SELECT 1 FROM "linkedin_ingest_receipts")
  AND NOT EXISTS (SELECT 1 FROM "agent_tasks" WHERE coalesce("payload"->>'candidateId', '') <> '');
