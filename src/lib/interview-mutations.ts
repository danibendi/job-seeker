import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  activityLog,
  eventsOutbox,
  interviews,
  jobs,
  jobStatusHistory,
  type InterviewOutcome,
  type InterviewStage,
} from "@/db/schema";
import { isValidTimeZone, synchronizedJobStatus } from "@/lib/interview-workflow";

type MutationActor = "owner" | "assistant";

export type CreateInterviewInput = {
  jobId: string;
  stage: InterviewStage;
  scheduledAt: Date;
  timeZone: string;
  locationOrLink?: string | null;
  notesMd?: string | null;
};

export type UpdateInterviewInput = {
  interviewId: string;
  stage?: InterviewStage;
  scheduledAt?: Date;
  timeZone?: string;
  locationOrLink?: string | null;
  notesMd?: string | null;
  outcome?: InterviewOutcome;
};

function assertInterviewInput(scheduledAt: Date, timeZone: string) {
  if (Number.isNaN(scheduledAt.getTime())) throw new Error("Invalid interview date");
  if (!isValidTimeZone(timeZone)) throw new Error("Invalid interview timezone");
}

export async function createInterviewRecord(input: CreateInterviewInput, actor: MutationActor) {
  assertInterviewInput(input.scheduledAt, input.timeZone);
  return getDb().transaction(async (tx) => {
    const [job] = await tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, input.jobId)).limit(1);
    if (!job) throw new Error("Job not found");
    const [created] = await tx.insert(interviews).values({
      jobId: input.jobId,
      stage: input.stage,
      scheduledAt: input.scheduledAt,
      timeZone: input.timeZone,
      locationOrLink: input.locationOrLink,
      notesMd: input.notesMd,
      checklist: [
        { id: "research", label: "Review the company and interviewer brief", done: false },
        { id: "stories", label: "Choose two STAR examples", done: false },
        { id: "questions", label: "Prepare questions to ask", done: false },
        { id: "tech", label: "Test the meeting link, camera, and audio", done: false },
        { id: "followup", label: "Plan the post-interview thank-you note", done: false },
      ],
    }).onConflictDoNothing({ target: [interviews.jobId, interviews.stage, interviews.scheduledAt] }).returning();
    if (!created) {
      const [existing] = await tx.select().from(interviews).where(and(eq(interviews.jobId, input.jobId), eq(interviews.stage, input.stage), eq(interviews.scheduledAt, input.scheduledAt))).limit(1);
      if (!existing) throw new Error("Interview could not be created");
      return { interview: existing, statusChange: null, deduplicated: true as const };
    }
    const statusChange = await synchronizeStatus(tx, input.jobId, job.status, input.stage, "pending", actor);
    const payload = {
      interview_id: created.id,
      job_id: input.jobId,
      stage: input.stage,
      scheduled_at: input.scheduledAt.toISOString(),
      time_zone: input.timeZone,
      location_or_link: input.locationOrLink ?? null,
      notes_md: input.notesMd ?? null,
      status_change: statusChange,
    };
    await recordMutation(tx, actor, "interview_added", payload, `Added a ${input.stage.replaceAll("_", " ")} interview.`, input.jobId);
    return { interview: created, statusChange, deduplicated: false as const };
  });
}

export async function updateInterviewRecord(input: UpdateInterviewInput, actor: MutationActor) {
  return getDb().transaction(async (tx) => {
    const [row] = await tx.select({ interview: interviews, jobStatus: jobs.status })
      .from(interviews)
      .innerJoin(jobs, eq(interviews.jobId, jobs.id))
      .where(eq(interviews.id, input.interviewId))
      .limit(1);
    if (!row) throw new Error("Interview not found");

    const scheduledAt = input.scheduledAt ?? row.interview.scheduledAt;
    const timeZone = input.timeZone ?? row.interview.timeZone;
    const stage = input.stage ?? row.interview.stage;
    const outcome = input.outcome ?? row.interview.outcome;
    assertInterviewInput(scheduledAt, timeZone);
    const scheduleChanged = scheduledAt.getTime() !== row.interview.scheduledAt.getTime()
      || timeZone !== row.interview.timeZone;
    const values = {
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
      ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
      ...(input.locationOrLink !== undefined ? { locationOrLink: input.locationOrLink } : {}),
      ...(input.notesMd !== undefined ? { notesMd: input.notesMd } : {}),
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    };
    const [updated] = await tx.update(interviews).set(values).where(eq(interviews.id, input.interviewId)).returning();
    const statusChange = await synchronizeStatus(tx, row.interview.jobId, row.jobStatus, stage, outcome, actor);
    const eventType = scheduleChanged ? "interview_rescheduled" : "interview_updated";
    const payload = {
      interview_id: input.interviewId,
      job_id: row.interview.jobId,
      stage,
      scheduled_at: scheduledAt.toISOString(),
      time_zone: timeZone,
      location_or_link: updated.locationOrLink,
      notes_md: updated.notesMd,
      outcome,
      ...(scheduleChanged ? {
        previous_scheduled_at: row.interview.scheduledAt.toISOString(),
        previous_time_zone: row.interview.timeZone,
      } : {}),
      status_change: statusChange,
    };
    const message = scheduleChanged
      ? `Rescheduled the ${stage.replaceAll("_", " ")} interview.`
      : `Updated the ${stage.replaceAll("_", " ")} interview.`;
    await recordMutation(tx, actor, eventType, payload, message, row.interview.jobId);
    return { interview: updated, eventType, statusChange };
  });
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

async function synchronizeStatus(
  tx: Tx,
  jobId: string,
  currentStatus: typeof jobs.$inferSelect.status,
  stage: InterviewStage,
  outcome: InterviewOutcome,
  actor: MutationActor,
) {
  const nextStatus = synchronizedJobStatus(currentStatus, stage, outcome);
  if (nextStatus === currentStatus) return null;
  const now = new Date();
  const [before] = await tx.select({ triagedAt: jobs.triagedAt }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
  await tx.update(jobs).set({ status: nextStatus, statusChangedAt: now }).where(eq(jobs.id, jobId));
  await tx.insert(jobStatusHistory).values({
    jobId,
    fromStatus: currentStatus,
    toStatus: nextStatus,
    note: `Automatically synchronized from ${stage.replaceAll("_", " ")} interview`,
    fromTriaged: Boolean(before?.triagedAt),
    actor,
  });
  return { from_status: currentStatus, to_status: nextStatus };
}

async function recordMutation(
  tx: Tx,
  actor: MutationActor,
  type: string,
  payload: Record<string, unknown>,
  message: string,
  jobId: string,
) {
  if (actor === "owner") await tx.insert(eventsOutbox).values({ type, payload });
  await tx.insert(activityLog).values({ actor, type, payload, message, jobId });
}
