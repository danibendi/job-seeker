import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { InterviewCreate } from "@/components/interview-create";
import { getAppTimeZone, getInterviewCandidateJobs, getInterviewsData } from "@/lib/data";
import { formatTime, formatWeekday, humanize, initials } from "@/lib/format";

export const metadata: Metadata = { title: "Interviews" };
export const dynamic = "force-dynamic";

export default async function InterviewsPage() {
  const [rows, candidateJobs, timeZone] = await Promise.all([getInterviewsData(), getInterviewCandidateJobs(), getAppTimeZone()]);
  const now = Date.now();
  const upcoming = rows.filter(({ interview }) => +new Date(interview.scheduledAt) >= now && interview.outcome === "pending");
  const past = rows.filter(({ interview }) => +new Date(interview.scheduledAt) < now || interview.outcome !== "pending").sort((a, b) => +new Date(b.interview.scheduledAt) - +new Date(a.interview.scheduledAt));
  const Row = ({ interview, job, company }: (typeof rows)[number]) => <Link className="row interactive" href={`/interviews/${interview.id}`}>
    <span className="monogram sm" aria-hidden>{initials(company.name)}</span>
    <span style={{ minWidth: 0 }}><span className="title truncate">{company.name} · {humanize(interview.stage)}</span><span className="meta truncate">{formatWeekday(interview.scheduledAt, interview.timeZone)} · {formatTime(interview.scheduledAt, interview.timeZone)} · {job.title}</span></span>
    <span className="cluster" style={{ gap: 6, flexWrap: "nowrap" }}>{interview.outcome !== "pending" && <span className={`pill ${interview.outcome === "passed" ? "good" : interview.outcome === "failed" ? "bad" : ""}`}>{humanize(interview.outcome)}</span>}<ChevronRight className="chev" aria-hidden /></span>
  </Link>;
  return <>
    <header className="page-head"><div><h1>Interviews</h1><p className="sub">{upcoming.length ? `${upcoming.length} coming up` : "Nothing scheduled"}</p></div><InterviewCreate jobs={candidateJobs.map(({ job, company }) => ({ id: job.id, label: `${company.name} — ${job.title}` }))} timeZone={timeZone} /></header>
    {upcoming.length ? <div className="card"><div className="list">{upcoming.map((row) => <Row key={row.interview.id} {...row} />)}</div></div> : <EmptyState title="No interviews yet">Add one when it lands. Your assistant can prepare the brief.</EmptyState>}
    {past.length > 0 && <section className="section"><div className="section-head"><h2>Past</h2></div><div className="card"><div className="list">{past.map((row) => <Row key={row.interview.id} {...row} />)}</div></div></section>}
  </>;
}
