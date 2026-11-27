CREATE TABLE IF NOT EXISTS "agent_worker_contacts" (
	"worker_id" varchar(120) PRIMARY KEY NOT NULL,
	"executor" "agent_task_executor" NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
