import { z } from "zod";
import { stableJsonHash } from "./agent-task-contract";

export const LINKEDIN_BOOTSTRAP_LOOKBACK_SECONDS = 30 * 24 * 60 * 60;
export const LINKEDIN_DAILY_LOOKBACK_SECONDS = 24 * 60 * 60;
export const LINKEDIN_PROVIDER_PAGE_SIZE = 25;
export const LINKEDIN_PROVIDER_MAX_PAGES_PER_LANE = 40;
export const LINKEDIN_PROVIDER_VISIBLE_RESULT_CAP = LINKEDIN_PROVIDER_PAGE_SIZE * LINKEDIN_PROVIDER_MAX_PAGES_PER_LANE;
export const LINKEDIN_SCAN_MAX_LANES = 64;
export const LINKEDIN_SCAN_MAX_PENDING_DETAILS_RETURNED = 300;
export const linkedinScanTrackSchema = z.enum(["fresh", "backfill"]);

const linkedinJobIdSchema = z.string().regex(/^\d{6,40}$/, "LinkedIn job ID must be numeric");
const cursorSchema = z.string().min(1).max(2_000).refine((value) => !/[\r\n]/.test(value), "Cursor must be one line");

function validLinkedinSearchUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !["linkedin.com", "www.linkedin.com"].includes(parsed.hostname.toLowerCase())) return false;
    if (parsed.username || parsed.password || parsed.hash || !/^\/jobs\/search\/?$/.test(parsed.pathname)) return false;
    if (parsed.searchParams.has("f_TPR")) return false;
    const entries = [...parsed.searchParams.entries()];
    if (entries.length > 20 || new Set(entries.map(([key]) => key)).size !== entries.length) return false;
    return entries.every(([key, valuePart]) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && valuePart.length <= 500);
  } catch {
    return false;
  }
}

export const linkedinScanLaneSchema = z.object({
  lane_key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
  query: z.string().trim().min(1).max(500),
  search_url: z.string().max(4_000).refine(validLinkedinSearchUrl, "A bounded LinkedIn jobs search URL without f_TPR is required"),
}).superRefine((lane, context) => {
  const keywords = new URL(lane.search_url).searchParams.get("keywords")?.trim();
  if (keywords && keywords !== lane.query) context.addIssue({ code: "custom", path: ["search_url"], message: "LinkedIn keywords must match the lane query" });
});

export const linkedinScanPlanSchema = z.object({
  schema_version: z.literal(2),
  // Revision 2 excludes LinkedIn recommendation cards from search results.
  // Legacy plans retain their original hash; corrected discovery starts its own
  // bootstrap instead of inheriting pending recommendations or settled pages.
  collector_revision: z.union([z.literal(1), z.literal(2)]).optional(),
  track: linkedinScanTrackSchema.default("backfill"),
  policy_hash: z.string().length(64),
  lanes: z.array(linkedinScanLaneSchema).min(1).max(LINKEDIN_SCAN_MAX_LANES),
}).superRefine((plan, context) => {
  const keys = new Set<string>();
  for (const [index, lane] of plan.lanes.entries()) {
    if (keys.has(lane.lane_key)) context.addIssue({ code: "custom", path: ["lanes", index, "lane_key"], message: "Lane keys must be unique" });
    keys.add(lane.lane_key);
  }
});

export const linkedinScanPageSchema = z.object({
  track: linkedinScanTrackSchema.default("backfill"),
  plan_hash: z.string().length(64),
  lane_key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
  page: z.number().int().min(1).max(100_000),
  page_complete: z.literal(true),
  source_cursor: cursorSchema.optional(),
  next_cursor: cursorSchema.optional(),
  job_ids: z.array(linkedinJobIdSchema).max(300),
  pending_detail_job_ids: z.array(linkedinJobIdSchema).max(300).default([]),
  exhausted: z.boolean(),
}).superRefine((page, context) => {
  const ids = new Set(page.job_ids);
  if (ids.size !== page.job_ids.length) context.addIssue({ code: "custom", path: ["job_ids"], message: "Job IDs must be unique" });
  if (new Set(page.pending_detail_job_ids).size !== page.pending_detail_job_ids.length) context.addIssue({ code: "custom", path: ["pending_detail_job_ids"], message: "Pending detail job IDs must be unique" });
  if (page.pending_detail_job_ids.some((id) => !ids.has(id))) context.addIssue({ code: "custom", path: ["pending_detail_job_ids"], message: "Pending detail IDs must occur on this page" });
  if (page.exhausted && page.next_cursor !== undefined) context.addIssue({ code: "custom", path: ["next_cursor"], message: "An exhausted page cannot have a next cursor" });
  if (!page.exhausted && !page.next_cursor) context.addIssue({ code: "custom", path: ["next_cursor"], message: "A non-exhausted page requires a next cursor" });
  if (!page.exhausted && page.job_ids.length === 0) context.addIssue({ code: "custom", path: ["job_ids"], message: "An empty page must be exhausted" });
});

export const linkedinScanDetailsSchema = z.object({
  track: linkedinScanTrackSchema.default("backfill"),
  plan_hash: z.string().length(64),
  job_ids: z.array(linkedinJobIdSchema).min(1).max(300),
}).superRefine((input, context) => {
  if (new Set(input.job_ids).size !== input.job_ids.length) context.addIssue({ code: "custom", path: ["job_ids"], message: "Job IDs must be unique" });
});

export const LINKEDIN_SCAN_STOP_REASONS = ["source_cap", "authentication_required", "browser_unavailable", "pagination_unverified", "detail_unavailable", "page_budget", "detail_budget", "time_budget"] as const;
export const linkedinScanStopSchema = z.object({
  track: linkedinScanTrackSchema.default("backfill"),
  plan_hash: z.string().length(64),
  lane_key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/).optional(),
  detail_job_id: linkedinJobIdSchema.optional(),
  pending_detail_job_ids: z.array(linkedinJobIdSchema).max(300).default([]),
  reason: z.enum(LINKEDIN_SCAN_STOP_REASONS),
}).superRefine((input, context) => {
  if (new Set(input.pending_detail_job_ids).size !== input.pending_detail_job_ids.length) context.addIssue({ code: "custom", path: ["pending_detail_job_ids"], message: "Pending detail job IDs must be unique" });
  if (input.pending_detail_job_ids.length && !input.lane_key) context.addIssue({ code: "custom", path: ["lane_key"], message: "A lane is required when preserving incomplete-page pending IDs" });
  if (input.reason === "detail_unavailable" && !input.detail_job_id) context.addIssue({ code: "custom", path: ["detail_job_id"], message: "An unavailable detail stop requires its job ID" });
  if (input.reason !== "detail_unavailable" && input.detail_job_id) context.addIssue({ code: "custom", path: ["detail_job_id"], message: "A detail job ID is only valid for unavailable detail evidence" });
});

export type LinkedinScanPlan = z.infer<typeof linkedinScanPlanSchema>;
export type LinkedinScanPage = z.infer<typeof linkedinScanPageSchema>;
export type LinkedinScanDetails = z.infer<typeof linkedinScanDetailsSchema>;
export type LinkedinScanStop = z.infer<typeof linkedinScanStopSchema>;
export type LinkedinScanTrack = z.infer<typeof linkedinScanTrackSchema>;

export function normalizedLinkedinScanPlan(plan: LinkedinScanPlan) {
  return {
    schemaVersion: 2 as const,
    ...(plan.collector_revision === 2 ? { collectorRevision: 2 as const } : {}),
    cadence: {
      bootstrapLookbackSeconds: LINKEDIN_BOOTSTRAP_LOOKBACK_SECONDS,
      dailyLookbackSeconds: LINKEDIN_DAILY_LOOKBACK_SECONDS,
      providerPageSize: LINKEDIN_PROVIDER_PAGE_SIZE,
      providerMaxPagesPerLane: LINKEDIN_PROVIDER_MAX_PAGES_PER_LANE,
    },
    lanes: [...plan.lanes]
      .map((lane) => ({ laneKey: lane.lane_key, query: lane.query, searchUrl: lane.search_url }))
      .sort((left, right) => left.laneKey.localeCompare(right.laneKey)),
  };
}

export function linkedinScanPlanHash(scopeKey: string, policyHash: string, plan: LinkedinScanPlan) {
  return stableJsonHash({ scopeKey, policyHash, plan: normalizedLinkedinScanPlan(plan) });
}
