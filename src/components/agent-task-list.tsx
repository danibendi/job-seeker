import Link from "next/link";
import { SaveForm } from "@/components/save-form";
import { Markdown } from "@/components/markdown";
import { Select } from "@/components/ui/input";
import { controlAgentTask } from "@/lib/actions";
import { isSupersededAgentTaskCheckpoint } from "@/lib/agent-task-contract";
import { isPartialSearchResult, type AgentTaskRecord } from "@/lib/agent-tasks";
import { formatShortDate, formatTime, humanize } from "@/lib/format";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonnegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function trackCoverage(label: string, value: unknown) {
  const track = record(value);
  if (!track) return null;
  const lanes = Array.isArray(track.lanes) ? track.lanes.map(record).filter((lane) => lane !== null) : [];
  const touched = lanes.filter((lane) => lane.touched_in_run === true).length;
  const untouched = lanes.length - touched;
  const pending = nonnegativeInteger(track.pending_detail_count);
  const backlog = nonnegativeInteger(track.backlog_pending_detail_count);
  return `${label}: ${touched}/${lanes.length} lanes touched · ${untouched} untouched · ${pending} details pending${backlog ? ` · ${backlog} earlier pending` : ""}`;
}

function coverageSummary(task: AgentTaskRecord) {
  const coverage = record(task.result?.linkedin_coverage);
  if (!coverage || coverage.complete !== false) return [];
  if (coverage.phase === "bootstrap_30d") return [trackCoverage("Initial 30 days", coverage.backfill)].filter((line): line is string => Boolean(line));
  if (coverage.phase === "daily_1d") return [trackCoverage("Past day", coverage.fresh)].filter((line): line is string => Boolean(line));
  return [trackCoverage("Fresh", coverage.fresh), trackCoverage("Backfill", coverage.backfill)].filter((line): line is string => Boolean(line));
}

function hasIncompleteLinkedinCoverage(task: AgentTaskRecord) {
  return record(task.result?.linkedin_coverage)?.complete === false;
}

export function AgentTaskList({ tasks, timeZone }: { tasks: AgentTaskRecord[]; timeZone: string }) {
  return <div className="stack">{tasks.length === 0 && <div className="card card-pad">No tasks yet. Use “Search now” or ask a question.</div>}{tasks.map((task) => {
    const active = ["queued", "running", "waiting_for_user"].includes(task.status);
    const superseded = isSupersededAgentTaskCheckpoint(task.checkpoint, task.id);
    const message = typeof task.checkpoint.message === "string" ? task.checkpoint.message : null;
    const summary = typeof task.result?.summary === "string" ? task.result.summary : null;
    const children = tasks.filter((child) => child.parentTaskId === task.id && child.kind === "linkedin_evaluate");
    const continuing = record(task.result?.linkedin_continuation)?.resume === true;
    const phase = record(task.result?.linkedin_coverage)?.phase;
    const partial = task.kind === "search" && task.status === "succeeded" && isPartialSearchResult(task.result);
    const coverage = coverageSummary(task);
    return <article className="card card-pad stack" id={`task-${task.id}`} key={task.id} style={{ gap: 10 }}>
      <div className="between"><strong>{task.kind === "search" ? "Job search" : task.kind === "linkedin_evaluate" ? "LinkedIn evaluation" : "Question"}</strong><span className={`pill ${task.status === "failed" ? "bad" : partial ? "warn" : task.status === "succeeded" ? "good" : "outline"}`}>{partial ? "Partial" : humanize(task.status)}</span></div>
      <div className="small muted">{task.executor === "unassigned" ? "No executor chosen" : task.executor === "api" ? "API worker" : task.executor === "codex" ? "Codex" : "Hermes"} · {formatShortDate(task.createdAt, timeZone)} {formatTime(task.createdAt, timeZone)} · Attempt {task.attemptCount}/{task.maxAttempts}</div>
      {(phase === "bootstrap_30d" || phase === "daily_1d") && <p className="small">{phase === "bootstrap_30d" ? "LinkedIn initial search: past 30 days." : "LinkedIn daily search: past day."}{continuing && " Continuing from the saved position in the next task."}</p>}
      {task.status === "queued" && <p className="small">{task.executor === "unassigned" ? "Choose an executor below to let its worker pick this up." : "Waiting for a connected worker. The app does not launch an agent by itself."}</p>}
      {task.status === "waiting_for_user" && <p className="small">Needs your attention. Resolve the issue, then retry.</p>}
      {message && <p className="small">{message}</p>}
      {task.lastError && <p className="error small">{task.lastError}</p>}
      {children.length > 0 && <div className="small">{children.filter((child) => ["queued", "running", "waiting_for_user"].includes(child.status)).length} evaluations pending · {children.filter((child) => child.status === "succeeded").length} complete · {children.filter((child) => ["failed", "cancelled"].includes(child.status)).length} failed or cancelled</div>}
      {partial && <div className="notice warn small"><strong>{hasIncompleteLinkedinCoverage(task) ? "LinkedIn coverage is incomplete." : "Search coverage is incomplete."}</strong>{coverage.map((line) => <div key={line}>{line}</div>)}</div>}
      {summary && <Markdown className="reader small" content={summary} />}
      {task.parentTaskId && <Link className="small link" href={`/activity?tab=tasks#task-${task.parentTaskId}`}>Parent search</Link>}
      <details><summary className="small muted">Run details</summary><div className="small muted" style={{ overflowWrap: "anywhere" }}>Task {task.id}{task.claimedBy && <><br />Worker {task.claimedBy}</>}{task.leaseExpiresAt && task.status === "running" && <><br />Lease until {formatTime(task.leaseExpiresAt, timeZone)}</>}{task.externalRef && <><br />External run {task.externalRef}</>}</div></details>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "start" }}>
        {task.status === "queued" && <SaveForm action={controlAgentTask} label="Assign" pendingLabel="Assigning…" buttonClass="btn-ghost btn-sm"><input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="operation" value="assign" /><label className="sr-only" htmlFor={`executor-${task.id}`}>Executor</label><Select name="executor" id={`executor-${task.id}`} defaultValue={task.executor === "unassigned" ? "api" : task.executor}><option value="api">Direct API</option><option value="hermes">Hermes</option><option value="codex">Codex</option></Select></SaveForm>}
        {active && <SaveForm action={controlAgentTask} label="Cancel" pendingLabel="Cancelling…" buttonClass="btn-ghost btn-sm"><input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="operation" value="cancel" /></SaveForm>}
        {["failed", "waiting_for_user", "cancelled"].includes(task.status) && !superseded && <SaveForm action={controlAgentTask} label="Retry" pendingLabel="Queuing…" buttonClass="btn-ghost btn-sm"><input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="operation" value="retry" /></SaveForm>}
      </div>
    </article>;
  })}</div>;
}
