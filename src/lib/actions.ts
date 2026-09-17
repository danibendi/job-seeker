"use server";

import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";
import { isOpenAccess } from "@/lib/open-access";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import {
  activityLog,
  agentTasks,
  agencies,
  companies,
  cvDocuments,
  cvTailorings,
  cvVariants,
  eventsOutbox,
  feedback,
  interviewers,
  interviews,
  jobs,
  jobStatusHistory,
  notificationPreferences,
  rejections,
  requests,
  searchSettings,
  watchlistItems,
  weeklyTargets,
  workspaces,
  type InterviewOutcome,
  type InterviewStage,
  type TailoringChange,
  FEEDBACK_REASONS,
} from "@/db/schema";
import { cancelAgentTask, enqueueAgentTask, enqueueQuestionTask, enqueueSearchTask, getAgentExecutionSettings, retryAgentTask, updateAgentExecutionSettings } from "@/lib/agent-tasks";
import { createInterviewRecord, updateInterviewRecord } from "@/lib/interview-mutations";
import { availableJobTransitions, canTransitionJob, isJobDestination, resolveJobDestination } from "@/lib/job-workflow";
import {
  INTERVIEW_OUTCOMES,
  INTERVIEW_STAGES,
  parseZonedDateTime,
} from "@/lib/interview-workflow";
import { driveFileId } from "@/lib/cv-document";
import { settingsFromRow } from "@/lib/data";
import { LIMITS, SCHEDULE_FREQUENCIES, WEEKDAYS, WORK_MODES, normalizeLocations, normalizeRemote, normalizeSchedule, uniqueTokens, type SearchSettingsValues } from "@/lib/settings";
import { DEFAULT_TIME_ZONE, isValidTimeZone, startOfWeek } from "@/lib/time";
import { lockSearchSettings } from "@/lib/search-settings-store";
import { getWorkspace, workspaceCandidateLocked } from "@/lib/workspace";
import { normalizeWorkspaceInput, WORKSPACE_ID } from "@/lib/workspace-values";
import { makeDedupeKey, slugify } from "@/lib/format";
import { companyDisplayName, companyDisplayNameFitsStorage, companySlugCandidates, normalizeCompanyIdentity } from "@/lib/company-identity";

async function requireAgentControlSession() {
  if (!isOpenAccess() && !await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value)) throw new Error("Sign in to control agent tasks");
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

async function emitOwnerEvent(tx: Tx, type: string, payload: Record<string, unknown>, message: string, jobId?: string) {
  await tx.insert(eventsOutbox).values({ type, payload });
  await tx.insert(activityLog).values({ actor: "owner", type, payload, message, jobId });
}

function required(form: FormData, key: string) {
  const value = form.get(key)?.toString().trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function boundedInt(form: FormData, key: string, min: number, max: number) {
  const value = Number(required(form, key));
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be a whole number between ${min} and ${max}`);
  return value;
}

async function currentSettings(tx: Tx): Promise<SearchSettingsValues> {
  const [row] = await tx.select().from(searchSettings).where(eq(searchSettings.id, WORKSPACE_ID)).limit(1);
  return settingsFromRow(row);
}

async function currentTimeZone(tx: Tx) {
  const workspace = await getWorkspace(tx);
  const [row] = await tx.select({ timeZone: notificationPreferences.timeZone }).from(notificationPreferences).where(eq(notificationPreferences.id, WORKSPACE_ID)).limit(1);
  return row?.timeZone && isValidTimeZone(row.timeZone) ? row.timeZone : workspace.timeZone || DEFAULT_TIME_ZONE;
}

/** Writes the typed settings row used directly by discovery and evaluation. */
async function persistSettings(tx: Tx, patch: Partial<SearchSettingsValues>, pace?: { applicationsTarget: number; conversationsTarget: number }, message = "Updated search settings.") {
  const merged = { ...(await lockSearchSettings(tx)), ...patch };
  const now = new Date();
  const timeZone = await currentTimeZone(tx);
  await tx.insert(searchSettings).values({ id: WORKSPACE_ID, ...merged, updatedAt: now }).onConflictDoUpdate({ target: searchSettings.id, set: { ...merged, updatedAt: now } });
  const weekStart = startOfWeek(now, timeZone);
  if (pace) {
    await tx.insert(weeklyTargets).values({ weekStart, ...pace }).onConflictDoUpdate({ target: weeklyTargets.weekStart, set: pace });
    await tx.update(weeklyTargets).set(pace).where(gte(weeklyTargets.weekStart, weekStart));
  }
  await emitOwnerEvent(tx, "settings_updated", { settings: merged, time_zone: timeZone, weekly_pace: pace ?? null }, message);
}

function revalidateSettings() {
  for (const path of ["/", "/pipeline", "/settings", "/insights", "/activity", "/interviews"]) revalidatePath(path);
}

function tokens(form: FormData, key: string, limit: number) {
  return uniqueTokens(form.getAll(key).map(String), limit);
}

export async function addFeedback(form: FormData) {
  await requireAgentControlSession();
  const jobId = required(form, "jobId");
  const verdict = required(form, "verdict") as "relevant" | "irrelevant" | "maybe";
  if (!["relevant", "irrelevant", "maybe"].includes(verdict)) throw new Error("Invalid verdict");
  const reasons = form.getAll("reasons").map(String).filter((value): value is (typeof FEEDBACK_REASONS)[number] => FEEDBACK_REASONS.includes(value as never));
  const note = form.get("note")?.toString().trim() || null;
  const now = new Date();
  await getDb().transaction(async (tx) => {
    const [current] = await tx.select({ status: jobs.status, triagedAt: jobs.triagedAt }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!current) throw new Error("Job not found");
    if (current.triagedAt) return;
    const nextStatus = verdict === "relevant" ? "to_apply" : verdict === "irrelevant" ? "irrelevant" : current.status;
    await tx.insert(feedback).values({ jobId, verdict, reasons, note });
    await tx.update(jobs).set({ triagedAt: now, status: nextStatus, ...(nextStatus !== current.status ? { statusChangedAt: now } : {}) }).where(eq(jobs.id, jobId));
    if (nextStatus !== current.status) await tx.insert(jobStatusHistory).values({ jobId, fromStatus: current.status, toStatus: nextStatus, note: `Triage decision: ${verdict}`, fromTriaged: Boolean(current.triagedAt), actor: "owner" });
    const message = verdict === "relevant" ? "Shortlisted this role." : verdict === "maybe" ? "Saved this role for later." : "Passed on this role.";
    await emitOwnerEvent(tx, "feedback_added", { job_id: jobId, verdict, reasons, note, resulting_status: nextStatus }, message, jobId);
  });
  revalidatePath("/");
  revalidatePath("/pipeline");
  revalidatePath(`/jobs/${jobId}`);
}

export async function moveJob(form: FormData) {
  await requireAgentControlSession();
  const jobId = required(form, "jobId");
  const destination = required(form, "status");
  const note = form.get("note")?.toString().trim() || null;
  if (!isJobDestination(destination)) throw new Error("Invalid status");
  const { status: toStatus, triaged } = resolveJobDestination(destination);
  await getDb().transaction(async (tx) => {
    const [current] = await tx.select({ status: jobs.status, triagedAt: jobs.triagedAt }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!current) throw new Error("Job not found");
    const now = new Date();
    if (current.status === toStatus) {
      if (toStatus !== "sourced" || Boolean(current.triagedAt) === triaged) return;
      await tx.update(jobs).set({ triagedAt: triaged ? now : null }).where(eq(jobs.id, jobId));
      await emitOwnerEvent(tx, "triage_changed", { job_id: jobId, saved_for_later: triaged, note }, triaged ? "Saved this role for later." : "Returned this role to review.", jobId);
      return;
    }
    if (!canTransitionJob(current.status, toStatus)) throw new Error(`Cannot move a job from ${current.status} to ${toStatus}. Available: ${availableJobTransitions(current.status).join(", ") || "none"}`);
    await tx.update(jobs).set({ status: toStatus, statusChangedAt: now, ...(toStatus === "sourced" ? { triagedAt: triaged ? now : null } : {}) }).where(eq(jobs.id, jobId));
    await tx.insert(jobStatusHistory).values({ jobId, fromStatus: current.status, toStatus, note, fromTriaged: Boolean(current.triagedAt), actor: "owner" });
    const payload: Record<string, unknown> = { job_id: jobId, from_status: current.status, to_status: toStatus, note };
    if (toStatus === "sourced") payload.saved_for_later = triaged;
    if (toStatus === "applied") {
      const settings = await currentSettings(tx);
      payload.suggested_follow_up_on = new Date(Date.now() + settings.followUpDays * 86_400_000).toISOString().slice(0, 10);
    }
    await emitOwnerEvent(tx, "status_changed", payload, `Moved role from ${current.status} to ${toStatus}.`, jobId);
  });
  revalidatePath("/");
  revalidatePath("/pipeline");
  revalidatePath(`/jobs/${jobId}`);
}

export async function undoLastJobMove(form: FormData) {
  await requireAgentControlSession();
  const jobId = required(form, "jobId");
  await getDb().transaction(async (tx) => {
    const [current] = await tx.select({ status: jobs.status, triagedAt: jobs.triagedAt }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
    const [latest] = await tx.select().from(jobStatusHistory).where(eq(jobStatusHistory.jobId, jobId)).orderBy(desc(jobStatusHistory.createdAt)).limit(1);
    if (!current || !latest?.fromStatus || latest.toStatus !== current.status) throw new Error("There is no current move to undo");
    const now = new Date();
    // Put the job back in the bucket it came from: rows written before the flag existed leave the triage state alone.
    const triage = latest.fromTriaged == null ? {} : { triagedAt: latest.fromTriaged ? current.triagedAt ?? now : null };
    await tx.update(jobs).set({ status: latest.fromStatus, statusChangedAt: now, ...triage }).where(eq(jobs.id, jobId));
    await tx.insert(jobStatusHistory).values({ jobId, fromStatus: current.status, toStatus: latest.fromStatus, note: "Undid the previous status move", fromTriaged: Boolean(current.triagedAt), actor: "owner" });
    await emitOwnerEvent(tx, "status_changed", { job_id: jobId, from_status: current.status, to_status: latest.fromStatus, undo: true }, `Undid the move to ${current.status}.`, jobId);
  });
  revalidatePath("/");
  revalidatePath("/pipeline");
  revalidatePath(`/jobs/${jobId}`);
}

export async function addInterview(form: FormData) {
  await requireAgentControlSession();
  const jobId = required(form, "jobId");
  const stage = required(form, "stage") as InterviewStage;
  if (!INTERVIEW_STAGES.includes(stage)) throw new Error("Invalid interview stage");
  const timeZone = required(form, "timeZone");
  const scheduledAt = parseZonedDateTime(required(form, "scheduledLocal"), timeZone);
  const locationOrLink = form.get("locationOrLink")?.toString().trim() || null;
  const notesMd = form.get("notesMd")?.toString().trim() || null;
  const { interview } = await createInterviewRecord({
    jobId,
    stage,
    scheduledAt,
    timeZone,
    locationOrLink,
    notesMd,
  }, "owner");
  revalidatePath("/");
  revalidatePath("/pipeline");
  revalidatePath("/interviews");
  revalidatePath(`/jobs/${jobId}`);
  redirect(`/interviews/${interview.id}`);
}

export async function updateInterview(form: FormData) {
  await requireAgentControlSession();
  const interviewId = required(form, "interviewId");
  const stage = required(form, "stage") as InterviewStage;
  if (!INTERVIEW_STAGES.includes(stage)) throw new Error("Invalid interview stage");
  const outcome = required(form, "outcome") as InterviewOutcome;
  if (!INTERVIEW_OUTCOMES.includes(outcome)) throw new Error("Invalid interview outcome");
  const timeZone = required(form, "timeZone");
  const scheduledAt = parseZonedDateTime(required(form, "scheduledLocal"), timeZone);
  const { interview } = await updateInterviewRecord({
    interviewId,
    stage,
    scheduledAt,
    timeZone,
    locationOrLink: form.get("locationOrLink")?.toString().trim() || null,
    notesMd: form.get("notesMd")?.toString().trim() || null,
    outcome,
  }, "owner");
  revalidatePath("/");
  revalidatePath("/pipeline");
  revalidatePath("/interviews");
  revalidatePath(`/interviews/${interviewId}`);
  revalidatePath(`/jobs/${interview.jobId}`);
}

export async function addInterviewer(form: FormData) {
  await requireAgentControlSession();
  const interviewId = required(form, "interviewId");
  const name = required(form, "name");
  const roleTitle = form.get("roleTitle")?.toString().trim() || null;
  const linkedinUrl = form.get("linkedinUrl")?.toString().trim() || null;
  await getDb().transaction(async (tx) => {
    const [person] = await tx.insert(interviewers).values({ interviewId, name, roleTitle, linkedinUrl }).onConflictDoNothing({ target: [interviewers.interviewId, interviewers.name] }).returning({ id: interviewers.id });
    if (!person) return;
    await emitOwnerEvent(tx, "interviewer_added", { interviewer_id: person.id, interview_id: interviewId, name, role_title: roleTitle, linkedin_url: linkedinUrl }, `Added interviewer ${name}.`);
  });
  revalidatePath(`/interviews/${interviewId}`);
}

export async function decideTailoringChange(form: FormData) {
  await requireAgentControlSession();
  const tailoringId = required(form, "tailoringId");
  const changeId = required(form, "changeId");
  const decision = required(form, "decision") as "accepted" | "rejected";
  if (!["accepted", "rejected"].includes(decision)) throw new Error("Invalid decision");
  await getDb().transaction(async (tx) => {
    const [row] = await tx.select().from(cvTailorings).where(eq(cvTailorings.id, tailoringId)).limit(1);
    if (!row) throw new Error("Tailoring not found");
    const currentChange = (row.changes as TailoringChange[]).find((change) => change.id === changeId);
    if (!currentChange) throw new Error("Tailoring change not found");
    if (currentChange.decision === decision) return;
    if (currentChange.decision !== "pending") throw new Error("This change was already decided; refresh before changing it");
    const changes = (row.changes as TailoringChange[]).map((change) => change.id === changeId ? { ...change, decision } : change);
    const complete = changes.every((change) => change.decision !== "pending");
    await tx.update(cvTailorings).set({ changes, ...(complete ? { status: "reviewed" as const, decidedAt: new Date() } : {}) }).where(eq(cvTailorings.id, tailoringId));
    await emitOwnerEvent(tx, "tailoring_decided", { tailoring_id: tailoringId, job_id: row.jobId, change_id: changeId, decision, complete, changes }, `${decision === "accepted" ? "Accepted" : "Rejected"} a CV tailoring change.`, row.jobId);
  });
  revalidatePath("/");
  revalidatePath("/cv");
}

export async function updateCvContent(form: FormData) {
  await requireAgentControlSession();
  const variantId = required(form, "variantId");
  const slug = required(form, "slug");
  const oldText = required(form, "oldText");
  const newText = required(form, "newText");
  const expectedVersion = Number(required(form, "version"));
  const occurrence = Number(required(form, "occurrence"));
  await getDb().transaction(async (tx) => {
    const [variant] = await tx.select().from(cvVariants).where(and(eq(cvVariants.id, variantId), eq(cvVariants.slug, slug))).limit(1);
    if (!variant) throw new Error("CV variant not found");
    if (variant.version !== expectedVersion) throw new Error("The CV changed; refresh before editing");
    let start = -1;
    let from = 0;
    for (let index = 0; index <= occurrence; index += 1) {
      start = variant.contentMd.indexOf(oldText, from);
      if (start < 0) throw new Error("The selected paragraph changed; refresh before editing");
      from = start + oldText.length;
    }
    const contentMd = variant.contentMd.slice(0, start) + newText + variant.contentMd.slice(start + oldText.length);
    await tx.update(cvVariants).set({ contentMd, version: variant.version + 1, updatedAt: new Date() }).where(eq(cvVariants.id, variantId));
    await emitOwnerEvent(tx, "cv_updated", { variant_slug: slug, section: "inline", old_text: oldText, new_text: newText, version: variant.version + 1 }, `Edited ${slug} directly.`);
  });
  revalidatePath("/cv");
}

export async function markCvReady(form: FormData) {
  await requireAgentControlSession();
  const variantId = required(form, "variantId");
  const slug = required(form, "slug");
  await getDb().transaction(async (tx) => {
    const [variant] = await tx.select().from(cvVariants).where(eq(cvVariants.id, variantId)).limit(1);
    if (!variant) throw new Error("CV variant not found");
    await emitOwnerEvent(tx, "cv_ready", { variant_id: variantId, variant_slug: slug, version: variant.version }, `Marked ${slug} v${variant.version} ready to send.`);
  });
  revalidatePath("/cv");
}

export async function createRequest(form: FormData) {
  await requireAgentControlSession();
  const text = required(form, "text").slice(0, 10_000);
  const jobId = form.get("jobId")?.toString() || null;
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`question:${jobId}:${text}`}))`);
    const [existing] = await tx.select({ id: requests.id }).from(requests).where(and(eq(requests.text, text), jobId ? eq(requests.jobId, jobId) : isNull(requests.jobId), inArray(requests.status, ["open", "in_progress"]))).limit(1);
    if (existing) return;
    const execution = await getAgentExecutionSettings(tx);
    const workspace = await getWorkspace(tx);
    await enqueueQuestionTask({ text, jobId, executor: execution.searchExecutor, payload: { candidateId: workspace.candidateId, budgets: { maxDurationSeconds: execution.maxDurationSeconds } } }, tx);
  });
  revalidatePath("/"); revalidatePath("/activity");
  if (jobId) revalidatePath(`/jobs/${jobId}`);
}

export async function completeFollowUp(form: FormData) {
  await requireAgentControlSession();
  const jobId = required(form, "jobId");
  await getDb().transaction(async (tx) => {
    const [job] = await tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job) throw new Error("Job not found");
    await emitOwnerEvent(tx, "followup_completed", { job_id: jobId, status: job.status }, "Marked the application follow-up complete.", jobId);
  });
  revalidatePath("/");
  revalidatePath(`/jobs/${jobId}`);
}

export async function retryRequest(form: FormData) {
  await requireAgentControlSession();
  const requestId = required(form, "requestId");
  await getDb().transaction(async (tx) => {
    const [request] = await tx.select().from(requests).where(eq(requests.id, requestId)).for("update").limit(1);
    if (!request || request.status !== "failed") return;
    const [task] = await tx.select().from(agentTasks).where(eq(agentTasks.requestId, requestId)).orderBy(desc(agentTasks.createdAt)).limit(1);
    if (task) await retryAgentTask(task.id, undefined, tx);
    else {
      const execution = await getAgentExecutionSettings(tx);
      const workspace = await getWorkspace(tx);
      await enqueueAgentTask({ requestId, kind: request.purpose === "question" ? "question" : "search", executor: execution.searchExecutor, dedupeKey: `legacy-request:${requestId}`, payload: { ...request.payload, candidateId: workspace.candidateId, sources: execution.searchSources, budgets: { maxPages: execution.maxPages, maxDetailFetches: execution.maxDetailFetches, maxDurationSeconds: execution.maxDurationSeconds } } }, tx);
      await tx.update(requests).set({ status: "open", errorMd: null, updatedAt: new Date() }).where(eq(requests.id, requestId));
    }
  });
  revalidatePath("/"); revalidatePath("/activity");
}

export async function addNote(form: FormData) {
  await requireAgentControlSession();
  const jobId = required(form, "jobId");
  const note = required(form, "note");
  await getDb().transaction(async (tx) => {
    await emitOwnerEvent(tx, "note_added", { job_id: jobId, note }, "Added a note.", jobId);
  });
  revalidatePath(`/jobs/${jobId}`);
}

export async function saveInterviewPrep(form: FormData) {
  await requireAgentControlSession();
  const interviewId = required(form, "interviewId");
  const checklist = form.getAll("checklist").map(String);
  const questionsMd = form.get("questionsMd")?.toString().trim() || null;
  const postInterviewNotesMd = form.get("postInterviewNotesMd")?.toString().trim() || null;
  await getDb().transaction(async (tx) => {
    const [current] = await tx.select({ jobId: interviews.jobId, checklist: interviews.checklist }).from(interviews).where(eq(interviews.id, interviewId)).limit(1);
    if (!current) throw new Error("Interview not found");
    const baseChecklist = current.checklist.length ? current.checklist : [
      { id: "research", label: "Review the company and interviewer brief", done: false },
      { id: "stories", label: "Choose two STAR examples", done: false },
      { id: "questions", label: "Prepare questions to ask", done: false },
      { id: "tech", label: "Test the meeting link, camera, and audio", done: false },
      { id: "followup", label: "Plan the post-interview thank-you note", done: false },
    ];
    const items = baseChecklist.map((item) => ({ ...item, done: checklist.includes(item.id) }));
    await tx.update(interviews).set({ checklist: items, questionsMd, postInterviewNotesMd }).where(eq(interviews.id, interviewId));
    await emitOwnerEvent(tx, "interview_prep_updated", { interview_id: interviewId, checklist: items, questions_md: questionsMd, post_interview_notes_md: postInterviewNotesMd }, "Updated interview preparation.", current.jobId);
  });
  revalidatePath(`/interviews/${interviewId}`);
}

export async function recordRejection(form: FormData) {
  await requireAgentControlSession();
  const jobId = required(form, "jobId");
  const occurredAt = new Date(required(form, "occurredAt"));
  if (Number.isNaN(occurredAt.getTime())) throw new Error("Invalid rejection date");
  const stage = form.get("stage")?.toString().trim() || null;
  const reasonCategory = form.get("reasonCategory")?.toString().trim() || null;
  const reasonDetail = form.get("reasonDetail")?.toString().trim() || null;
  const learningMd = form.get("learningMd")?.toString().trim() || null;
  const responseNeeded = form.get("responseNeeded") === "on";
  await getDb().transaction(async (tx) => {
    const [current] = await tx.select({ status: jobs.status, triagedAt: jobs.triagedAt }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!current) throw new Error("Job not found");
    await tx.insert(rejections).values({ jobId, occurredAt, stage, reasonCategory, reasonDetail, learningMd, responseNeeded }).onConflictDoUpdate({
      target: rejections.jobId,
      set: { occurredAt, stage, reasonCategory, reasonDetail, learningMd, responseNeeded, updatedAt: new Date() },
    });
    if (current.status !== "rejected") {
      await tx.update(jobs).set({ status: "rejected", statusChangedAt: occurredAt }).where(eq(jobs.id, jobId));
      await tx.insert(jobStatusHistory).values({ jobId, fromStatus: current.status, toStatus: "rejected", note: reasonDetail || "Rejection recorded", fromTriaged: Boolean(current.triagedAt), actor: "owner" });
    }
    await emitOwnerEvent(tx, "rejection_recorded", { job_id: jobId, occurred_at: occurredAt.toISOString(), stage, reason_category: reasonCategory, reason_detail: reasonDetail, learning_md: learningMd, response_needed: responseNeeded }, "Recorded a rejection and its learning.", jobId);
  });
  revalidatePath("/");
  revalidatePath("/pipeline");
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/insights");
}

export async function updateNotificationPreferences(form: FormData) {
  await requireAgentControlSession();
  const minimumFitScore = boundedInt(form, "minimumFitScore", 0, 100);
  const interviewReminderHours = boundedInt(form, "interviewReminderHours", 1, 168);
  const on = (key: string) => form.get(key) === "on";
  const values = {
    highFitJobs: on("highFitJobs"),
    dailySummary: on("dailySummary"),
    weeklyDigest: on("weeklyDigest"),
    interviewReminders: on("interviewReminders"),
    followUpsDue: on("followUpsDue"),
    tailoringReady: on("tailoringReady"),
    requestAnswered: on("requestAnswered"),
    watchlistFindings: on("watchlistFindings"),
    automationFailures: on("automationFailures"),
    minimumFitScore,
    interviewReminderHours,
    updatedAt: new Date(),
  };
  await getDb().transaction(async (tx) => {
    await tx.insert(notificationPreferences).values({ id: WORKSPACE_ID, ...values }).onConflictDoUpdate({ target: notificationPreferences.id, set: values });
    await emitOwnerEvent(tx, "notification_preferences_updated", { ...values, updatedAt: undefined }, "Updated notification preferences.");
  });
  revalidatePath("/settings");
}

export async function saveGeneralSettings(form: FormData) {
  await requireAgentControlSession();
  const timeZone = required(form, "timeZone");
  if (!isValidTimeZone(timeZone)) throw new Error("Choose a valid time zone");
  const followUpDays = boundedInt(form, "followUpDays", 1, 90);
  const applicationsTarget = boundedInt(form, "applicationsTarget", 0, 50);
  const conversationsTarget = boundedInt(form, "conversationsTarget", 0, 50);
  await getDb().transaction(async (tx) => {
    const now = new Date();
    await tx.insert(notificationPreferences).values({ id: WORKSPACE_ID, timeZone, updatedAt: now }).onConflictDoUpdate({ target: notificationPreferences.id, set: { timeZone, updatedAt: now } });
    await tx.update(workspaces).set({ timeZone, updatedAt: now }).where(eq(workspaces.id, WORKSPACE_ID));
    await persistSettings(tx, { followUpDays }, { applicationsTarget, conversationsTarget }, "Updated pace and time zone.");
  });
  revalidateSettings();
}

export async function saveWorkspaceProfile(form: FormData) {
  await requireAgentControlSession();
  const values = normalizeWorkspaceInput({
    candidateId: form.get("candidateId"),
    displayName: form.get("displayName"),
    ownerName: form.get("ownerName"),
    assistantLabel: form.get("assistantLabel"),
    locale: form.get("locale"),
    timeZone: form.get("timeZone"),
  });
  await getDb().transaction(async (tx) => {
    const now = new Date();
    const [current] = await tx.select().from(workspaces).where(eq(workspaces.id, WORKSPACE_ID)).for("update").limit(1);
    const candidateInUse = current ? await workspaceCandidateLocked(current.candidateId, tx) : false;
    if (candidateInUse && current?.candidateId !== values.candidateId) {
      throw new Error("Candidate ID cannot be changed after agent work has started");
    }
    await tx.insert(workspaces).values({ id: WORKSPACE_ID, ...values, onboardingCompletedAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: workspaces.id, set: { ...values, onboardingCompletedAt: now, updatedAt: now } });
    await tx.insert(notificationPreferences).values({ id: WORKSPACE_ID, timeZone: values.timeZone, updatedAt: now })
      .onConflictDoUpdate({ target: notificationPreferences.id, set: { timeZone: values.timeZone, updatedAt: now } });
    await emitOwnerEvent(tx, "workspace_updated", { candidate_id: values.candidateId, locale: values.locale, time_zone: values.timeZone }, "Updated workspace identity.");
  });
  revalidatePath("/", "layout");
  redirect("/");
}

export async function createManualJob(form: FormData) {
  await requireAgentControlSession();
  const rawCompanyName = required(form, "company");
  if (!companyDisplayNameFitsStorage(rawCompanyName)) throw new Error("Company name must be 1 to 300 characters after normalization");
  const companyName = companyDisplayName(rawCompanyName);
  const title = required(form, "title").slice(0, 500);
  const location = form.get("location")?.toString().trim().slice(0, 500) || null;
  const descriptionMd = form.get("descriptionMd")?.toString().trim().slice(0, 100_000) || null;
  let url: string;
  try {
    const parsed = new URL(required(form, "url"));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    url = parsed.toString();
  } catch {
    throw new Error("Job URL must be a full http(s) link");
  }
  const dedupeKey = makeDedupeKey(companyName, title, location);
  const jobId = await getDb().transaction(async (tx) => {
    const [duplicate] = await tx.select({ id: jobs.id }).from(jobs).where(or(eq(jobs.url, url), eq(jobs.dedupeKey, dedupeKey))).limit(1);
    if (duplicate) throw new Error("This job is already in the pipeline");
    const identity = normalizeCompanyIdentity(companyName);
    let company: { id: string; name: string } | undefined;
    for (const slug of companySlugCandidates(companyName)) {
      const [existing] = await tx.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.slug, slug)).limit(1);
      if (existing) {
        if (normalizeCompanyIdentity(existing.name) === identity) { company = existing; break; }
        continue;
      }
      const [created] = await tx.insert(companies).values({ name: companyName, slug }).onConflictDoNothing({ target: companies.slug }).returning({ id: companies.id, name: companies.name });
      if (created) { company = created; break; }
      const [raced] = await tx.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.slug, slug)).limit(1);
      if (raced && normalizeCompanyIdentity(raced.name) === identity) { company = raced; break; }
    }
    if (!company) throw new Error("Could not create a unique company identity");
    const [job] = await tx.insert(jobs).values({ companyId: company.id, title, url, source: "manual", location, descriptionMd, dedupeKey }).returning({ id: jobs.id });
    await emitOwnerEvent(tx, "job_added", { job_id: job.id, source: "manual" }, `Added ${title} at ${companyName}.`, job.id);
    return job.id;
  });
  revalidatePath("/");
  revalidatePath("/pipeline");
  redirect(`/jobs/${jobId}`);
}

export async function createCvVariant(form: FormData) {
  await requireAgentControlSession();
  const name = required(form, "name").slice(0, 240);
  const summary = form.get("summary")?.toString().trim().slice(0, 1_000) || "";
  const contentMd = required(form, "contentMd").slice(0, 200_000);
  const slug = slugify(name).slice(0, 120);
  if (!slug) throw new Error("CV name must contain letters or numbers");
  await getDb().transaction(async (tx) => {
    const [existing] = await tx.select({ id: cvVariants.id }).from(cvVariants).where(eq(cvVariants.slug, slug)).limit(1);
    if (existing) throw new Error("A CV variant with this name already exists");
    const [variant] = await tx.insert(cvVariants).values({ slug, name, summary, contentMd }).returning({ id: cvVariants.id });
    await emitOwnerEvent(tx, "cv_created", { variant_id: variant.id, variant_slug: slug }, `Created CV variant ${name}.`);
  });
  revalidatePath("/cv");
  redirect(`/cv?variant=${slug}`);
}

export async function saveSearchPreferences(form: FormData) {
  await requireAgentControlSession();
  const patch: Partial<SearchSettingsValues> = {
    minimumFitScore: boundedInt(form, "minimumFitScore", 0, 100),
    targetRoles: tokens(form, "targetRoles", LIMITS.roles),
    languages: tokens(form, "languages", LIMITS.languages),
    excludedCompanies: tokens(form, "excludedCompanies", LIMITS.companies),
    excludedKeywords: tokens(form, "excludedKeywords", LIMITS.keywords),
    notesMd: form.get("notesMd")?.toString().trim().slice(0, 4000) || null,
  };
  await getDb().transaction((tx) => persistSettings(tx, patch, undefined, "Updated what to look for."));
  revalidateSettings();
}

export async function saveLocationSettings(form: FormData) {
  await requireAgentControlSession();
  let rawLocations: unknown = [];
  try { rawLocations = JSON.parse(form.get("locationsJson")?.toString() || "[]"); } catch { throw new Error("Locations could not be read"); }
  let rawRemoteSearchLocations: unknown = [];
  try { rawRemoteSearchLocations = JSON.parse(form.get("remoteSearchLocationsJson")?.toString() || "[]"); } catch { throw new Error("Remote search locations could not be read"); }
  const locations = normalizeLocations(rawLocations);
  const workModes = form.getAll("workModes").map(String).filter((value) => WORK_MODES.some((mode) => mode.id === value));
  const remote = normalizeRemote({
    enabled: form.get("remoteEnabled") === "on",
    countries: form.getAll("remoteCountries").map(String),
    searchLocations: rawRemoteSearchLocations,
    includeWorldwide: form.get("includeWorldwide") === "on",
    includeUnspecified: form.get("includeUnspecified") === "on",
  });
  if (!locations.length && !remote.enabled) throw new Error("Add an office location or allow remote roles");
  if (remote.enabled && !remote.searchLocations.length && !locations.length) throw new Error("Add a remote search location");
  if (locations.length && !workModes.length) throw new Error("Pick at least one office work mode");
  await getDb().transaction((tx) => persistSettings(tx, { locations, workModes, remote }, undefined, "Updated locations."));
  revalidateSettings();
}

export async function saveScheduleSettings(form: FormData) {
  await requireAgentControlSession();
  const frequency = required(form, "frequency");
  if (!SCHEDULE_FREQUENCIES.some((option) => option.id === frequency)) throw new Error("Invalid frequency");
  const days = form.getAll("days").map(String).filter((day) => WEEKDAYS.some((option) => option.id === day));
  const schedule = normalizeSchedule({ enabled: form.get("enabled") === "on", frequency, time: required(form, "time"), days, maxJobs: boundedInt(form, "maxJobs", 1, 100) });
  if (schedule.enabled && ["weekly", "custom"].includes(schedule.frequency) && !schedule.days.length) throw new Error("Choose at least one day");
  await getDb().transaction((tx) => persistSettings(tx, { schedule, tailorCvSuggestions: form.get("tailorCvSuggestions") === "on" }, undefined, "Updated the search schedule."));
  revalidateSettings();
}

export async function queueSearchNow() {
  await requireAgentControlSession();
  const result = await enqueueSearchTask({ purpose: "search_now" });
  revalidatePath("/"); revalidatePath("/activity"); revalidatePath("/settings");
  return result.created ? "queued" as const : "already_queued" as const;
}

export async function saveAgentExecution(form: FormData) {
  await requireAgentControlSession();
  const executor = (key: string) => {
    const value = required(form, key);
    if (value !== "hermes" && value !== "codex" && value !== "api" && value !== "unassigned") throw new Error("Invalid executor");
    return value;
  };
  const sources = form.getAll("searchSources").map(String);
  if (sources.some((source) => !["public", "linkedin"].includes(source))) throw new Error("Choose only supported sources");
  await updateAgentExecutionSettings({ searchExecutor: executor("searchExecutor"), evaluationExecutor: executor("evaluationExecutor"), searchSources: sources, maxPages: boundedInt(form, "maxPages", 1, 1_000), maxDetailFetches: boundedInt(form, "maxDetailFetches", 0, 10_000), maxDurationSeconds: boundedInt(form, "maxDurationSeconds", 60, 7200) });
  revalidateSettings();
}

export async function controlAgentTask(form: FormData) {
  await requireAgentControlSession();
  const id = required(form, "taskId");
  const operation = required(form, "operation");
  if (operation === "cancel") await cancelAgentTask(id, "Cancelled from Job Seeker");
  else if (operation === "retry") await retryAgentTask(id);
  else if (operation === "assign") {
    const executor = required(form, "executor");
    if (executor !== "hermes" && executor !== "codex" && executor !== "api") throw new Error("Choose an executor");
    await getDb().transaction(async (tx) => {
      const [updated] = await tx.update(agentTasks).set({ executor, updatedAt: new Date() }).where(and(eq(agentTasks.id, id), eq(agentTasks.status, "queued"))).returning({ id: agentTasks.id });
      if (!updated) throw new Error("Only a queued task can be assigned");
      await emitOwnerEvent(tx, "agent_task_assigned", { task_id: id, executor }, `Assigned a task to ${executor === "api" ? "API" : executor === "codex" ? "Codex" : "Hermes"}.`);
    });
  } else throw new Error("Unknown task action");
  revalidatePath("/activity"); revalidatePath("/"); revalidatePath("/settings");
}

const AGENCY_STATUSES = ["not_contacted", "contacted", "active", "dead"] as const;
const WATCHLIST_KINDS = ["company", "board", "alert"] as const;
const WATCHLIST_CADENCES = ["daily", "weekly"] as const;

function httpUrl(value: string | null | undefined, label: string) {
  const text = value?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${label} must be a full http(s) link`);
  }
}

export async function addAgency(form: FormData) {
  await requireAgentControlSession();
  const name = required(form, "name").slice(0, 240);
  const status = (form.get("status")?.toString() || "not_contacted") as (typeof AGENCY_STATUSES)[number];
  if (!AGENCY_STATUSES.includes(status)) throw new Error("Invalid status");
  const website = httpUrl(form.get("website")?.toString(), "Website");
  const notesMd = form.get("notesMd")?.toString().trim() || null;
  const contactName = form.get("contactName")?.toString().trim();
  const contacts = contactName ? [{ name: contactName, role: form.get("contactRole")?.toString().trim() || undefined, email: form.get("contactEmail")?.toString().trim() || undefined }] : [];
  await getDb().transaction(async (tx) => {
    const [created] = await tx.insert(agencies).values({ name, status, website, notesMd, contacts, lastContactAt: status === "not_contacted" ? null : new Date() }).onConflictDoNothing({ target: agencies.name }).returning({ id: agencies.id });
    if (!created) throw new Error("That agency is already listed");
    await emitOwnerEvent(tx, "agency_added", { agency_id: created.id, name, status, website }, `Added agency ${name}.`);
  });
  revalidatePath("/agencies");
}

export async function updateAgency(form: FormData) {
  await requireAgentControlSession();
  const agencyId = required(form, "agencyId");
  const status = required(form, "status") as (typeof AGENCY_STATUSES)[number];
  if (!AGENCY_STATUSES.includes(status)) throw new Error("Invalid status");
  const notesMd = form.get("notesMd")?.toString().trim() || null;
  await getDb().transaction(async (tx) => {
    const [current] = await tx.select({ status: agencies.status, name: agencies.name }).from(agencies).where(eq(agencies.id, agencyId)).limit(1);
    if (!current) throw new Error("Agency not found");
    const touched = status !== current.status && status !== "not_contacted";
    await tx.update(agencies).set({ status, notesMd, ...(touched ? { lastContactAt: new Date() } : {}) }).where(eq(agencies.id, agencyId));
    await emitOwnerEvent(tx, "agency_updated", { agency_id: agencyId, status, notes_md: notesMd }, `Updated agency ${current.name}.`);
  });
  revalidatePath("/agencies");
}

export async function addWatchlistSource(form: FormData) {
  await requireAgentControlSession();
  const label = required(form, "label").slice(0, 240);
  const url = httpUrl(required(form, "url"), "Link");
  const kind = required(form, "kind") as (typeof WATCHLIST_KINDS)[number];
  const cadence = required(form, "cadence") as (typeof WATCHLIST_CADENCES)[number];
  if (!WATCHLIST_KINDS.includes(kind) || !WATCHLIST_CADENCES.includes(cadence) || !url) throw new Error("Invalid source");
  await getDb().transaction(async (tx) => {
    const [created] = await tx.insert(watchlistItems).values({ label, url, kind, cadence }).onConflictDoNothing({ target: watchlistItems.url }).returning({ id: watchlistItems.id });
    if (!created) throw new Error("That link is already watched");
    await emitOwnerEvent(tx, "watchlist_added", { watchlist_id: created.id, label, url, kind, cadence }, `Started watching ${label}.`);
  });
  revalidatePath("/watchlist");
}

export async function updateWatchlistSource(form: FormData) {
  await requireAgentControlSession();
  const sourceId = required(form, "sourceId");
  const cadence = required(form, "cadence") as (typeof WATCHLIST_CADENCES)[number];
  if (!WATCHLIST_CADENCES.includes(cadence)) throw new Error("Invalid cadence");
  await getDb().transaction(async (tx) => {
    const [row] = await tx.update(watchlistItems).set({ cadence }).where(eq(watchlistItems.id, sourceId)).returning({ label: watchlistItems.label });
    if (!row) throw new Error("Source not found");
    await emitOwnerEvent(tx, "watchlist_updated", { watchlist_id: sourceId, cadence }, `Checks ${row.label} ${cadence}.`);
  });
  revalidatePath("/watchlist");
}

export async function removeWatchlistSource(form: FormData) {
  await requireAgentControlSession();
  const sourceId = required(form, "sourceId");
  await getDb().transaction(async (tx) => {
    const [row] = await tx.delete(watchlistItems).where(eq(watchlistItems.id, sourceId)).returning({ label: watchlistItems.label });
    if (!row) throw new Error("Source not found");
    await emitOwnerEvent(tx, "watchlist_removed", { watchlist_id: sourceId }, `Stopped watching ${row.label}.`);
  });
  revalidatePath("/watchlist");
}

export async function uploadCvDocument(form: FormData) {
  await requireAgentControlSession();
  const variantId = required(form, "variantId");
  const file = form.get("document");
  if (!(file instanceof File) || file.size === 0) throw new Error("Choose a PDF file");
  if (file.size > 3 * 1024 * 1024) throw new Error("Keep the PDF under 3 MB");
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("That file is not a PDF");
  const fileName = file.name.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 240) || "CV.pdf";
  const values = { fileName, contentBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), updatedAt: new Date() };
  await getDb().transaction(async (tx) => {
    const [variant] = await tx.select({ slug: cvVariants.slug }).from(cvVariants).where(eq(cvVariants.id, variantId)).limit(1);
    if (!variant) throw new Error("CV variant not found");
    await tx.insert(cvDocuments).values({ variantId, ...values }).onConflictDoUpdate({ target: cvDocuments.variantId, set: values });
    await emitOwnerEvent(tx, "cv_document_uploaded", { variant_id: variantId, variant_slug: variant.slug, file_name: fileName, sha256: values.sha256 }, `Uploaded the ${variant.slug} PDF.`);
  });
  revalidatePath("/cv");
}

export async function linkCvOriginal(form: FormData) {
  await requireAgentControlSession();
  const variantId = required(form, "variantId");
  const raw = form.get("documentUrl")?.toString().trim() ?? "";
  const id = raw ? driveFileId(raw) : null;
  if (raw && !id) throw new Error("Paste a Google Drive or Docs link");
  await getDb().transaction(async (tx) => {
    const [variant] = await tx.update(cvVariants).set({ driveFileId: id }).where(eq(cvVariants.id, variantId)).returning({ slug: cvVariants.slug });
    if (!variant) throw new Error("CV variant not found");
    await emitOwnerEvent(tx, "cv_source_linked", { variant_id: variantId, variant_slug: variant.slug, drive_file_id: id }, id ? `Linked the ${variant.slug} source file.` : `Removed the ${variant.slug} source link.`);
  });
  revalidatePath("/cv");
}
