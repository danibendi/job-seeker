import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, CalendarClock, ChevronRight, FileText, MessageCircleWarning, SlidersHorizontal } from "lucide-react";
import { Score } from "@/components/score";
import { SubmitButton } from "@/components/submit-button";
import { getTodayData } from "@/lib/data";
import { completeFollowUp, retryRequest } from "@/lib/actions";
import { formatTime, formatWeekday, humanize, initials, workModeLabel } from "@/lib/format";
import { zonedDateParts } from "@/lib/time";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Home" };
export const dynamic = "force-dynamic";

const REVIEW_ROWS = 5;

export default async function HomePage() {
  const data = await getTodayData();
  if (!data.workspace.onboardingCompletedAt) redirect("/onboarding");
  const now = new Date();
  const { hour } = zonedDateParts(now, data.timeZone);
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const longDate = new Intl.DateTimeFormat("en-GB", { timeZone: data.timeZone, weekday: "long", day: "numeric", month: "long" }).format(now);
  const needsYou = data.tailorings.length + data.followUps.length + data.failedRequests.length + (data.recentFailure ? 1 : 0);
  const review = data.jobs.slice(0, REVIEW_ROWS);

  return <>
    <header className="page-head">
      <div><div className="overline">{longDate}</div><h1>{greeting}, {data.workspace.ownerName}</h1></div>
      <Link href="/settings" className="icon-btn raised" aria-label="Settings"><SlidersHorizontal aria-hidden /></Link>
    </header>

    <section className="hero" aria-label="This week">
      <div className="overline">This week</div>
      <div className="hero-stats">
        <Link className="hero-stat" href="/pipeline?stage=sourced"><span className={`value ${data.stats.review ? "brand" : ""}`}>{data.stats.review}</span><span className="label">To review</span></Link>
        <Link className="hero-stat" href="/pipeline?stage=applied"><span className="value">{data.stats.applications}{data.stats.target ? <small>/{data.stats.target}</small> : null}</span><span className="label">Applied</span></Link>
        <Link className="hero-stat" href="/pipeline?stage=interviewing"><span className="value">{data.stats.interviewing}</span><span className="label">In talks</span></Link>
      </div>
    </section>

    {needsYou > 0 && <section className="section">
      <div className="section-head"><h2>Needs you</h2></div>
      <div className="card"><div className="list">
        {data.tailorings.map(({ tailoring, job, company }) => <Link className="row interactive" key={tailoring.id} href={`/cv?tailoring=${tailoring.id}`}>
          <span className="menu-icon"><FileText aria-hidden /></span>
          <span style={{ minWidth: 0 }}><span className="title truncate">CV changes for {company.name}</span><span className="meta truncate">{tailoring.changes.filter((change) => change.decision === "pending").length} to decide · {job.title}</span></span>
          <ChevronRight className="chev" aria-hidden />
        </Link>)}
        {data.followUps.map(({ job, company }) => <div className="row" key={job.id}>
          <span className="menu-icon"><CalendarClock aria-hidden /></span>
          <Link href={`/jobs/${job.id}`} style={{ minWidth: 0 }}><span className="title truncate">Follow up with {company.name}</span><span className="meta truncate">{job.title}</span></Link>
          <form action={completeFollowUp}><input type="hidden" name="jobId" value={job.id} /><SubmitButton className="btn-ghost btn-sm" pendingLabel="…">Done</SubmitButton></form>
        </div>)}
        {data.failedRequests.map((request) => <div className="row" key={request.id}>
          <span className="menu-icon" style={{ background: "var(--bad-soft)", color: "var(--bad-ink)" }}><MessageCircleWarning aria-hidden /></span>
          <span style={{ minWidth: 0 }}><span className="title truncate">{data.workspace.assistantLabel} could not answer</span><span className="meta truncate">{request.text}</span></span>
          <form action={retryRequest}><input type="hidden" name="requestId" value={request.id} /><SubmitButton className="btn-ghost btn-sm" pendingLabel="…">Retry</SubmitButton></form>
        </div>)}
        {data.recentFailure && <Link className="row interactive" href="/activity?tab=runs">
          <span className="menu-icon" style={{ background: "var(--warn-soft)", color: "var(--warn-ink)" }}><AlertTriangle aria-hidden /></span>
          <span style={{ minWidth: 0 }}><span className="title truncate">{humanize(data.recentFailure.workflow)} failed</span><span className="meta">See what happened</span></span>
          <ChevronRight className="chev" aria-hidden />
        </Link>}
      </div></div>
    </section>}

    <section className="section">
      <div className="section-head"><h2>Review next</h2>{data.stats.review > REVIEW_ROWS && <Link href="/pipeline?stage=sourced">All {data.stats.review}</Link>}</div>
      {review.length ? <div className="card"><div className="list">
        {review.map(({ job, company }) => <Link className="row interactive" href={`/jobs/${job.id}`} key={job.id}>
          <span className="monogram sm" aria-hidden>{initials(company.name)}</span>
          <span style={{ minWidth: 0 }}>
            <span className="title truncate">{job.title}</span>
            <span className="meta truncate">{company.name}{job.location ? ` · ${job.location}` : ""}{job.workMode ? ` · ${workModeLabel(job.workMode)}` : ""}{company.tier === "a" ? " · Priority" : ""}</span>
          </span>
          <span className="cluster" style={{ gap: 6, flexWrap: "nowrap" }}><Score value={job.fitScore} size="sm" /><ChevronRight className="chev" aria-hidden /></span>
        </Link>)}
      </div></div> : <div className="card empty"><strong>Inbox clear</strong><span className="small">New roles appear here after a search.</span></div>}
      {data.stats.hidden > 0 && <p className="faint tiny" style={{ textAlign: "center", marginTop: 8 }}>{data.stats.hidden} low-fit {data.stats.hidden === 1 ? "role" : "roles"} hidden · <Link className="link" href="/pipeline?stage=sourced&min=0">show</Link></p>}
    </section>

    {data.interviews.length > 0 && <section className="section">
      <div className="section-head"><h2>Coming up</h2><Link href="/interviews">All</Link></div>
      <div className="card"><div className="list">{data.interviews.map(({ interview, job, company }) => <Link className="row interactive" key={interview.id} href={`/interviews/${interview.id}`}>
        <span className="monogram sm" aria-hidden>{initials(company.name)}</span>
        <span style={{ minWidth: 0 }}><span className="title truncate">{company.name} · {humanize(interview.stage)}</span><span className="meta truncate">{formatWeekday(interview.scheduledAt, interview.timeZone)} · {formatTime(interview.scheduledAt, interview.timeZone)} · {job.title}</span></span>
        <ChevronRight className="chev" aria-hidden />
      </Link>)}</div></div>
    </section>}
  </>;
}
