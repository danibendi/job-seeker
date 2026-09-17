import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, hasDatabase } from "@/db";
import {
  activityLog,
  agentTasks,
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
import { DEFAULT_SEARCH_SETTINGS, normalizeLocations, normalizeRemote, normalizeSchedule, type SearchSettingsValues } from "@/lib/settings";
import { DEFAULT_TIME_ZONE, isValidTimeZone, startOfWeek } from "@/lib/time";
import { getWorkspace } from "@/lib/workspace";
import { DEFAULT_WORKSPACE, WORKSPACE_ID } from "@/lib/workspace-values";

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

export async function getTodayData() {
  if (!hasDatabase()) return {
    jobs: [], tailorings: [], interviews: [], followUps: [], failedRequests: [], pendingRequests: 0, recentFailure: null,
    stats: { applications: 0, target: 0, interviewing: 0, review: 0, hidden: 0 }, timeZone: DEFAULT_TIME_ZONE, workspace: DEFAULT_WORKSPACE,
  };
  const db = getDb();
  const [settings, timeZone, workspace] = await Promise.all([getSearchSettings(), getAppTimeZone(), getWorkspace()]);
  const weekStart = startOfWeek(new Date(), timeZone);
  const followUpCutoff = new Date(Date.now() - settings.followUpDays * 86_400_000);
  const inboxFilter = and(isNull(jobs.triagedAt), eq(jobs.status, "sourced"));
  const visibleFilter = and(inboxFilter, or(isNull(jobs.fitScore), gte(jobs.fitScore, settings.minimumFitScore)));
  const [untriaged, reviewCount, totalCount, pendingTailorings, upcoming, failedRequests, pendingRequests, applicationCount, interviewCount, target, followUps, recentFailure] = await Promise.all([
    db.select({ job: jobs, company: companies }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(visibleFilter).orderBy(sql`${jobs.fitScore} desc nulls last`, asc(jobs.discoveredAt)).limit(40),
    db.select({ count: sql<number>`count(*)::int` }).from(jobs).where(visibleFilter),
    db.select({ count: sql<number>`count(*)::int` }).from(jobs).where(inboxFilter),
    db.select({ tailoring: cvTailorings, job: jobs, company: companies }).from(cvTailorings).innerJoin(jobs, eq(cvTailorings.jobId, jobs.id)).innerJoin(companies, eq(jobs.companyId, companies.id)).where(eq(cvTailorings.status, "proposed")).orderBy(desc(cvTailorings.createdAt)).limit(10),
    db.select({ interview: interviews, job: jobs, company: companies }).from(interviews).innerJoin(jobs, eq(interviews.jobId, jobs.id)).innerJoin(companies, eq(jobs.companyId, companies.id)).where(and(gte(interviews.scheduledAt, new Date()), eq(interviews.outcome, "pending"))).orderBy(asc(interviews.scheduledAt)).limit(3),
    db.select().from(requests).where(eq(requests.status, "failed")).orderBy(asc(requests.createdAt)).limit(5),
    db.select({ count: sql<number>`count(*)::int` }).from(requests).where(inArray(requests.status, ["open", "in_progress"])),
    db.select({ count: sql<number>`count(distinct ${jobStatusHistory.jobId})::int` }).from(jobStatusHistory).where(and(eq(jobStatusHistory.toStatus, "applied"), gte(jobStatusHistory.createdAt, sql`(${weekStart}::date::timestamp at time zone ${timeZone})`))),
    db.select({ count: sql<number>`count(*)::int` }).from(jobs).where(inArray(jobs.status, ["screening", "interviewing", "offer"])),
    db.select().from(weeklyTargets).where(sql`${weeklyTargets.weekStart} <= ${weekStart}::date`).orderBy(desc(weeklyTargets.weekStart)).limit(1),
    db.select({ job: jobs, company: companies }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).where(and(eq(jobs.status, "applied"), lte(jobs.statusChangedAt, followUpCutoff), sql`not exists (select 1 from activity_log followup where followup.job_id = ${jobs.id} and followup.type = 'followup_completed' and followup.created_at > ${jobs.statusChangedAt})`)).orderBy(asc(jobs.statusChangedAt)).limit(10),
    db.select().from(automationRuns).where(and(eq(automationRuns.status, "failed"), gte(automationRuns.startedAt, new Date(Date.now() - 48 * 3_600_000)))).orderBy(desc(automationRuns.startedAt)).limit(1),
  ]);
  return {
    jobs: untriaged,
    tailorings: pendingTailorings,
    interviews: upcoming,
    followUps,
    failedRequests,
    pendingRequests: pendingRequests[0]?.count ?? 0,
    recentFailure: recentFailure[0] ?? null,
    timeZone,
    workspace,
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
  const rows = await db.select({ job: jobs, company: companies, cv: cvVariants }).from(jobs).innerJoin(companies, eq(jobs.companyId, companies.id)).leftJoin(cvVariants, eq(jobs.recommendedCvVariantId, cvVariants.id)).where(eq(jobs.id, id)).limit(1);
  if (!rows[0]) return null;
  const [history, notes, tailorings, jobFeedback, jobInterviews, rejection, jobRequests] = await Promise.all([
    db.select().from(jobStatusHistory).where(eq(jobStatusHistory.jobId, id)).orderBy(desc(jobStatusHistory.createdAt)),
    db.select().from(activityLog).where(eq(activityLog.jobId, id)).orderBy(desc(activityLog.createdAt)).limit(50),
    db.select({ tailoring: cvTailorings, cv: cvVariants }).from(cvTailorings).innerJoin(cvVariants, eq(cvTailorings.cvVariantId, cvVariants.id)).where(eq(cvTailorings.jobId, id)).orderBy(desc(cvTailorings.createdAt)),
    db.select().from(feedback).where(eq(feedback.jobId, id)).orderBy(desc(feedback.createdAt)),
    db.select().from(interviews).where(eq(interviews.jobId, id)).orderBy(asc(interviews.scheduledAt)),
    db.select().from(rejections).where(eq(rejections.jobId, id)).limit(1),
    db.select().from(requests).where(eq(requests.jobId, id)).orderBy(desc(requests.createdAt)).limit(20),
  ]);
  return { ...rows[0], history, activity: notes, tailorings, feedback: jobFeedback, interviews: jobInterviews, rejection: rejection[0] ?? null, requests: jobRequests };
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
  const rows = await db.select({ interview: interviews, job: jobs, company: companies }).from(interviews).innerJoin(jobs, eq(interviews.jobId, jobs.id)).innerJoin(companies, eq(jobs.companyId, companies.id)).where(eq(interviews.id, id)).limit(1);
  if (!rows[0]) return null;
  const [people, briefs, interviewRequests] = await Promise.all([
    db.select().from(interviewers).where(eq(interviewers.interviewId, id)),
    db.select().from(prepBriefs).where(eq(prepBriefs.interviewId, id)).orderBy(desc(prepBriefs.createdAt)),
    db.select().from(requests).where(eq(requests.jobId, rows[0].job.id)).orderBy(desc(requests.createdAt)).limit(10),
  ]);
  return { ...rows[0], interviewers: people, briefs, requests: interviewRequests };
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

export async function getActivityData() {
  if (!hasDatabase()) return { tasks: [], runs: [], events: [], requests: [], lastSearchStartedAt: null, pendingAnalysisCount: 0, timeZone: DEFAULT_TIME_ZONE, settings: DEFAULT_SEARCH_SETTINGS };
  const db = getDb();
  const [runs, events, requestRows, pendingAnalysisCount, timeZone, settings, tasks, latestTaskSearch, latestLegacySearch] = await Promise.all([
    db.select().from(automationRuns).orderBy(desc(automationRuns.startedAt)).limit(30),
    db.select({ entry: activityLog, job: { id: jobs.id, title: jobs.title }, company: { name: companies.name } }).from(activityLog).leftJoin(jobs, eq(activityLog.jobId, jobs.id)).leftJoin(companies, eq(jobs.companyId, companies.id)).orderBy(desc(activityLog.createdAt)).limit(120),
    db.select({ request: requests, job: { id: jobs.id, title: jobs.title }, company: { name: companies.name } }).from(requests).leftJoin(jobs, eq(requests.jobId, jobs.id)).leftJoin(companies, eq(jobs.companyId, companies.id)).orderBy(desc(requests.createdAt)).limit(40),
    db.select({ count: sql<number>`count(*)::int` }).from(jobs).where(inArray(jobs.analysisStatus, ["pending", "in_progress", "failed"])),
    getAppTimeZone(),
    getSearchSettings(),
    db.select().from(agentTasks).orderBy(desc(agentTasks.createdAt)).limit(100),
    db.select({ startedAt: agentTasks.startedAt }).from(agentTasks).where(eq(agentTasks.kind, "search")).orderBy(sql`${agentTasks.startedAt} desc nulls last`).limit(1),
    db.select({ startedAt: automationRuns.startedAt }).from(automationRuns).where(inArray(automationRuns.workflow, ["daily_search", "search"])).orderBy(desc(automationRuns.startedAt)).limit(1),
  ]);
  const searchStarts = [latestTaskSearch[0]?.startedAt, latestLegacySearch[0]?.startedAt].filter((date): date is Date => Boolean(date));
  const lastSearchStartedAt = searchStarts.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  return { tasks: tasks.map(({ claimTokenHash, ...task }) => { void claimTokenHash; return task; }), runs, events, requests: requestRows, lastSearchStartedAt, pendingAnalysisCount: pendingAnalysisCount[0]?.count ?? 0, timeZone, settings };
}
