"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, CalendarPlus, FileText, RotateCcw, Sparkles } from "lucide-react";
import { addInterview, createRequest, moveJob, recordRejection, undoLastJobMove } from "@/lib/actions";
import { availableJobTransitions, JOB_STATUS_LABELS, quickAdvanceStatus } from "@/lib/job-workflow";
import { FeedbackSheet, type Verdict } from "@/components/feedback-sheet";
import { InterviewFields } from "@/components/interview-fields";
import { Sheet } from "@/components/sheet";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";

type Status = "sourced" | "to_apply" | "applied" | "screening" | "interviewing" | "offer" | "rejected" | "withdrawn" | "irrelevant" | "archived";
type Props = {
  jobId: string;
  title: string;
  company: string;
  status: Status;
  untriaged: boolean;
  canUndo: boolean;
  pendingTailoringId: string | null;
  tailoringRequested: boolean;
  rejection: { occurredAt: Date; stage: string | null; reasonCategory: string | null; reasonDetail: string | null; learningMd: string | null; responseNeeded: boolean } | null;
  timeZone?: string;
};

type SheetKind = "status" | "rejection" | "interview" | null;

export function JobActions(props: Props) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const next = quickAdvanceStatus(props.status);
  const transitions = availableJobTransitions(props.status);
  const closed = ["rejected", "withdrawn", "archived", "irrelevant"].includes(props.status);
  const close = () => setSheet(null);

  return <>
    {props.untriaged ? <div className="btn-row">
      <Button className="btn-primary" type="button" onClick={() => setVerdict("relevant")}>Shortlist</Button>
      <Button className="btn-ghost" type="button" onClick={() => setVerdict("maybe")}>Later</Button>
      <Button className="btn-secondary" type="button" onClick={() => setVerdict("irrelevant")}>Pass</Button>
    </div> : <div className="btn-row">
      {next && <form action={moveJob}><input type="hidden" name="jobId" value={props.jobId} /><input type="hidden" name="status" value={next} /><SubmitButton className="btn-primary" pendingLabel="Moving…"><ArrowRight aria-hidden />{JOB_STATUS_LABELS[next]}</SubmitButton></form>}
      {(transitions.length > 0 || props.canUndo) && <Button className="btn-secondary" type="button" onClick={() => setSheet("status")}>Change status</Button>}
    </div>}

    <div className="cluster" style={{ marginTop: 10 }}>
      {props.pendingTailoringId
        ? <Link className="btn btn-ghost btn-sm" href={`/cv?tailoring=${props.pendingTailoringId}`}><FileText aria-hidden />Review CV changes</Link>
        : !closed && <form action={createRequest}><input type="hidden" name="jobId" value={props.jobId} /><input type="hidden" name="text" value={`Tailor my CV for ${props.title} at ${props.company}`} /><SubmitButton className="btn-ghost btn-sm" pendingLabel="Asking assistant…" disabled={props.tailoringRequested}><Sparkles aria-hidden />{props.tailoringRequested ? "CV tailoring in progress" : "Tailor my CV"}</SubmitButton></form>}
      {!closed && !props.untriaged && <Button className="btn-ghost btn-sm" type="button" onClick={() => setSheet("interview")}><CalendarPlus aria-hidden />Add interview</Button>}
    </div>

    <FeedbackSheet jobId={props.jobId} verdict={verdict} onClose={() => setVerdict(null)} />

    <Sheet open={sheet === "status"} onClose={close} title="Change status" subtitle={`Now: ${JOB_STATUS_LABELS[props.status]}`} initialFocus="select">
      {transitions.length > 0 && <form action={async (form) => { await moveJob(form); close(); }}>
        <input type="hidden" name="jobId" value={props.jobId} />
        <label className="label" htmlFor="status-select">Move to</label>
        <Select id="status-select" name="status" defaultValue={next ?? transitions[0]}>{transitions.map((status) => <option value={status} key={status}>{JOB_STATUS_LABELS[status]}</option>)}</Select>
        <label className="label" htmlFor="status-note" style={{ marginTop: 12 }}>Note <span className="opt">optional</span></label>
        <Textarea id="status-note" name="note" placeholder="What changed?" style={{ minHeight: 64 }} />
        <div className="sheet-actions"><Button className="btn-secondary" type="button" onClick={close}>Cancel</Button><SubmitButton className="btn-primary" pendingLabel="Moving…">Move</SubmitButton></div>
      </form>}
      <div className="cluster" style={{ marginTop: 16, justifyContent: "space-between" }}>
        {props.canUndo && <form action={async (form) => { await undoLastJobMove(form); close(); }}><input type="hidden" name="jobId" value={props.jobId} /><SubmitButton className="btn-ghost btn-sm" pendingLabel="Undoing…"><RotateCcw aria-hidden />Undo last move</SubmitButton></form>}
        {props.status !== "rejected" && props.status !== "archived" && <Button className="btn-ghost btn-sm" type="button" onClick={() => setSheet("rejection")}>Record a rejection</Button>}
        {props.status === "rejected" && <Button className="btn-ghost btn-sm" type="button" onClick={() => setSheet("rejection")}>Edit rejection details</Button>}
      </div>
    </Sheet>

    <Sheet open={sheet === "rejection"} onClose={close} title={props.rejection ? "Rejection details" : "Record a rejection"} subtitle="Moves the role to Rejected. Your assistant learns from the reason." initialFocus="input[type='date']">
      <form action={async (form) => { await recordRejection(form); close(); }} className="field-group">
        <input type="hidden" name="jobId" value={props.jobId} />
        <div className="field-grid">
          <div><label className="label" htmlFor="rej-date">Date</label><Input id="rej-date" type="date" name="occurredAt" required defaultValue={(props.rejection?.occurredAt ?? new Date()).toISOString().slice(0, 10)} /></div>
          <div><label className="label" htmlFor="rej-stage">Stage</label><Select id="rej-stage" name="stage" defaultValue={props.rejection?.stage ?? props.status}><option value="application">Application</option><option value="screening">Recruiter screening</option><option value="interviewing">Interview</option><option value="final">Final round</option><option value="offer">Offer</option></Select></div>
          <div className="wide"><label className="label" htmlFor="rej-reason">Reason given</label><Select id="rej-reason" name="reasonCategory" defaultValue={props.rejection?.reasonCategory ?? ""}><option value="">Not given</option><option value="experience">Experience / seniority</option><option value="skills">Skills match</option><option value="location">Location / work mode</option><option value="compensation">Compensation</option><option value="internal_candidate">Internal candidate</option><option value="role_closed">Role closed</option><option value="other">Other</option></Select></div>
          <div className="wide"><label className="label" htmlFor="rej-detail">What they said <span className="opt">optional</span></label><Textarea id="rej-detail" name="reasonDetail" defaultValue={props.rejection?.reasonDetail ?? ""} style={{ minHeight: 64 }} /></div>
          <div className="wide"><label className="label" htmlFor="rej-learn">Lesson <span className="opt">optional</span></label><Textarea id="rej-learn" name="learningMd" defaultValue={props.rejection?.learningMd ?? ""} style={{ minHeight: 64 }} /></div>
        </div>
        <label className="check"><input type="checkbox" name="responseNeeded" defaultChecked={props.rejection?.responseNeeded} /><span className="small">I want to reply (the assistant drafts, never sends)</span></label>
        <div className="sheet-actions"><Button className="btn-secondary" type="button" onClick={close}>Cancel</Button><SubmitButton className="btn-primary" pendingLabel="Saving…">{props.rejection ? "Update" : "Record"}</SubmitButton></div>
      </form>
    </Sheet>

    <Sheet open={sheet === "interview"} onClose={close} title="Add interview" subtitle="Your assistant can prepare a brief once it is scheduled." initialFocus="select">
      <form action={addInterview}>
        <input type="hidden" name="jobId" value={props.jobId} />
        <InterviewFields idPrefix="job-interview" defaultTimeZone={props.timeZone} />
        <div className="sheet-actions"><Button className="btn-secondary" type="button" onClick={close}>Cancel</Button><SubmitButton className="btn-primary" pendingLabel="Creating…">Create</SubmitButton></div>
      </form>
    </Sheet>
  </>;
}
