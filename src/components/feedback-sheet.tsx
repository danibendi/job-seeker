"use client";

import { useState } from "react";
import { addFeedback } from "@/lib/actions";
import { FEEDBACK_REASONS } from "@/db/schema";
import { Sheet } from "@/components/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";

export type Verdict = "relevant" | "irrelevant" | "maybe";

export const REASON_LABELS: Record<(typeof FEEDBACK_REASONS)[number], string> = {
  location: "Location", seniority_too_low: "Too junior", seniority_too_high: "Too senior", domain_mismatch: "Wrong domain",
  language_requirement: "Language", salary: "Salary", company: "Company", role_type: "Role type", start_date: "Start date",
  visa: "Visa", already_applied: "Already applied", other: "Other",
};

export const VERDICT_COPY: Record<Verdict, { title: string; sub: string; confirm: string }> = {
  relevant: { title: "Shortlist this role?", sub: "It moves to Shortlisted. Reasons are optional but teach your assistant what to look for.", confirm: "Shortlist" },
  maybe: { title: "Save for later?", sub: "It stays in Sourced without asking again.", confirm: "Save" },
  irrelevant: { title: "Pass on this role?", sub: "Pick what put you off so tomorrow’s search skips it.", confirm: "Pass" },
};

export function FeedbackSheet({ jobId, verdict, onClose, onDone }: { jobId: string; verdict: Verdict | null; onClose: () => void; onDone?: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const copy = verdict ? VERDICT_COPY[verdict] : null;

  async function submit(form: FormData) {
    setPending(true); setError("");
    try {
      await addFeedback(form);
      onDone?.();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not save. Please retry.");
    } finally {
      setPending(false);
    }
  }

  return <Sheet open={Boolean(verdict)} onClose={onClose} title={copy?.title ?? ""} subtitle={copy?.sub} initialFocus='input[type="checkbox"]'>
    {verdict && <form action={submit}>
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="verdict" value={verdict} />
      <div className="cluster">{FEEDBACK_REASONS.map((reason) => <label className="chip-toggle" key={reason}><input type="checkbox" name="reasons" value={reason} /><span>{REASON_LABELS[reason]}</span></label>)}</div>
      <label className="label" htmlFor="feedback-note" style={{ marginTop: 14 }}>Note <span className="opt">optional</span></label>
      <Textarea id="feedback-note" name="note" placeholder="Anything your assistant should know" style={{ minHeight: 72 }} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="sheet-actions"><Button className="btn-secondary" type="button" onClick={onClose}>Cancel</Button><Button className={verdict === "irrelevant" ? "btn-night" : "btn-primary"} disabled={pending}>{pending ? "Saving…" : copy?.confirm}</Button></div>
    </form>}
  </Sheet>;
}
