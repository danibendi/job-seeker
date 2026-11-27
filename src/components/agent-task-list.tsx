import Link from "next/link";
import { AlertTriangle, Clock3, ListChecks } from "lucide-react";
import { SaveForm } from "@/components/save-form";
import { Markdown } from "@/components/markdown";
import { Select } from "@/components/ui/input";
import { controlAgentTask, resumeWorker } from "@/lib/actions";
import { isSupersededAgentTaskCheckpoint } from "@/lib/agent-task-contract";
import { isPartialSearchResult, type AgentTaskRecord, type AgentWorkerPauseRecord } from "@/lib/agent-tasks";
import { isInterruptedTask } from "@/lib/assistant-status";
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

function executorName(executor: string) {
  return executor === "unassigned" ? "No executor chosen" : executor === "api" ? "API worker" : executor === "codex" ? "Codex" : "Hermes";
}

const PAUSE_REASONS: Record<string, string> = {
  usage_limit: "Subscription usage limit reached",
  login_required: "Sign-in missing or expired",
};

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Bounded run facts recorded by trusted worker code, never model output. */
function workerRunSummary(task: AgentTaskRecord) {
  const run = record(task.result?.worker_run) ?? record(task.checkpoint.worker_run);
  if (!run) return null;
  const usage = record(run.usage) ?? {};
  const tokens = count(usage.input_tokens) + count(usage.output_tokens);
  const parts = [
    typeof run.codex_cli_version === "string" ? `${executorName(String(run.executor ?? task.executor))} ${run.codex_cli_version}` : executorName(String(run.executor ?? task.executor)),
    typeof run.model === "string" ? run.model : null,
    typeof run.reasoning_effort === "string" ? `${run.reasoning_effort} effort` : null,
    typeof run.elapsed_seconds === "number" ? `${Math.round(run.elapsed_seconds)} s` : null,
    tokens ? `${tokens.toLocaleString("en-GB")} tokens` : null,
    typeof run.failure_category === "string" ? `stopped: ${humanize(run.failure_category)}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function WorkerPauses({ pauses, timeZone, heldExecutors = [], registeredExecutors }: { pauses: AgentWorkerPauseRecord[]; timeZone: string; heldExecutors?: string[]; registeredExecutors?: string[] }) {
  if (!pauses.length) return null;
  return <>{pauses.map((pause) => <article className="card card-pad stack" key={pause.workerId} style={{ gap: 8 }}>
    <div className="between"><div style={{ minWidth: 0 }}><strong>{executorName(pause.executor)} worker</strong><div className="tiny muted truncate">{pause.workerId}</div></div><span className="pill warn">Paused</span></div>
    <ul className="bullets">
      <li className="bullet minus"><span className="mark"><AlertTriangle aria-hidden /></span><span>{PAUSE_REASONS[pause.reason] ?? humanize(pause.reason)} · {formatShortDate(pause.pausedAt, timeZone)} {formatTime(pause.pausedAt, timeZone)}</span></li>
      <li className="bullet neutral"><span className="mark"><Clock3 aria-hidden /></span><span>{heldExecutors.includes(pause.executor) ? "Queued tasks wait" : registeredExecutors && !registeredExecutors.includes(pause.executor) ? `No ${executorName(pause.executor)} worker is registered` : `Other ${executorName(pause.executor)} workers keep working`}</span></li>
      {pause.taskId && <li className="bullet neutral"><span className="mark"><ListChecks aria-hidden /></span><a className="link" href={`#task-${pause.taskId}`}>Held task</a></li>}
    </ul>
    <div><SaveForm action={resumeWorker} label="Resume worker" pendingLabel="Resuming…" buttonClass="btn-secondary btn-sm" buttonAriaLabel={`Resume worker ${pause.workerId}`}><input type="hidden" name="workerId" value={pause.workerId} /></SaveForm></div>
  </article>)}</>;
}

export function AgentTaskList({ tasks, timeZone, workerPauses = [], heldExecutors = [], offlineSiblingExecutors = [], registeredExecutors, dismissedRequestIds = [], interruptedTaskIds }: { tasks: AgentTaskRecord[]; timeZone: string; workerPauses?: AgentWorkerPauseRecord[]; heldExecutors?: string[]; offlineSiblingExecutors?: string[]; registeredExecutors?: string[]; dismissedRequestIds?: readonly string[]; interruptedTaskIds?: readonly string[] }) {
  const dismissed = new Set(dismissedRequestIds);
  const interruptedIds = interruptedTaskIds ? new Set(interruptedTaskIds) : null;
  // Group evaluation children once; the list can hold the whole owner-action backlog.
  const evaluationsByParent = new Map<string, AgentTaskRecord[]>();
  for (const child of tasks) {
    if (child.kind !== "linkedin_evaluate" || !child.parentTaskId) continue;
    evaluationsByParent.set(child.parentTaskId, [...(evaluationsByParent.get(child.parentTaskId) ?? []), child]);
  }
  return <div className="stack"><WorkerPauses pauses={workerPauses} timeZone={timeZone} heldExecutors={heldExecutors} registeredExecutors={registeredExecutors} />{tasks.length === 0 && <div className="card card-pad">No tasks yet. Use “Search now” or ask a question.</div>}{tasks.map((task) => {
    const active = ["queued", "running", "waiting_for_user"].includes(task.status);
    const interrupted = interruptedIds ? interruptedIds.has(task.id) : isInterruptedTask(task);
    const superseded = isSupersededAgentTaskCheckpoint(task.checkpoint, task.id);
    const requestDismissed = task.requestId !== null && dismissed.has(task.requestId);
    const message = typeof task.checkpoint.message === "string" ? task.checkpoint.message : null;
    const summary = typeof task.result?.summary === "string" ? task.result.summary : null;
    const children = evaluationsByParent.get(task.id) ?? [];
    const continuing = record(task.result?.linkedin_continuation)?.resume === true;
    const phase = record(task.result?.linkedin_coverage)?.phase;
    const partial = task.kind === "search" && task.status === "succeeded" && isPartialSearchResult(task.result);
    const coverage = coverageSummary(task);
    const runSummary = workerRunSummary(task);
    const pillTone = task.status === "failed" ? "bad" : interrupted || partial ? "warn" : task.status === "succeeded" ? "good" : "outline";
    const pillLabel = interrupted ? "Interrupted" : partial ? "Partial" : humanize(task.status);
    return <article className="card card-pad stack" id={`task-${task.id}`} key={task.id} style={{ gap: 10 }}>
      <div className="between"><strong>{task.kind === "search" ? "Job search" : task.kind === "linkedin_evaluate" ? "LinkedIn evaluation" : "Question"}</strong><span className={`pill ${pillTone}`}>{pillLabel}</span></div>
      <div className="small muted">{executorName(task.executor)} · {formatShortDate(task.createdAt, timeZone)} {formatTime(task.createdAt, timeZone)} · Attempt {task.attemptCount}/{task.maxAttempts}</div>
      {(phase === "bootstrap_30d" || phase === "daily_1d") && <p className="small">{phase === "bootstrap_30d" ? "LinkedIn initial search: past 30 days." : "LinkedIn daily search: past day."}{continuing && " Continuing from the saved position in the next task."}</p>}
      {interrupted && <p className="small">{task.attemptCount >= task.maxAttempts ? `The ${executorName(task.executor)} worker stopped during this task on its final attempt.` : `The ${executorName(task.executor)} worker stopped during this task. It runs again when the worker is back.`}</p>}
      {task.status === "queued" && <p className="small">{task.executor === "unassigned" ? "Choose an executor below to let its worker pick this up." : heldExecutors.includes(task.executor) ? (offlineSiblingExecutors.includes(task.executor) ? `Waiting until the paused ${executorName(task.executor)} worker is resumed or another ${executorName(task.executor)} worker comes back online.` : `Waiting until the paused ${executorName(task.executor)} worker is resumed.`) : `Waiting for the ${executorName(task.executor)} worker.`}</p>}
      {task.status === "waiting_for_user" && <p className="small">Needs your attention. Resolve the issue, then retry.</p>}
      {requestDismissed && <p className="small muted">Request dismissed</p>}
      {message && <p className="small">{message}</p>}
      {task.lastError && <p className="error small">{task.lastError}</p>}
      {children.length > 0 && <div className="small">{children.filter((child) => ["queued", "running", "waiting_for_user"].includes(child.status)).length} evaluations pending · {children.filter((child) => child.status === "succeeded").length} complete · {children.filter((child) => ["failed", "cancelled"].includes(child.status)).length} failed or cancelled</div>}
      {partial && <div className="notice warn small"><strong>{hasIncompleteLinkedinCoverage(task) ? "LinkedIn coverage is incomplete." : "Search coverage is incomplete."}</strong>{coverage.map((line) => <div key={line}>{line}</div>)}</div>}
      {summary && <Markdown className="reader small" content={summary} />}
      {task.parentTaskId && <Link className="small link" href={`/activity?tab=tasks#task-${task.parentTaskId}`}>Parent search</Link>}
      <details><summary className="small muted">Run details</summary><div className="small muted" style={{ overflowWrap: "anywhere" }}>Task {task.id}{task.claimedBy && <><br />Worker {task.claimedBy}</>}{task.leaseExpiresAt && task.status === "running" && !interrupted && <><br />Lease until {formatTime(task.leaseExpiresAt, timeZone)}</>}{task.externalRef && <><br />External run {task.externalRef}</>}{runSummary && <><br />{runSummary}</>}</div></details>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "start" }}>
        {task.status === "queued" && <SaveForm action={controlAgentTask} label="Assign" pendingLabel="Assigning…" buttonClass="btn-ghost btn-sm"><input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="operation" value="assign" /><label className="sr-only" htmlFor={`executor-${task.id}`}>Executor</label><Select name="executor" id={`executor-${task.id}`} defaultValue={task.executor === "unassigned" ? "api" : task.executor}><option value="api">Direct API</option><option value="hermes">Hermes</option><option value="codex">Codex</option></Select></SaveForm>}
        {active && <SaveForm action={controlAgentTask} label="Cancel" pendingLabel="Cancelling…" buttonClass="btn-ghost btn-sm"><input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="operation" value="cancel" /></SaveForm>}
        {["failed", "waiting_for_user", "cancelled"].includes(task.status) && !superseded && !requestDismissed && <SaveForm action={controlAgentTask} label="Retry" pendingLabel="Queuing…" buttonClass="btn-ghost btn-sm"><input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="operation" value="retry" /></SaveForm>}
      </div>
    </article>;
  })}</div>;
}
