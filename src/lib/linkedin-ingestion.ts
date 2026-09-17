import { z } from "zod";
import { companyDisplayNameFitsStorage } from "./company-identity";

export const LINKEDIN_DECISION_PROTECTED_STATES = ["promoted", "claimed", "snapshot_ready", "needs_review"] as const;

export function acceptsLinkedinIngestReplay(storedPayloadHash: string | null, incomingPayloadHash: string) {
  return storedPayloadHash === null || storedPayloadHash === incomingPayloadHash;
}

const evidenceSchema = z.record(z.string(), z.unknown());
const linkedinJobIdSchema = z.string().regex(/^\d{6,40}$/, "LinkedIn job ID must be numeric");

export function canonicalizeLinkedinJobUrl(value: string, expectedJobId?: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || !["linkedin.com", "www.linkedin.com"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("URL must be an HTTPS LinkedIn job URL");
  }
  const match = parsed.pathname.match(/^\/jobs\/view\/(\d{6,40})\/?$/);
  if (!match) throw new Error("URL must use /jobs/view/<numeric-id>");
  const jobId = match[1];
  if (expectedJobId && jobId !== expectedJobId) throw new Error("URL job ID does not match jobId");
  return { jobId, canonicalUrl: `https://www.linkedin.com/jobs/view/${jobId}/` };
}

const itemSchema = z.object({
  candidateId: z.string().min(1).max(120),
  source: z.literal("linkedin"),
  jobId: linkedinJobIdSchema,
  canonicalUrl: z.string().url(),
  title: z.string().min(1).max(500),
  company: z.string().min(1).max(300).optional(),
  location: z.string().max(1000).optional(),
  workMode: z.string().max(120).optional(),
  lane: z.string().min(1).max(160).optional(),
  resultRank: z.number().int().min(1).max(1000).optional(),
  collectorRunKey: z.string().min(1).max(240),
  firstObservedAt: z.string().datetime({ offset: true }),
  compact: evidenceSchema.optional(),
  snapshot: evidenceSchema.optional(),
  titleDecision: evidenceSchema.optional(),
  detailDecision: evidenceSchema.optional(),
  funnelState: z.enum(["discovered_compact", "snapshot_ready"]),
}).superRefine((item, context) => {
  try {
    canonicalizeLinkedinJobUrl(item.canonicalUrl, item.jobId);
  } catch (error) {
    context.addIssue({ code: "custom", path: ["canonicalUrl"], message: error instanceof Error ? error.message : "Invalid LinkedIn URL" });
  }
  if (item.funnelState === "snapshot_ready") {
    if (!item.company || !companyDisplayNameFitsStorage(item.company)) context.addIssue({ code: "custom", path: ["company"], message: "company must normalize to 1 to 300 characters when snapshot_ready" });
    if (!item.snapshot) context.addIssue({ code: "custom", path: ["snapshot"], message: "snapshot is required when snapshot_ready" });
    if (!item.titleDecision) context.addIssue({ code: "custom", path: ["titleDecision"], message: "titleDecision is required when snapshot_ready" });
    if (!item.detailDecision) context.addIssue({ code: "custom", path: ["detailDecision"], message: "detailDecision is required when snapshot_ready" });
  }
});

export const linkedinIngestBatchSchema = z.object({
  schemaVersion: z.literal(1),
  candidateId: z.string().min(1).max(120),
  runKey: z.string().min(1).max(240),
  generatedAt: z.string().datetime({ offset: true }),
  items: z.array(itemSchema).min(1).max(300),
}).superRefine((batch, context) => {
  const ids = new Set<string>();
  let readyCount = 0;
  for (const [index, item] of batch.items.entries()) {
    if (item.candidateId !== batch.candidateId) {
      context.addIssue({ code: "custom", path: ["items", index, "candidateId"], message: "candidateId must match the batch" });
    }
    if (item.collectorRunKey !== batch.runKey) {
      context.addIssue({ code: "custom", path: ["items", index, "collectorRunKey"], message: "collectorRunKey must match runKey" });
    }
    if (ids.has(item.jobId)) context.addIssue({ code: "custom", path: ["items", index, "jobId"], message: "Duplicate job ID in batch" });
    ids.add(item.jobId);
    if (item.funnelState === "snapshot_ready") readyCount += 1;
  }
  if (readyCount > 8) context.addIssue({ code: "custom", path: ["items"], message: "At most 8 snapshot_ready items are allowed per batch" });
});

export type LinkedinIngestBatch = z.infer<typeof linkedinIngestBatchSchema>;

export const LINKEDIN_TERMINAL_STATES = ["promoted", "rejected", "needs_review"] as const;
