import { z } from "zod";
import { trustedPublicSourceReceiptSchema } from "@/lib/public-source-fetch";

export const PUBLIC_SOURCE_FRESHNESS_MS = 30 * 60 * 1000;

export const publicSourceVerificationSchema = z.object({
  server_receipt_id: z.uuid(),
  retrieval_method: z.literal("direct_live_fetch"),
  checked_at: z.iso.datetime({ offset: true }),
  direct_employer_url: z.url().max(4000),
  http_status: z.literal(200),
  direct_employer: z.literal(true),
  full_vacancy_page: z.literal(true),
  vacancy_open: z.literal(true),
  closing_date: z.iso.date().nullable(),
  evidence_summary: z.string().min(20).max(2000),
});

export type PublicSourceVerification = z.infer<typeof publicSourceVerificationSchema>;

export function trustedPublicSourceReceiptIssue(input: {
  taskId: string;
  attempt: number;
  taskStartedAt: Date | null;
  jobUrl: string;
  title: string;
  company: string;
  verification: PublicSourceVerification;
  receipt: unknown;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const parsed = trustedPublicSourceReceiptSchema.safeParse(input.receipt);
  if (!parsed.success) return "A current server source-verification receipt is required";
  const receipt = parsed.data;
  if (receipt.task_id !== input.taskId || receipt.attempt !== input.attempt) return "Server source receipt belongs to another task attempt";
  if (input.verification.server_receipt_id !== receipt.receipt_id) return "Worker attestation does not identify the server source receipt";
  if (input.verification.checked_at !== receipt.checked_at) return "Worker attestation time must match the server source receipt";
  if (input.verification.direct_employer_url !== receipt.final_url) return "Worker attestation URL must match the server-verified final vacancy URL";
  const checkedAt = new Date(receipt.checked_at);
  if (!input.taskStartedAt || checkedAt < input.taskStartedAt || checkedAt > now || now.getTime() - checkedAt.getTime() > PUBLIC_SOURCE_FRESHNESS_MS) {
    return "Server source receipt is outside the current task verification window";
  }
  if (receipt.final_url !== input.jobUrl) return "Saved URL must match the server-verified final vacancy URL";
  if (receipt.expected_title !== input.title || receipt.expected_company !== input.company) return "Saved vacancy identity must match the server-verified source receipt";
  return null;
}

export function publicSourceVerificationIssue(input: {
  jobUrl: string;
  taskStartedAt: Date | null;
  verification: unknown;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  // This validates the worker model's explicit attestation. It is not a
  // server fetch, provider receipt, or independent proof of source liveness.
  const parsed = publicSourceVerificationSchema.safeParse(input.verification);
  if (!parsed.success) return "A complete direct-live-fetch source attestation is required";
  const verification = parsed.data;
  const checkedAt = new Date(verification.checked_at);
  if (!input.taskStartedAt || !Number.isFinite(input.taskStartedAt.getTime()) || checkedAt < input.taskStartedAt) {
    return "Source verification must come from this task attempt";
  }
  if (checkedAt.getTime() > now.getTime() + 5 * 60 * 1000) {
    return "Source verification time is in the future";
  }
  if (now.getTime() - checkedAt.getTime() > PUBLIC_SOURCE_FRESHNESS_MS) {
    return "Source verification is older than 30 minutes; verify the vacancy again";
  }

  let jobUrl: URL;
  let employerUrl: URL;
  try {
    jobUrl = new URL(input.jobUrl);
    employerUrl = new URL(verification.direct_employer_url);
  } catch {
    return "Source verification requires valid source URLs";
  }
  if (employerUrl.protocol !== "https:" || employerUrl.username || employerUrl.password) {
    return "Source verification requires a public HTTPS employer URL";
  }
  if (employerUrl.href !== jobUrl.href) {
    return "Saved URL must be the exact live direct-employer vacancy URL";
  }

  const serverDate = now.toISOString().slice(0, 10);
  if (verification.closing_date && verification.closing_date < serverDate) {
    return "The vacancy closing date has passed";
  }
  return null;
}
