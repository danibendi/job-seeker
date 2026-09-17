import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Bot, CheckCircle2, Clock3, FileText, LoaderCircle, MessageCircle, Search, Settings2, ThumbsUp } from "lucide-react";
import { AgentTaskList } from "@/components/agent-task-list";
import { TaskRefresh } from "@/components/task-refresh";
import { AppBar } from "@/components/app-bar";
import { AskAssistant } from "@/components/ask-assistant";
import { Disclosure } from "@/components/disclosure";
import { EmptyState } from "@/components/empty-state";
import { Markdown } from "@/components/markdown";
import { SearchNow } from "@/components/search-now";
import { SubmitButton } from "@/components/submit-button";
import { retryRequest } from "@/lib/actions";
import { getActivityData } from "@/lib/data";
import { formatDate, formatShortDate, formatTime, humanize } from "@/lib/format";
import { scheduleSummary } from "@/lib/settings";

export const metadata: Metadata = { title: "Agent activity" };
export const dynamic = "force-dynamic";

const TABS = [
  { id: "tasks", label: "Tasks" },
  { id: "timeline", label: "Timeline" },
  { id: "runs", label: "Searches" },
  { id: "requests", label: "Requests" },
] as const;

function iconFor(type: string, actor: string) {
  if (/fail|error|warning|conflict|unavailable/.test(type)) return { Icon: AlertTriangle, tone: "warn" };
  if (/discovered|search/.test(type)) return { Icon: Search, tone: "brand" };
  if (/status/.test(type)) return { Icon: ArrowRight, tone: "" };
  if (/feedback/.test(type)) return { Icon: ThumbsUp, tone: "good" };
  if (/request/.test(type)) return { Icon: MessageCircle, tone: "brand" };
  if (/cv|tailoring/.test(type)) return { Icon: FileText, tone: "" };
  if (/settings|notification/.test(type)) return { Icon: Settings2, tone: "" };
  return { Icon: actor === "assistant" ? Bot : ThumbsUp, tone: "" };
}

function RunIcon({ status }: { status: string }) {
  const tone = status === "failed" ? "bad" : status === "succeeded" ? "good" : status === "running" ? "brand" : "";
  const Icon = status === "failed" ? AlertTriangle : status === "succeeded" ? CheckCircle2 : status === "running" ? LoaderCircle : Clock3;
  return <span className={`timeline-icon ${tone}`}><Icon aria-hidden /></span>;
}

export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const requestedTab = (await searchParams).tab;
  const tab = TABS.some((option) => option.id === requestedTab) ? requestedTab! : "timeline";
  const data = await getActivityData();
  const { timeZone } = data;
  const waiting = data.requests.filter(({ request }) => request.status === "open" || request.status === "in_progress").length;
  const searchQueued = data.requests.some(({ request }) => ["search_now", "scheduled_search"].includes(request.purpose) && (request.status === "open" || request.status === "in_progress"));
  const dayOf = (date: Date) => new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(date);
  const grouped = new Map<string, typeof data.events>();
  for (const event of data.events) { const key = dayOf(event.entry.createdAt); grouped.set(key, [...(grouped.get(key) ?? []), event]); }

  return <>
    <TaskRefresh active={data.tasks.some((task) => task.status === "running" || (task.status === "queued" && task.executor !== "unassigned"))} />
    <AppBar title="Agent activity" back="/more" actions={<SearchNow queued={searchQueued} />} />
    <div className="stat-grid" style={{ marginBottom: 14 }}>
      <div className="stat"><div className="value" style={{ fontSize: 18 }}>{data.lastSearchStartedAt ? formatShortDate(data.lastSearchStartedAt, timeZone) : "—"}</div><div className="label">Last search</div></div>
      <Link className="stat" href="/settings?tab=schedule"><div className="value" style={{ fontSize: 18 }}>{data.settings.schedule.enabled ? data.settings.schedule.time : "Paused"}</div><div className="label truncate">{data.settings.schedule.enabled ? scheduleSummary(data.settings.schedule, timeZone).split(" · ")[0] : "Schedule"}</div></Link>
      <div className="stat"><div className="value">{waiting}</div><div className="label">Waiting on agents</div></div>
    </div>
    <div className="scroller" role="tablist" aria-label="View" style={{ marginBottom: 10 }}>{TABS.map((option) => <Link key={option.id} role="tab" aria-selected={tab === option.id} className={`seg ${tab === option.id ? "active" : ""}`} href={`/activity?tab=${option.id}`}>{option.label}</Link>)}</div>

    {tab === "tasks" && <AgentTaskList tasks={data.tasks} timeZone={timeZone} />}

    {tab === "timeline" && (grouped.size ? <div className="card card-pad">{[...grouped.entries()].map(([day, events]) => <div key={day}>
      <div className="overline timeline-day">{day}</div>
      <div className="timeline">{events.map(({ entry, job }) => { const { Icon, tone } = iconFor(entry.type, entry.actor); return <div className="timeline-item" key={entry.id}>
        <span className={`timeline-icon ${tone}`}><Icon aria-hidden /></span>
        <div><div className="timeline-text">{entry.message}{job && <> <Link href={`/jobs/${job.id}`}>Open</Link></>}</div><div className="timeline-sub">{entry.actor === "assistant" ? "Assistant" : entry.actor === "system" ? "System" : "You"} · {humanize(entry.type)}</div></div>
        <div className="timeline-time">{formatTime(entry.createdAt, timeZone)}</div>
      </div>; })}</div>
    </div>)}</div> : <EmptyState title="Nothing logged yet" />)}

    {tab === "runs" && (data.runs.length ? <div className="stack" style={{ gap: 8 }}>{data.runs.map((run) => {
      const counts = run.jobsFound || run.jobsAnalyzed ? `${run.jobsFound} found · ${run.jobsAnalyzed} scored` : null;
      const summary = run.summaryMd || run.errorMd;
      const head = <div className="run-row">
        <RunIcon status={run.status} />
        <span style={{ minWidth: 0 }}>
          <span className="title truncate" style={{ display: "block", fontWeight: 650, fontSize: 14 }}>{humanize(run.workflow)}{counts && <span className="faint" style={{ fontWeight: 500 }}> · {counts}</span>}</span>
          <span className="meta" style={{ display: "block", color: "var(--ink-3)", fontSize: 12 }}>{formatDate(run.startedAt)} {formatTime(run.startedAt, timeZone)} · {humanize(run.status)}</span>
        </span>
        {run.status === "failed" ? <span className="pill bad">Failed</span> : run.status === "running" ? <span className="pill brand">Running</span> : null}
      </div>;
      return summary
        ? <details className="card" key={run.id} style={{ overflow: "hidden" }}><summary style={{ listStyle: "none", cursor: "pointer" }}>{head}</summary><div className="run-summary">{run.errorMd && <p className="error" style={{ marginTop: 0, marginBottom: run.summaryMd ? 10 : 0 }}>{run.errorMd}</p>}{run.summaryMd && <Markdown className="reader" content={run.summaryMd} />}</div></details>
        : <div className="card" key={run.id}>{head}</div>;
    })}</div> : <EmptyState title="No searches recorded yet" />)}

    {tab === "requests" && <>
      <div className="card card-pad" style={{ marginBottom: 12 }}>
        <AskAssistant suggestions={["What did you find this week?", "Which roles should I prioritise today?", "Which agencies should I contact first?"]} placeholder="Ask about the search" />
      </div>
      {data.requests.length ? <div className="card"><div className="list">{data.requests.map(({ request, job }) => <div className="row plain" key={request.id} style={{ alignItems: "start" }}>
        <div style={{ minWidth: 0 }}>
          <div className="title">{request.text}</div>
          <div className="meta">{formatShortDate(request.createdAt)} · {request.status === "answered" ? "Answered" : request.status === "failed" ? "Failed" : request.status === "in_progress" ? "In progress" : "Waiting"}{request.purpose === "search_now" && " · Search"}{job && <> · <Link className="link" href={`/jobs/${job.id}`}>{job.title}</Link></>}</div>
          {request.status === "answered" && request.responseMd && <Disclosure quiet title={<span className="small">Answer</span>}><Markdown className="reader" content={request.responseMd} /></Disclosure>}
          {request.status === "failed" && request.errorMd && <p className="error tiny">{request.errorMd}</p>}
        </div>
        {request.status === "failed" && <form action={retryRequest}><input type="hidden" name="requestId" value={request.id} /><SubmitButton className="btn-ghost btn-sm" pendingLabel="…">Retry</SubmitButton></form>}
      </div>)}</div></div> : <EmptyState title="No requests yet" />}
    </>}
  </>;
}
