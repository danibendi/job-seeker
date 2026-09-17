ALTER TABLE "agent_tasks" ADD COLUMN "started_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "agent_tasks" AS task
SET "started_at" = started.at
FROM (
  SELECT payload->>'task_id' AS task_id, max(created_at) AS at
  FROM "activity_log"
  WHERE type = 'agent_task_started'
  GROUP BY payload->>'task_id'
) AS started
WHERE task.id::text = started.task_id;
