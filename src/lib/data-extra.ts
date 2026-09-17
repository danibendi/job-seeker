import "server-only";
import { asc, sql } from "drizzle-orm";
import { getDb, hasDatabase } from "@/db";
import { agencies, feedback, jobs, rejections, weeklyTargets, watchlistItems } from "@/db/schema";
import { aggregateFeedbackReasons } from "@/lib/feedback-summary";

export async function getInsightsData() {
  if (!hasDatabase()) return { funnel: [], targets: [], reasons: [], rejectionReasons: [] };
  const db = getDb();
  const [funnel, targets, reasonRows, rejectionReasons] = await Promise.all([
    db.select({ status: jobs.status, count: sql<number>`count(*)::int` }).from(jobs).groupBy(jobs.status),
    db.select({ weekStart: weeklyTargets.weekStart, target: weeklyTargets.applicationsTarget, actual: sql<number>`(select count(*)::int from job_status_history h where h.to_status = 'applied' and h.created_at::date >= ${weeklyTargets.weekStart}::date and h.created_at::date < ${weeklyTargets.weekStart}::date + 7)` }).from(weeklyTargets).orderBy(asc(weeklyTargets.weekStart)),
    db.select({ reasons: feedback.reasons }).from(feedback),
    db.select({ reason: rejections.reasonCategory, count: sql<number>`count(*)::int` }).from(rejections).groupBy(rejections.reasonCategory).orderBy(sql`count(*) desc`),
  ]);
  return { funnel, targets, reasons: aggregateFeedbackReasons(reasonRows), rejectionReasons };
}

export async function getAgenciesData() {
  if (!hasDatabase()) return [];
  return getDb().select().from(agencies).orderBy(asc(agencies.name));
}

export async function getWatchlistData() {
  if (!hasDatabase()) return [];
  return getDb().select().from(watchlistItems).orderBy(asc(watchlistItems.label));
}
