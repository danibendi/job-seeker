CREATE TABLE "agent_worker_pauses" (
	"worker_id" varchar(120) PRIMARY KEY NOT NULL,
	"executor" "agent_task_executor" NOT NULL,
	"reason" varchar(40) NOT NULL,
	"task_id" uuid,
	"paused_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_worker_pauses" ADD CONSTRAINT "agent_worker_pauses_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE set null ON UPDATE no action;