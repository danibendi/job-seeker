"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, LayoutList, MoveRight, Search, SquareKanban } from "lucide-react";
import { moveJob } from "@/lib/actions";
import { Score } from "@/components/score";
import { Sheet } from "@/components/sheet";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/input";
import { daysAgo, initials } from "@/lib/format";
import { canReachDestination, jobDestinations, JOB_DESTINATION_LABELS, JOB_STATUS_LABELS, type JobDestination } from "@/lib/job-workflow";

type Status = "sourced" | "to_apply" | "applied" | "screening" | "interviewing" | "offer" | "rejected" | "withdrawn" | "irrelevant" | "archived";
export type PipelineItem = { job: { id: string; title: string; fitScore: number | null; status: Status; statusChangedAt: Date; location: string | null; triagedAt: Date | null }; company: { name: string } };

type Stage = { id: string; label: string; statuses: Status[]; where?: (item: PipelineItem) => boolean; targets?: JobDestination[] };
const STAGES: Stage[] = [
  { id: "active", label: "Active", statuses: ["to_apply", "applied", "screening", "interviewing", "offer"] },
  { id: "sourced", label: "To review", statuses: ["sourced"], where: (item) => !item.job.triagedAt, targets: ["sourced"] },
  { id: "later", label: "Saved for later", statuses: ["sourced"], where: (item) => Boolean(item.job.triagedAt), targets: ["later"] },
  { id: "to_apply", label: "Shortlisted", statuses: ["to_apply"], targets: ["to_apply"] },
  { id: "applied", label: "Applied", statuses: ["applied"], targets: ["applied"] },
  { id: "screening", label: "Screening", statuses: ["screening"], targets: ["screening"] },
  { id: "interviewing", label: "Interviewing", statuses: ["interviewing"], targets: ["interviewing"] },
  { id: "offer", label: "Offer", statuses: ["offer"], targets: ["offer"] },
  { id: "closed", label: "Closed", statuses: ["rejected", "withdrawn", "irrelevant"], targets: ["rejected", "withdrawn", "irrelevant"] },
];
const BOARD_STAGES = STAGES.filter((stage) => stage.id !== "active");
const MIN_OPTIONS = [0, 50, 60, 70, 80, 90];
const BOARD_PAGE = 6;

const matches = (stage: Stage, item: PipelineItem) => stage.statuses.includes(item.job.status) && (stage.where?.(item) ?? true);
const destinationsOf = (item: PipelineItem) => jobDestinations(item.job.status, Boolean(item.job.triagedAt));
/** The first destination in a column that this job is actually allowed to reach, or null when the column is not a valid drop. */
const dropTarget = (item: PipelineItem, stage: Stage) => stage.targets?.find((to) => canReachDestination(item.job.status, Boolean(item.job.triagedAt), to)) ?? null;
const currentLabel = (item: PipelineItem) => item.job.status === "sourced" ? (item.job.triagedAt ? "Saved for later" : "To review") : JOB_STATUS_LABELS[item.job.status];

export function Pipeline({ items, initialStage, initialMin, initialView }: { items: PipelineItem[]; initialStage: string; initialMin: number; initialView: "list" | "board" }) {
  const [stage, setStage] = useState(STAGES.some((option) => option.id === initialStage) ? initialStage : "active");
  const [min, setMin] = useState(initialMin);
  const [customMin, setCustomMin] = useState(!MIN_OPTIONS.includes(initialMin));
  const [view, setView] = useState<"list" | "board">(initialView);
  const [query, setQuery] = useState("");
  const [moving, setMoving] = useState<{ item: PipelineItem; to: JobDestination } | null>(null);
  const [moveError, setMoveError] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items
      .filter((item) => (item.job.fitScore ?? 0) >= min)
      .filter((item) => !needle || item.job.title.toLowerCase().includes(needle) || item.company.name.toLowerCase().includes(needle) || (item.job.location ?? "").toLowerCase().includes(needle));
  }, [items, min, query]);
  const counts = useMemo(() => Object.fromEntries(STAGES.map((option) => [option.id, filtered.filter((item) => matches(option, item)).length])), [filtered]);
  const visible = useMemo(() => filtered.filter((item) => matches(STAGES.find((option) => option.id === stage) ?? STAGES[0], item)), [filtered, stage]);

  function sync(next: { stage?: string; min?: number; view?: "list" | "board" }) {
    const nextStage = next.stage ?? stage;
    const nextMin = next.min ?? min;
    const nextView = next.view ?? view;
    setStage(nextStage); setMin(nextMin); setView(nextView);
    const params = new URLSearchParams();
    if (nextStage !== "active") params.set("stage", nextStage);
    if (nextMin > 0) params.set("min", String(nextMin));
    if (nextView === "board") params.set("view", "board");
    const search = params.toString();
    window.history.replaceState(null, "", search ? `?${search}` : window.location.pathname);
  }

  function openMove(item: PipelineItem, to?: JobDestination) {
    const options = destinationsOf(item);
    if (!options.length) return;
    setMoveError("");
    setMoving({ item, to: to && options.includes(to) ? to : options[0] });
  }
  const closeMove = () => setMoving(null);

  return <>
    <div className="between" style={{ margin: "0 0 10px", gap: 8 }}>
      <label style={{ position: "relative", flex: "1 1 auto", minWidth: 0 }}>
        <Search size={16} aria-hidden style={{ position: "absolute", left: 11, top: 11, color: "var(--ink-3)" }} />
        <input className="field" type="search" placeholder="Search roles" aria-label="Search roles" value={query} onChange={(event) => setQuery(event.target.value)} style={{ minHeight: 38, padding: "6px 10px 6px 34px", fontSize: 14 }} />
      </label>
      <div className="switcher" role="group" aria-label="View">
        <button type="button" aria-pressed={view === "list"} onClick={() => sync({ view: "list" })}><LayoutList aria-hidden />List</button>
        <button type="button" aria-pressed={view === "board"} onClick={() => sync({ view: "board" })}><SquareKanban aria-hidden />Board</button>
      </div>
    </div>
    <div className="cluster" style={{ margin: "0 0 12px", gap: 8 }}>
      <label className="cluster" style={{ gap: 6, flex: "0 0 auto" }}>
        <span className="small muted">Fit ≥</span>
        <select className="field" aria-label="Minimum fit score" value={customMin ? "custom" : min} onChange={(event) => { if (event.target.value === "custom") { setCustomMin(true); return; } setCustomMin(false); sync({ min: Number(event.target.value) }); }} style={{ width: "auto", minHeight: 38, padding: "6px 30px 6px 10px", fontSize: 14, fontWeight: 700 }}>
          {MIN_OPTIONS.map((value) => <option value={value} key={value}>{value === 0 ? "Any" : value}</option>)}
          <option value="custom">Other…</option>
        </select>
      </label>
      {customMin && <input className="field" type="number" inputMode="numeric" min={0} max={100} step={1} aria-label="Custom minimum fit score" value={min} onChange={(event) => sync({ min: Math.max(0, Math.min(100, Number(event.target.value) || 0)) })} style={{ width: 84, minHeight: 38, padding: "6px 10px", fontSize: 14, fontWeight: 700 }} autoFocus />}
      <span className="faint small" style={{ marginLeft: "auto" }}>{filtered.length} of {items.length}</span>
    </div>

    {view === "list" ? <>
      <div className="scroller" role="tablist" aria-label="Stage">
        {STAGES.map((option) => <button key={option.id} role="tab" aria-selected={stage === option.id} type="button" className={`seg ${stage === option.id ? "active" : ""}`} onClick={() => sync({ stage: option.id })}>{option.label}<span className="count">{counts[option.id]}</span></button>)}
      </div>
      {visible.length ? <div className="card" style={{ marginTop: 8 }}><div className="list">
        {visible.map(({ job, company }) => <Link className="row interactive" href={`/jobs/${job.id}`} key={job.id}>
          <span className="monogram sm" aria-hidden>{initials(company.name)}</span>
          <span style={{ minWidth: 0 }}>
            <span className="title truncate">{job.title}</span>
            <span className="meta truncate">{company.name}{job.location ? ` · ${job.location}` : ""} · {stage === "active" || stage === "closed" ? JOB_STATUS_LABELS[job.status] : daysAgo(job.statusChangedAt)}</span>
          </span>
          <span className="cluster" style={{ gap: 6, flexWrap: "nowrap" }}><Score value={job.fitScore} size="sm" /><ChevronRight className="chev" aria-hidden /></span>
        </Link>)}
      </div></div> : <div className="card empty" style={{ marginTop: 8 }}><strong>Nothing here</strong><span className="small">{min > 0 ? "Lower the minimum fit or pick another stage." : "Pick another stage."}</span></div>}
    </> : <Board items={filtered} onMove={openMove} />}

    <Sheet open={Boolean(moving)} onClose={closeMove} title={moving ? `Move ${moving.item.job.title}` : ""} subtitle={moving ? `Now: ${currentLabel(moving.item)} · ${moving.item.company.name}` : undefined} initialFocus="select">
      {moving && <form action={async (form) => { try { await moveJob(form); closeMove(); } catch (cause) { setMoveError(cause instanceof Error ? cause.message : "Could not move this role"); } }}>
        <input type="hidden" name="jobId" value={moving.item.job.id} />
        <label className="label" htmlFor="board-status">Move to</label>
        <Select id="board-status" name="status" defaultValue={moving.to}>{destinationsOf(moving.item).map((to) => <option value={to} key={to}>{JOB_DESTINATION_LABELS[to]}</option>)}</Select>
        <label className="label" htmlFor="board-note" style={{ marginTop: 12 }}>Note <span className="opt">optional</span></label>
        <Textarea id="board-note" name="note" placeholder="What changed?" style={{ minHeight: 64 }} />
        {moveError && <p className="error" role="alert">{moveError}</p>}
        <div className="sheet-actions"><Button className="btn-secondary" type="button" onClick={closeMove}>Cancel</Button><SubmitButton className="btn-primary" pendingLabel="Moving…">Move</SubmitButton></div>
      </form>}
    </Sheet>
  </>;
}

function Board({ items, onMove }: { items: PipelineItem[]; onMove: (item: PipelineItem, to?: JobDestination) => void }) {
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, number>>({});
  const grouped = useMemo(() => Object.fromEntries(BOARD_STAGES.map((stage) => [stage.id, items.filter((item) => matches(stage, item))])) as Record<string, PipelineItem[]>, [items]);
  const dragged = dragging ? items.find((item) => item.job.id === dragging) ?? null : null;
  const reset = () => { setDragging(null); setOver(null); };

  return <div className="board" aria-label="Pipeline board">
    {BOARD_STAGES.map((stage) => {
      const column = grouped[stage.id] ?? [];
      const limit = expanded[stage.id] ?? BOARD_PAGE;
      const target = dragged ? dropTarget(dragged, stage) : null;
      const blocked = Boolean(dragged) && !target;
      return <section
        key={stage.id}
        className={`board-col ${over === stage.id && target ? "over" : ""} ${blocked ? "blocked" : ""}`}
        aria-label={stage.label}
        aria-dropeffect={dragged ? (target ? "move" : "none") : undefined}
        onDragOver={(event) => { if (!target) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; if (over !== stage.id) setOver(stage.id); }}
        onDragLeave={() => setOver((current) => current === stage.id ? null : current)}
        onDrop={(event) => {
          event.preventDefault();
          const item = items.find((candidate) => candidate.job.id === event.dataTransfer.getData("text/job-id")) ?? dragged;
          reset();
          const destination = item ? dropTarget(item, stage) : null;
          if (item && destination) onMove(item, destination);
        }}
      >
        <div className="board-col-head"><span>{stage.label}</span><span className="count">{column.length}</span></div>
        {column.slice(0, limit).map((item) => {
          const canMove = destinationsOf(item).length > 0;
          return <article key={item.job.id} className={`board-card ${dragging === item.job.id ? "dragging" : ""}`} draggable={canMove} onDragStart={(event) => { event.dataTransfer.setData("text/job-id", item.job.id); event.dataTransfer.effectAllowed = "move"; setDragging(item.job.id); }} onDragEnd={reset}>
            <Link href={`/jobs/${item.job.id}`} className="title">{item.job.title}</Link>
            <span className="meta truncate">{item.company.name}{item.job.location ? ` · ${item.job.location}` : ""}</span>
            <Score value={item.job.fitScore} size="sm" />
            <div className="board-card-foot">
              <span className="faint tiny">{daysAgo(item.job.statusChangedAt)}</span>
              {canMove && <button type="button" className="board-move" onClick={() => onMove(item)}><MoveRight aria-hidden />Move</button>}
            </div>
          </article>;
        })}
        {column.length === 0 && <div className="board-empty">Empty</div>}
        {column.length > limit && <button type="button" className="board-more" onClick={() => setExpanded((current) => ({ ...current, [stage.id]: limit + BOARD_PAGE }))}>{column.length - limit} more</button>}
      </section>;
    })}
  </div>;
}
