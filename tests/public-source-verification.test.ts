import { describe, expect, it } from "vitest";
import { trustedPublicSourceReceiptIssue, publicSourceVerificationIssue, publicSourceVerificationSchema } from "../src/lib/public-source-verification";

const taskStartedAt = new Date("2026-09-13T14:00:00Z");
const now = new Date("2026-09-13T14:05:00Z");
const verification = {
  server_receipt_id: "11111111-1111-4111-8111-111111111111",
  retrieval_method: "direct_live_fetch" as const,
  checked_at: "2026-09-13T14:04:00Z",
  direct_employer_url: "https://employer.example/jobs/program-manager",
  http_status: 200 as const,
  direct_employer: true as const,
  full_vacancy_page: true as const,
  vacancy_open: true as const,
  closing_date: "2026-09-30",
  evidence_summary: "The complete employer vacancy page is open and accepts applications.",
};

const receipt = {
  receipt_id: verification.server_receipt_id,
  authority: "server_direct_fetch" as const,
  task_id: "22222222-2222-4222-8222-222222222222",
  attempt: 2,
  initial_url: verification.direct_employer_url,
  final_url: verification.direct_employer_url,
  checked_at: verification.checked_at,
  http_status: 200 as const,
  content_type: "text/html",
  body_sha256: "b".repeat(64),
  body_bytes: 10_000,
  expected_title: "Program Manager",
  expected_company: "Employer",
  static_html_vacancy_shaped: true as const,
  soft_closed: false as const,
  title_matched: true as const,
  company_matched: true as const,
  apply_signal: true as const,
  vacancy_section_signal_count: 3,
};

describe("public source verification", () => {
  it("requires explicit successful full-page and open-vacancy attestations", () => {
    expect(publicSourceVerificationSchema.safeParse(verification).success).toBe(true);
    expect(publicSourceVerificationSchema.safeParse({ ...verification, http_status: 404 }).success).toBe(false);
    expect(publicSourceVerificationSchema.safeParse({ ...verification, retrieval_method: "cached_snippet" }).success).toBe(false);
    expect(publicSourceVerificationSchema.safeParse({ ...verification, direct_employer: false }).success).toBe(false);
    expect(publicSourceVerificationSchema.safeParse({ ...verification, vacancy_open: false }).success).toBe(false);
    expect(publicSourceVerificationSchema.safeParse({ ...verification, full_vacancy_page: false }).success).toBe(false);
  });

  it("binds the check to the task attempt and exact saved employer URL", () => {
    expect(publicSourceVerificationIssue({ jobUrl: verification.direct_employer_url, taskStartedAt, verification, now })).toBeNull();
    expect(publicSourceVerificationIssue({ jobUrl: "https://aggregator.example/jobs/123", taskStartedAt, verification, now })).toMatch(/exact live direct-employer/);
    expect(publicSourceVerificationIssue({ jobUrl: verification.direct_employer_url, taskStartedAt: new Date("2026-09-13T14:04:30Z"), verification, now })).toMatch(/this task attempt/);
  });

  it("rejects stale, malformed and missing evidence even when the route schema is bypassed", () => {
    for (const invalid of [undefined, {}, { ...verification, http_status: 404 }, { ...verification, checked_at: "not-a-date" }]) {
      expect(publicSourceVerificationIssue({ jobUrl: verification.direct_employer_url, taskStartedAt, verification: invalid, now })).toMatch(/attestation is required/);
    }
    expect(publicSourceVerificationIssue({ jobUrl: verification.direct_employer_url, taskStartedAt, verification, now: new Date("2026-09-13T14:35:00Z") })).toMatch(/older than 30 minutes/);
    expect(publicSourceVerificationIssue({ jobUrl: verification.direct_employer_url, taskStartedAt: null, verification, now })).toMatch(/this task attempt/);
    expect(publicSourceVerificationIssue({ jobUrl: "invalid-url", taskStartedAt, verification, now })).toMatch(/valid source URLs/);
  });

  it("rejects expired deadlines and future-dated checks", () => {
    expect(publicSourceVerificationIssue({ jobUrl: verification.direct_employer_url, taskStartedAt, verification: { ...verification, closing_date: "2026-09-12" }, now })).toMatch(/closing date has passed/);
    expect(publicSourceVerificationIssue({ jobUrl: verification.direct_employer_url, taskStartedAt, verification: { ...verification, checked_at: "2026-09-13T14:11:00Z" }, now })).toMatch(/future/);
  });

  it("binds a server receipt to the exact task attempt, final URL and vacancy identity", () => {
    const base = { taskId: receipt.task_id, attempt: receipt.attempt, taskStartedAt, jobUrl: receipt.final_url, title: receipt.expected_title, company: receipt.expected_company, verification, receipt, now };
    expect(trustedPublicSourceReceiptIssue(base)).toBeNull();
    expect(trustedPublicSourceReceiptIssue({ ...base, attempt: 3 })).toMatch(/another task attempt/);
    expect(trustedPublicSourceReceiptIssue({ ...base, jobUrl: "https://employer.example/jobs/other" })).toMatch(/server-verified final/);
    expect(trustedPublicSourceReceiptIssue({ ...base, title: "Other role" })).toMatch(/vacancy identity/);
    expect(trustedPublicSourceReceiptIssue({ ...base, verification: { ...verification, checked_at: "2026-09-13T14:03:00Z" } })).toMatch(/time must match/);
    expect(trustedPublicSourceReceiptIssue({ ...base, receipt: { ...receipt, authority: "model_attested" } })).toMatch(/server source-verification receipt/);
  });
});
