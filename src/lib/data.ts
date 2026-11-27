import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { getDb, hasDatabase } from "@/db";
import {
  activityLog,
  agentExecutionSettings,
  agentScheduleOccurrences,
  agentTasks,
  agentWorkerContacts,
  agentWorkerPauses,
  automationRuns,
  companies,
  cvDocuments,
  cvTailorings,
  cvVariants,
  feedback,
  interviews,
  interviewers,
  jobs,
  jobStatusHistory,
  notificationPreferences,
  rejections,
  prepBriefs,
  requests,
  searchSettings,
  weeklyTargets,
  type JobStatus,
} from "@/db/schema";
import {
  computeAssistantStatus,
  getMostRecentElapsedDueOccurrence,
  interruptedRequestIdsFor,
  isInterruptedTask,
  type AssistantStatus,
} from "@/lib/assistant-status";
import { DEFAULT_SEARCH_SETTINGS, normalizeLocations, normalizeRemote, normalizeSchedule, type SearchSettingsValues } from "@/lib/settings";
import { DEFAULT_TIME_ZONE, isValidTimeZone, startOfWeek } from "@/lib/time";
import { getWorkspace } from "@/lib/workspace";
import { DEFAULT_WORKSPACE, WORKSPACE_ID } from "@/lib/workspace-values";
import { workerRegistry } from "@/lib/worker-auth";
import { heldExecutors } from "@/lib/worker-pauses";

export const DEFAULT_NOTIFICATION_PREFERENCES = {
  highFitJobs: false, interviewReminders: false, followUpsDue: false, automationFailures: false,
  dailySummary: false, weeklyDigest: false, tailoringReady: false, requestAnswered: false, watchlistFindings: false,
  interviewReminderHours: 24, minimumFitScore: 80, timeZone: DEFAULT_TIME_ZONE,
};

export function settingsFromRow(row: typeof searchSettings.$inferSelect | undefined): SearchSettingsValues {
  if (!row) return DEFAULT_SEARCH_SETTINGS;
  return {
    minimumFitScore: row.minimumFitScore,
    followUpDays: row.followUpDays,
    targetRoles: row.targetRoles,
    languages: row.languages,
    excludedCompanies: row.excludedCompanies,
    excludedKeywords: row.excludedKeywords,
    locations: normalizeLocations(row.locations),
    workModes: row.workModes,
    remote: normalizeRemote(row.remote),
    schedule: normalizeSchedule(row.schedule),
    tailorCvSuggestions: row.tailorCvSuggestions,
    notesMd: row.notesMd,
  };
}

export async function getSearchSettings(): Promise<SearchSettingsValues> {
  if (!hasDatabase()) return DEFAULT_SEARCH_SETTINGS;
  const [row] = await getDb().select().from(searchSettings).where(eq(searchSettings.id, WORKSPACE_ID)).limit(1);
  return settingsFromRow(row);
}

/** The workspace time zone used for display and scheduling. */
export async function getAppTimeZone() {
  if (!hasDatabase()) return DEFAULT_TIME_ZONE;
  const [rows, workspace] = await Promise.all([
    getDb().select({ timeZone: notificationPreferences.timeZone }).from(notificationPreferences).where(eq(notificationPreferences.id, WORKSPACE_ID)).limit(1),
    getWorkspace(),
  ]);
  return rows[0]?.timeZone && isValidTimeZone(rows[0].timeZone) ? rows[0].timeZone : workspace.timeZone;
}

type DbLike = ReturnType<typeof getDb> | Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

function defaultAssistantStatus(assistantLabel = DEFAULT_WORKSPACE.assistantLabel, timeZone = DEFAULT_TIME_ZONE): AssistantStatus {
  return computeAssistantStatus({
    assistantLabel,
    timeZone,
    chosenExecutors: [],
    registeredWorkers: [],
    workerContacts: [],
    workerPauses: [],
    runningTasks: [],
    waitingRequests: 0,
    lastSuccessfulSearchAt: null,
    schedule: DEFAULT_SEARCH_SETTINGS.schedule,
    hasElapsedScheduleOccurrence: false,
  });
}

async function loadAssistantStatus(
  store: DbLike,
  options: {
    settings: SearchSettingsValues;
    timeZone: string;
    assistantLabel: string;
    now: Date;
    sequential?: boolean;
    runningTasks?: Array<Pick<typeof agentTasks.$inferSelect, "id" | "kind" | "executor" | "status" | "requestId" | "claimedBy" | "leaseExpiresAt" | "startedAt" | "updatedAt" | "createdAt">>;
    workerPauses?: Array<typeof agentWorkerPauses.$inferSelect>;
    workerContacts?: Array<typeof agentWorkerContacts.$inferSelect>;
    waitingRequests?: number;
  },
) {
  const { settings, timeZone, assistantLabel, now, sequential = false } = options;
  const elapsedDue = getMostRecentElapsedDueOccurrence(settings.schedule, timeZone, now);

  const readExecution = () => store.select({
    searchExecutor: agentExecutionSettings.searchExecutor,
    evaluationExecutor: agentExecutionSettings.evaluationExecutor,
  }).from(agentExecutionSettings).where(eq(agentExecutionSettings.id, WORKSPACE_ID)).limit(1).then((rows) => rows[0]);
  const readContacts = () => options.workerContacts
    ? Promise.resolve(options.workerContacts)
    : store.select().from(agentWorkerContacts);
  const readPauses = () => options.workerPauses
    ? Promise.resolve(options.workerPauses)
    : store.select().from(agentWorkerPauses).orderBy(asc(agentWorkerPauses.pausedAt));
  const readRunning = () => options.runningTasks
    ? Promise.resolve(options.runningTasks)
    : store.select({
      id: agentTasks.id,
      kind: agentTasks.kind,
      executor: agentTasks.executor,
      status: agentTasks.status,
      requestId: agentTasks.requestId,
      claimedBy: agentTasks.claimedBy,
      leaseExpiresAt: agentTasks.leaseExpiresAt,
      startedAt: agentTasks.startedAt,
      updatedAt: agentTasks.updatedAt,
      createdAt: agentTasks.createdAt,
    }).from(agentTasks).where(eq(agentTasks.status, "running")).orderBy(asc(agentTasks.startedAt));
  const readWaiting = () => options.waitingRequests !== undefined
    ? Promise.resolve(options.waitingRequests)
    : store.select({ count: sql<number>`count(*)::int` }).from(requests).where(inArray(requests.status, ["open", "in_progress"])).then((rows) => rows[0]?.count ?? 0);
  const readLatestTaskSearch = () => store.select({ completedAt: agentTasks.completedAt, startedAt: agentTasks.startedAt })
    .from(agentTasks)
    .where(and(eq(agentTasks.kind, "search"), eq(agentTasks.status, "succeeded")))
    .orderBy(sql`coalesce(${agentTasks.completedAt}, ${agentTasks.startedAt}) desc nulls last`)
    .limit(1);
  const readLatestLegacySearch = () => store.select({ completedAt: automationRuns.completedAt, startedAt: automationRuns.startedAt })
    .from(automationRuns)
    .where(and(inArray(automationRuns.workflow, ["daily_search", "search"]), eq(automationRuns.status, "succeeded")))
    .orderBy(sql`coalesce(${automationRuns.completedAt}, ${automationRuns.startedAt}) desc nulls last`)
    .limit(1);
  const readElapsedOccurrence = () => elapsedDue
    ? store.select({ key: agentScheduleOccurrences.occurrenceKey })
      .from(agentScheduleOccurrences)
      .where(eq(agentScheduleOccurrences.occurrenceKey, elapsedDue.occurrenceKey))
      .limit(1)
    : Promise.resolve([]);

  let executionRow: Awaited<ReturnType<typeof readExecution>>;
  let workerContacts: Awaited<ReturnType<typeof readContacts>>;
  let workerPauses: Awaited<ReturnType<typeof readPauses>>;
  let runningTasks: Awaited<ReturnType<typeof readRunning>>;
  let waitingRequests: number;
  let latestTaskSearch: Awaited<ReturnType<typeof readLatestTaskSearch>>;
  let latestLegacySearch: Awaited<ReturnType<typeof readLatestLegacySearch>>;
  let elapsedOccurrence: Awaited<ReturnType<typeof readElapsedOccurrence>>;

  if (sequential) {
    executionRow = await readExecution();
    workerContacts = await readContacts();
    workerPauses = await readPauses();
    runningTasks = await readRunning();
    waitingRequests = await readWaiting();
    latestTaskSearch = await readLatestTaskSearch();
    latestLegacySearch = await readLatestLegacySearch();
    elapsedOccurrence = await readElapsedOccurrence();
  } else {
    [
      executionRow,
      workerContacts,
      workerPauses,
      runningTasks,
      waitingRequests,
      latestTaskSearch,
      latestLegacySearch,
      elapsedOccurrence,
    ] = await Promise.all([
      readExecution(),
      readContacts(),
      readPauses(),
      readRunning(),
      readWaiting(),
      readLatestTaskSearch(),
      readLatestLegacySearch(),
      readElapsedOccurrence(),
    ]);
  }

  const searchDates = [
    latestTaskSearch[0]?.completedAt ?? latestTaskSearch[0]?.startedAt ?? null,
    latestLegacySearch[0]?.completedAt ?? latestLegacySearch[0]?.startedAt ?? null,
  ].filter((date): date is Date => Boolean(date));
  const lastSuccessfulSearchAt = searchDates.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const searchExecutor = executionRow?.searchExecutor ?? "unassigned";
  const evaluationExecutor = executionRow?.evaluationExecutor ?? "unassigned";

  const status = computeAssistantStatus({
    assistantLabel,
    timeZone,
    now,
    chosenExecutors: [searchExecutor, evaluationExecutor],
    executorAssignments: { search: searchExecutor, evaluation: evaluationExecutor },
    registeredWorkers: registeredWorkers(),
    workerContacts,
    workerPauses,
    runningTasks,
    waitingRequests,
    lastSuccessfulSearchAt,
    schedule: settings.schedule,
    hasElapsedScheduleOccurrence: elapsedOccurrence.length > 0,
  });

  return { status, lastSuccessfulSearchAt };
}

export async function getTodayData() {
  if (!hasDatabase()) return {
    jobs: [], tailorings: [], interviews: [], followUps: [], failedRequests: [], pendingRequests: 0, recentFailure: null,
    stats: { applications: 0, target: 0, interviewing: 0, review: 0, hidden: 0 }, timeZone: DEFAULT_TIME_ZONE, workspace: DEFAULT_WORKSPACE,
    assistantStatus: defaultAssistantStatus(),
  };
  const db = getDb();
  const now = new Date();
  const [settings, timeZone, workspace] = await Promise.all([getSearchSettings(), getAppTimeZone(), getWorkspace()]);
  const weekStart = startOfWeek(now, timeZone);
  const followUpCutoff = new Date(now.getTime() - settings.followUpDays * 86_400_000);
  const inboxFilter = and(isNull(jobs.triagedAt), eq(jobs.status, "sourced"));
  const visibleFilter = and(inboxFilter, or(isNull(jobs.fitScore), gte(jobs.fitScore, settings.minimumFitScore)));
  const [untriaged, reviewCount, totalCount, pendingTailorings, upcoming, failedRequests, pendingRequests, applicationCount, interviewCount, target, followUps, recentFailure] = await Promise.all([
    db.select({ job: jobs, company: companies }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(visibleFilter).orderBy(sql`${jobs.fitScore} desc nulls last`, asc(jobs.discoveredAt)).limit(40),
    db.select({ count: sql<number>`count(*)::int` }).from(jobs).where(visibleFilter),
    db.select({ count: sql<number>`count(*)::int` }).from(jobs).where(inboxFilter),
    db.select({ tailoring: cvTailorings, job: jobs, company: companies }).from(cvTailorings).innerJoin(jobs, eq(cvTailorings.jobId, jobs.id)).innerJoin(companies, eq(jobs.companyId, companies.id)).where(eq(cvTailorings.status, "proposed")).orderBy(desc(cvTailorings.createdAt)).limit(10),
    db.select({ interview: interviews, job: jobs, company: companies }).from(interviews).innerJoin(jobs, eq(interviews.jobId, jobs.id)).innerJoin(companies, eq(jobs.companyId, companies.id)).where(and(gte(interviews.scheduledAt, now), eq(interviews.outcome, "pending"))).orderBy(asc(interviews.scheduledAt)).limit(3),
    db.select().from(requests).where(eq(requests.status, "failed")).orderBy(asc(requests.createdAt)).limit(5),
    db.select({ count: sql<number>`count(*)::int` }).from(requests).where(inArray(requests.status, ["open", "in_progress"])),
    db.select({ count: sql<number>`count(distinct ${jobStatusHistory.jobId})::int` }).from(jobStatusHistory).where(and(eq(jobStatusHistory.toStatus, "applied"), gte(jobStatusHistory.createdAt, sql`(${weekStart}::date::timestamp at time zone ${timeZone})`))),
    db.select({ count: sql<number>`count(*)::int` }).from(jobs).where(inArray(jobs.status, ["screening", "interviewing", "offer"])),
    db.select().from(weeklyTargets).where(sql`${weeklyTargets.weekStart} <= ${weekStart}::date`).orderBy(desc(weeklyTargets.weekStart)).limit(1),
    db.select({ job: jobs, company: companies }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(and(eq(jobs.status, "applied"), lte(jobs.statusChangedAt, followUpCutoff), sql`not exists (select 1 from activity_log followup where followup.job_id = ${jobs.id} and followup.type = 'followup_completed' and followup.created_at > ${jobs.statusChangedAt})`)).orderBy(asc(jobs.statusChangedAt)).limit(10),
    db.select().from(automationRuns).where(and(eq(automationRuns.status, "failed"), gte(automationRuns.startedAt, new Date(now.getTime() - 48 * 3_600_000)))).orderBy(desc(automationRuns.startedAt)).limit(1),
  ]);
  const waitingRequests = pendingRequests[0]?.count ?? 0;
  const { status: assistantStatus } = await loadAssistantStatus(db, {
    settings,
    timeZone,
    assistantLabel: workspace.assistantLabel,
    now,
    waitingRequests,
  });
  return {
    jobs: untriaged,
    tailorings: pendingTailorings,
    interviews: upcoming,
    followUps,
    failedRequests,
    pendingRequests: waitingRequests,
    recentFailure: recentFailure[0] ?? null,
    timeZone,
    workspace,
    assistantStatus,
    stats: {
      applications: applicationCount[0]?.count ?? 0,
      target: target[0]?.applicationsTarget ?? 0,
      interviewing: interviewCount[0]?.count ?? 0,
      review: reviewCount[0]?.count ?? 0,
      hidden: Math.max(0, (totalCount[0]?.count ?? 0) - (reviewCount[0]?.count ?? 0)),
    },
  };
}

export async function getPipelineData() {
  if (!hasDatabase()) return [];
  return getDb().select({ job: jobs, company: companies }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(sql`${jobs.status} not in ('archived')`).orderBy(sql`${jobs.fitScore} desc nulls last`, desc(jobs.statusChangedAt));
}

export async function getJobDetail(id: string) {
  if (!hasDatabase()) return null;
  const db = getDb();
  const now = new Date();
  const rows = await db.select({ job: jobs, company: companies, cv: cvVariants }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).leftJoin(cvVariants, eq(jobs.recommendedCvVariantId, cvVariants.id)).where(eq(jobs.id, id)).limit(1);
  if (!rows[0]) return null;
  const [history, notes, tailorings, jobFeedback, jobInterviews, rejection, jobRequests, settings, timeZone, workspace] = await Promise.all([
    db.select().from(jobStatusHistory).where(eq(jobStatusHistory.jobId, id)).orderBy(desc(jobStatusHistory.createdAt)),
    db.select().from(activityLog).where(eq(activityLog.jobId, id)).orderBy(desc(activityLog.createdAt)).limit(50),
    db.select({ tailoring: cvTailorings, cv: cvVariants }).from(cvTailorings).innerJoin(cvVariants, eq(cvTailorings.cvVariantId, cvVariants.id)).where(eq(cvTailorings.jobId, id)).orderBy(desc(cvTailorings.createdAt)),
    db.select().from(feedback).where(eq(feedback.jobId, id)).orderBy(desc(feedback.createdAt)),
    db.select().from(interviews).where(eq(interviews.jobId, id)).orderBy(asc(interviews.scheduledAt)),
    db.select().from(rejections).where(eq(rejections.jobId, id)).limit(1),
    db.select().from(requests).where(eq(requests.jobId, id)).orderBy(desc(requests.createdAt)).limit(20),
    getSearchSettings(),
    getAppTimeZone(),
    getWorkspace(),
  ]);
  const inProgressRequestIds = jobRequests.filter((request) => request.status === "in_progress").map((request) => request.id);
  const [requestTasks, { status: assistantStatus }] = await Promise.all([
    inProgressRequestIds.length
      ? db.select({ requestId: agentTasks.requestId, status: agentTasks.status, leaseExpiresAt: agentTasks.leaseExpiresAt })
        .from(agentTasks)
        .where(and(inArray(agentTasks.requestId, inProgressRequestIds), eq(agentTasks.status, "running")))
      : Promise.resolve([]),
    loadAssistantStatus(db, { settings, timeZone, assistantLabel: workspace.assistantLabel, now }),
  ]);
  const interruptedRequestIds = interruptedRequestIdsFor(jobRequests, requestTasks, now);
  return { ...rows[0], history, activity: notes, tailorings, feedback: jobFeedback, interviews: jobInterviews, rejection: rejection[0] ?? null, requests: jobRequests, assistantStatus, interruptedRequestIds };
}

export async function getInterviewCandidateJobs() {
  if (!hasDatabase()) return [];
  return getDb().select({ job: jobs, company: companies }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(sql`${jobs.status} not in ('rejected','withdrawn','irrelevant','archived')`).orderBy(asc(companies.name), asc(jobs.title));
}

export async function getInterviewsData() {
  if (!hasDatabase()) return [];
  return getDb().select({ interview: interviews, job: jobs, company: companies }).from(interviews).innerJoin(jobs, eq(interviews.jobId, jobs.id)).innerJoin(companies, eq(jobs.companyId, companies.id)).orderBy(asc(interviews.scheduledAt));
}

export async function getInterviewDetail(id: string) {
  if (!hasDatabase()) return null;
  const db = getDb();
  const now = new Date();
  const rows = await db.select({ interview: interviews, job: jobs, company: companies }).from(interviews).innerJoin(jobs, eq(interviews.jobId, jobs.id)).innerJoin(companies, eq(jobs.companyId, companies.id)).where(eq(interviews.id, id)).limit(1);
  if (!rows[0]) return null;
  const [people, briefs, interviewRequests, settings, timeZone, workspace] = await Promise.all([
    db.select().from(interviewers).where(eq(interviewers.interviewId, id)),
    db.select().from(prepBriefs).where(eq(prepBriefs.interviewId, id)).orderBy(desc(prepBriefs.createdAt)),
    db.select().from(requests).where(eq(requests.jobId, rows[0].job.id)).orderBy(desc(requests.createdAt)).limit(10),
    getSearchSettings(),
    getAppTimeZone(),
    getWorkspace(),
  ]);
  const inProgressRequestIds = interviewRequests.filter((request) => request.status === "in_progress").map((request) => request.id);
  const [requestTasks, { status: assistantStatus }] = await Promise.all([
    inProgressRequestIds.length
      ? db.select({ requestId: agentTasks.requestId, status: agentTasks.status, leaseExpiresAt: agentTasks.leaseExpiresAt })
        .from(agentTasks)
        .where(and(inArray(agentTasks.requestId, inProgressRequestIds), eq(agentTasks.status, "running")))
      : Promise.resolve([]),
    loadAssistantStatus(db, { settings, timeZone, assistantLabel: workspace.assistantLabel, now }),
  ]);
  const interruptedRequestIds = interruptedRequestIdsFor(interviewRequests, requestTasks, now);
  return { ...rows[0], interviewers: people, briefs, requests: interviewRequests, assistantStatus, interruptedRequestIds };
}

export async function getCvData(slug?: string, tailoringId?: string) {
  if (!hasDatabase()) return { variants: [], selected: null, tailoring: null, pending: [], document: null };
  const db = getDb();
  const variants = await db.select().from(cvVariants).orderBy(asc(cvVariants.name));
  let selected = variants.find((item) => item.slug === slug) ?? variants[0] ?? null;
  if (tailoringId) {
    const [requested] = await db.select({ cvVariantId: cvTailorings.cvVariantId }).from(cvTailorings).where(eq(cvTailorings.id, tailoringId)).limit(1);
    selected = variants.find((item) => item.id === requested?.cvVariantId) ?? selected;
  }
  const pending = await db.select({ id: cvTailorings.id, cvVariantId: cvTailorings.cvVariantId, changes: cvTailorings.changes, jobTitle: jobs.title, company: companies.name }).from(cvTailorings).innerJoin(jobs, eq(cvTailorings.jobId, jobs.id)).innerJoin(companies, eq(jobs.companyId, companies.id)).where(eq(cvTailorings.status, "proposed")).orderBy(desc(cvTailorings.createdAt));
  if (!selected) return { variants, selected: null, tailoring: null, pending, document: null };
  const [tailorings, documents] = await Promise.all([
    db.select({ tailoring: cvTailorings, job: jobs, company: companies }).from(cvTailorings).innerJoin(jobs, eq(cvTailorings.jobId, jobs.id)).innerJoin(companies, eq(jobs.companyId, companies.id)).where(tailoringId ? and(eq(cvTailorings.cvVariantId, selected.id), eq(cvTailorings.id, tailoringId)) : and(eq(cvTailorings.cvVariantId, selected.id), eq(cvTailorings.status, "proposed"))).orderBy(desc(cvTailorings.createdAt)).limit(1),
    db.select({ variantId: cvDocuments.variantId, fileName: cvDocuments.fileName, updatedAt: cvDocuments.updatedAt }).from(cvDocuments).where(eq(cvDocuments.variantId, selected.id)).limit(1),
  ]);
  return { variants, selected, tailoring: tailorings[0] ?? null, pending, document: documents[0] ?? null };
}

export async function getSettingsData() {
  if (!hasDatabase()) return { settings: DEFAULT_SEARCH_SETTINGS, preferences: DEFAULT_NOTIFICATION_PREFERENCES, target: null, timeZone: DEFAULT_TIME_ZONE };
  const db = getDb();
  const timeZone = await getAppTimeZone();
  const weekStart = startOfWeek(new Date(), timeZone);
  const [settings, preferences, target] = await Promise.all([
    getSearchSettings(),
    db.select().from(notificationPreferences).where(eq(notificationPreferences.id, WORKSPACE_ID)).limit(1),
    db.select().from(weeklyTargets).where(sql`${weeklyTargets.weekStart} <= ${weekStart}::date`).orderBy(desc(weeklyTargets.weekStart)).limit(1),
  ]);
  return { settings, preferences: preferences[0] ?? DEFAULT_NOTIFICATION_PREFERENCES, target: target[0] ?? null, timeZone };
}

export async function isSearchQueued() {
  if (!hasDatabase()) return false;
  const [row] = await getDb().select({ id: requests.id }).from(requests).where(and(inArray(requests.purpose, ["search_now", "scheduled_search"]), inArray(requests.status, ["open", "in_progress"]))).limit(1);
  return Boolean(row);
}

export async function searchJobs(query: string, status?: JobStatus) {
  const filters = [or(ilike(jobs.title, `%${query}%`), ilike(companies.name, `%${query}%`))];
  if (status) filters.push(eq(jobs.status, status));
  return getDb().select({ job: jobs, company: companies }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(and(...filters)).limit(50);
}

function registeredWorkers() {
  try {
    return workerRegistry();
  } catch {
    // Invalid worker configuration is reported by health checks; treat it as
    // no available worker here rather than failing the activity page.
    return [];
  }
}

export async function getActivityData() {
  if (!hasDatabase()) return { tasks: [], dismissedRequestIds: [] as string[], interruptedTaskIds: [] as string[], interruptedRequestIds: [] as string[], runs: [], events: [], requests: [], workerPauses: [], heldExecutors: [], registeredExecutors: [] as string[], lastSearchStartedAt: null, pendingAnalysisCount: 0, timeZone: DEFAULT_TIME_ZONE, settings: DEFAULT_SEARCH_SETTINGS, assistantStatus: defaultAssistantStatus() };
  const db = getDb();
  const now = new Date();
  const [timeZone, settings, workspace] = await Promise.all([getAppTimeZone(), getSearchSettings(), getWorkspace()]);
  const [runs, events, pendingAnalysisCount, snapshot] = await Promise.all([
    db.select().from(automationRuns).orderBy(desc(automationRuns.startedAt)).limit(30),
    db.select({ entry: activityLog, job: { id: jobs.id, title: jobs.title }, company: { name: companies.name } }).from(activityLog).leftJoin(jobs, eq(activityLog.jobId, jobs.id)).leftJoin(companies, eq(jobs.companyId, companies.id)).orderBy(desc(activityLog.createdAt)).limit(120),
    db.select({ count: sql<number>`count(*)::int` }).from(jobs).where(inArray(jobs.analysisStatus, ["pending", "in_progress", "failed"])),
    // Tasks, pauses, contacts, requests and assistant status come from one
    // snapshot so the header card never disagrees with rows below it.
    // Keep queries inside the transaction sequential for postgres.js compatibility.
    db.transaction(async (tx) => {
      const tasks = await tx.select().from(agentTasks).orderBy(desc(agentTasks.createdAt)).limit(100);
      const workerPauses = await tx.select().from(agentWorkerPauses).orderBy(agentWorkerPauses.pausedAt);
      const workerContacts = await tx.select().from(agentWorkerContacts);
      const requestRows = await tx.select({ request: requests, job: { id: jobs.id, title: jobs.title }, company: { name: companies.name } }).from(requests).leftJoin(jobs, eq(requests.jobId, jobs.id)).leftJoin(companies, eq(jobs.companyId, companies.id)).orderBy(desc(requests.createdAt)).limit(40);
      const waitingRows = await tx.select({ count: sql<number>`count(*)::int` }).from(requests).where(inArray(requests.status, ["open", "in_progress"]));
      // Every task running (including interrupted), waiting for the owner, or
      // held by a paused worker stays reachable when newer tasks push it out
      // of the recent window.
      const listedTaskIds = tasks.map((task) => task.id);
      const pausedTaskIds = workerPauses.map((pause) => pause.taskId).filter((id): id is string => Boolean(id));
      tasks.push(...await tx.select().from(agentTasks).where(and(
        or(eq(agentTasks.status, "running"), eq(agentTasks.status, "waiting_for_user"), pausedTaskIds.length ? inArray(agentTasks.id, pausedTaskIds) : undefined),
        listedTaskIds.length ? notInArray(agentTasks.id, listedTaskIds) : undefined,
      )).orderBy(desc(agentTasks.updatedAt)));
      // After the out-of-window additions, so those tasks carry the dismissal too.
      const taskRequestIds = [...new Set(tasks.map((task) => task.requestId).filter((id): id is string => Boolean(id)))];
      const dismissedRequests = taskRequestIds.length
        ? await tx.select({ id: requests.id }).from(requests).where(and(inArray(requests.id, taskRequestIds), eq(requests.status, "dismissed")))
        : [];
      const waitingRequests = waitingRows[0]?.count ?? 0;
      const runningTasks = tasks.filter((task) => task.status === "running");
      const { status: assistantStatus, lastSuccessfulSearchAt } = await loadAssistantStatus(tx, {
        settings,
        timeZone,
        assistantLabel: workspace.assistantLabel,
        now,
        sequential: true,
        runningTasks,
        workerPauses,
        workerContacts,
        waitingRequests,
      });
      return {
        tasks,
        workerPauses,
        requestRows,
        dismissedRequestIds: dismissedRequests.map((row) => row.id),
        assistantStatus,
        lastSuccessfulSearchAt,
      };
    }, { isolationLevel: "repeatable read", accessMode: "read only" }),
  ]);
  const { tasks, workerPauses, requestRows, dismissedRequestIds, assistantStatus, lastSuccessfulSearchAt } = snapshot;
  const registry = registeredWorkers();
  const interruptedTaskIds = tasks.filter((task) => isInterruptedTask(task, now)).map((task) => task.id);
  const interruptedRequestIds = interruptedRequestIdsFor(requestRows.map((row) => row.request), tasks, now);
  return {
    tasks: tasks.map(({ claimTokenHash, ...task }) => { void claimTokenHash; return task; }),
    dismissedRequestIds,
    interruptedTaskIds,
    interruptedRequestIds,
    runs,
    events,
    requests: requestRows,
    workerPauses,
    heldExecutors: heldExecutors(workerPauses, registry),
    registeredExecutors: [...new Set(registry.map((worker) => worker.executor as string))],
    lastSearchStartedAt: lastSuccessfulSearchAt,
    pendingAnalysisCount: pendingAnalysisCount[0]?.count ?? 0,
    timeZone,
    settings,
    assistantStatus,
  };
}
