import Link from "next/link";
import { Check, ChevronRight, ExternalLink, Minus } from "lucide-react";
import { AppBar } from "@/components/app-bar";
import { AskAssistant } from "@/components/ask-assistant";
import { Disclosure } from "@/components/disclosure";
import { JobActions } from "@/components/job-actions";
import { Markdown } from "@/components/markdown";
import { QaList } from "@/components/qa-list";
import { Score } from "@/components/score";
import { SubmitButton } from "@/components/submit-button";
import { Textarea } from "@/components/ui/input";
import { addNote } from "@/lib/actions";
import type { getJobDetail } from "@/lib/data";
import { daysAgo, fitBand, formatDate, formatShortDate, formatTime, formatWeekday, humanize, initials, scoreTone, shortSource, workModeLabel } from "@/lib/format";
import { JOB_STATUS_LABELS } from "@/lib/job-workflow";

type Detail = NonNullable<Awaited<ReturnType<typeof getJobDetail>>>;
const steps = ["sourced", "to_apply", "applied", "screening", "interviewing", "offer"] as const;

export function JobView({ data, timeZone }: { data: Detail; timeZone?: string }) {
  const { job, company } = data;
  const factors = [...(job.fitFactors ?? [])];
  const positives = factors.filter((factor) => factor.direction === "+").sort((a, b) => b.weight - a.weight);
  const concerns = factors.filter((factor) => factor.direction === "-").sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const stepIndex = steps.indexOf(job.status as (typeof steps)[number]);
  const pendingTailoring = data.tailorings.find((item) => item.tailoring.status === "proposed");
  const tailoringRequested = data.requests.some((request) => ["open", "in_progress"].includes(request.status) && /tailor/i.test(request.text));
  const latestMove = data.history[0];
  const canUndo = Boolean(latestMove?.fromStatus && latestMove.toStatus === job.status);
  const tone = scoreTone(job.fitScore);
  const facts = [
    { k: "Location", v: job.location },
    { k: "Work mode", v: workModeLabel(job.workMode) },
    { k: "Salary", v: job.salaryText },
    { k: "Posted", v: job.postedAt ? formatDate(job.postedAt) : null },
    { k: "Found", v: `${formatDate(job.discoveredAt)} · ${shortSource(job.source)}` },
    { k: "Best CV", v: data.cv?.name ?? null },
  ].filter((fact) => fact.v);
  const timeline = [
    ...data.history.map((item) => ({ id: item.id, date: item.createdAt, text: `${item.actor === "assistant" ? "Assistant moved" : "Moved"} to ${JOB_STATUS_LABELS[item.toStatus]}${item.note ? ` · ${item.note}` : ""}` })),
    ...data.activity.filter((item) => item.type !== "status_changed" && item.type !== "request_created").map((item) => ({ id: item.id, date: item.createdAt, text: item.type === "note_added" ? String(item.payload?.note ?? item.message) : item.message })),
  ].sort((a, b) => +new Date(b.date) - +new Date(a.date));
  const suggestions = [
    "Which of my CV variants fits this best, and why?",
    `What is ${company.name} like to work for?`,
    "Is the seniority right for me?",
    "What would you put in a short cover letter?",
    "Draft a two-line follow-up message",
  ];

  return <>
    <AppBar title={company.name} back="/pipeline" actions={<a className="icon-btn" href={job.url} target="_blank" rel="noreferrer" aria-label="Open original posting"><ExternalLink aria-hidden /></a>} />

    <section className="card card-pad">
      <div className="triage-head">
        <span className="monogram lg night" aria-hidden>{initials(company.name)}</span>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 21, lineHeight: 1.15 }}>{job.title}</h1>
          <div className="muted small" style={{ marginTop: 3 }}>{company.name}{job.location ? ` · ${job.location}` : ""}</div>
        </div>
        <Score value={job.fitScore} size="lg" />
      </div>
      <div className="cluster" style={{ marginTop: 12 }}>
        <span className={`pill ${["rejected", "withdrawn", "archived", "irrelevant"].includes(job.status) ? "" : job.status === "offer" ? "good" : "brand"}`}>{JOB_STATUS_LABELS[job.status]}</span>
        {job.fitScore != null && <span className={`pill ${tone === "low" ? "" : tone}`}>{fitBand(job.fitScore)}</span>}
        {job.workMode && <span className="pill outline">{workModeLabel(job.workMode)}</span>}
        {company.tier === "a" && <span className="pill night">Priority</span>}
        {job.analysisStatus !== "complete" && <span className="pill warn">{job.analysisStatus === "failed" ? "Analysis failed" : "Analysis pending"}</span>}
      </div>
      {stepIndex >= 0 && <div className="status-steps" style={{ marginTop: 14 }} aria-label={`Stage ${stepIndex + 1} of ${steps.length}`}>{steps.map((step, index) => <i key={step} className={index < stepIndex ? "done" : index === stepIndex ? "current" : ""} />)}</div>}
      <div style={{ marginTop: 14 }}>
        <JobActions jobId={job.id} title={job.title} company={company.name} status={job.status} untriaged={!job.triagedAt && job.status === "sourced"} canUndo={canUndo} pendingTailoringId={pendingTailoring?.tailoring.id ?? null} tailoringRequested={tailoringRequested} rejection={data.rejection} timeZone={timeZone} />
      </div>
    </section>

    {(positives.length > 0 || concerns.length > 0) && <section className="section">
      <div className="grid-2">
        {positives.length > 0 && <div className="card card-pad"><div className="overline" style={{ marginBottom: 10 }}>Why it fits</div><ul className="bullets">{positives.map((factor) => <li className="bullet plus" key={factor.factor}><span className="mark"><Check aria-hidden /></span><span><b>{factor.factor}.</b> <span className="why">{factor.note}</span></span></li>)}</ul></div>}
        <div className="card card-pad"><div className="overline" style={{ marginBottom: 10 }}>Watch out</div>{concerns.length > 0 ? <ul className="bullets">{concerns.map((factor) => <li className="bullet minus" key={factor.factor}><span className="mark"><Minus aria-hidden /></span><span><b>{factor.factor}.</b> <span className="why">{factor.note}</span></span></li>)}</ul> : <p className="muted small">No concerns were recorded in this analysis.</p>}</div>
      </div>
    </section>}

    {facts.length > 0 && <section className="section card card-pad"><div className="facts">{facts.map((fact) => <div className="fact" key={fact.k}><div className="k">{fact.k}</div><div className="v">{fact.v}</div></div>)}</div></section>}

    <section className="section">
      <div className="section-head"><h2>Ask assistant</h2></div>
      <div className="card card-pad stack" style={{ gap: 12 }}>
        <AskAssistant jobId={job.id} suggestions={suggestions} />
        <QaList requests={data.requests.filter((request) => !/^Tailor my CV/i.test(request.text))} />
      </div>
    </section>

    <section className="section">
      <div className="section-head"><h2>Details</h2></div>
      <Disclosure title="Role description" meta={job.descriptionMd ? undefined : "not captured"}><Markdown content={job.descriptionMd} fallback="No description has been captured." /><a className="link small" href={job.url} target="_blank" rel="noreferrer">Original posting ↗</a></Disclosure>
      <Disclosure title="Full analysis" meta={job.analysisStatus !== "complete" ? humanize(job.analysisStatus) : undefined}><Markdown content={job.fitAnalysisMd} fallback={job.analysisError ?? "Not analysed yet."} /></Disclosure>
      <Disclosure title={`About ${company.name}`}><Markdown content={company.dossierMd} fallback="No company research has been saved yet. Job ingestion does not currently add company research." />{company.website && <a className="link small" href={company.website} target="_blank" rel="noreferrer">Company site ↗</a>}</Disclosure>
    </section>

    {data.interviews.length > 0 && <section className="section">
      <div className="section-head"><h2>Interviews</h2></div>
      <div className="card"><div className="list">{data.interviews.map((interview) => <Link className="row interactive" key={interview.id} href={`/interviews/${interview.id}`}>
        <span className={`pill ${interview.outcome === "passed" ? "good" : interview.outcome === "failed" ? "bad" : interview.outcome === "cancelled" ? "" : "brand"}`}>{humanize(interview.outcome)}</span>
        <span style={{ minWidth: 0 }}><span className="title truncate">{humanize(interview.stage)}</span><span className="meta">{formatWeekday(interview.scheduledAt, interview.timeZone)} · {formatTime(interview.scheduledAt, interview.timeZone)}</span></span>
        <ChevronRight className="chev" aria-hidden />
      </Link>)}</div></div>
    </section>}

    <section className="section">
      <div className="section-head"><h2>Notes</h2></div>
      <form action={addNote} className="card card-pad stack" style={{ gap: 8 }}>
        <input type="hidden" name="jobId" value={job.id} />
        <Textarea name="note" required placeholder="Add a private note" style={{ minHeight: 60 }} aria-label="Note" />
        <div><SubmitButton className="btn-ghost btn-sm" pendingLabel="Saving…">Save note</SubmitButton></div>
      </form>
      {timeline.length > 0 && <Disclosure quiet title="History" meta={`${timeline.length}`}>
        <div className="timeline">{timeline.map((item) => <div className="timeline-item" key={item.id}><span className="timeline-icon"><span className="dot" style={{ width: 6, height: 6 }} /></span><div className="timeline-text">{item.text}</div><div className="timeline-time" title={formatDate(item.date)}>{daysAgo(item.date) || formatShortDate(item.date)}</div></div>)}</div>
      </Disclosure>}
    </section>
  </>;
}
