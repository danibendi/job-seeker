import type { Metadata } from "next";
import { AppBar } from "@/components/app-bar";
import { EmptyState } from "@/components/empty-state";
import { getInsightsData } from "@/lib/data-extra";
import { formatShortDate, humanize } from "@/lib/format";
import { JOB_STATUS_LABELS } from "@/lib/job-workflow";

export const metadata: Metadata = { title: "Insights" };
export const dynamic = "force-dynamic";

export default async function InsightsPage() {
  const data = await getInsightsData();
  const funnelOrder = ["to_apply", "applied", "screening", "interviewing", "offer"] as const;
  const funnel = funnelOrder.map((status) => ({ status, count: data.funnel.find((item) => item.status === status)?.count ?? 0 }));
  const weeks = data.targets.filter((row) => new Date(row.weekStart).getTime() <= Date.now());
  const maxWeek = Math.max(1, ...weeks.map((row) => Math.max(row.target, row.actual)));
  const maxReason = Math.max(1, ...data.reasons.map((item) => item.count));
  return <>
    <AppBar title="Insights" back="/more" />
    {!data.targets.length && !data.funnel.length ? <EmptyState title="Nothing to show yet" /> : <>
      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 6 }}>{funnel.map((item) => <div className="stat" key={item.status} style={{ padding: 10 }}><div className="value" style={{ fontSize: 22 }}>{item.count}</div><div className="label" style={{ fontSize: 10.5 }}>{JOB_STATUS_LABELS[item.status]}</div></div>)}</div>

      {weeks.length > 0 && <section className="section card card-pad">
        <div className="between" style={{ marginBottom: 10 }}><h2 style={{ fontSize: 16 }}>Applications per week</h2><span className="faint tiny">actual / target</span></div>
        <div className="stack" style={{ gap: 8 }}>{weeks.slice(-8).map((row) => <div key={row.weekStart} style={{ display: "grid", gridTemplateColumns: "56px minmax(0,1fr) 44px", gap: 10, alignItems: "center" }}>
          <span className="small muted num">{formatShortDate(row.weekStart)}</span>
          <span className="bar" style={{ position: "relative", height: 8 }}><i className={row.actual >= row.target ? "good" : ""} style={{ width: `${(row.actual / maxWeek) * 100}%` }} /><i style={{ position: "absolute", top: -3, bottom: -3, left: `calc(${(row.target / maxWeek) * 100}% - 1px)`, width: 2, background: "var(--ink)", borderRadius: 1, height: "auto" }} /></span>
          <span className="small num" style={{ textAlign: "right", fontWeight: 700 }}>{row.actual}<span className="faint" style={{ fontWeight: 500 }}>/{row.target}</span></span>
        </div>)}</div>
      </section>}

      {data.reasons.length > 0 && <section className="section card card-pad">
        <h2 style={{ fontSize: 16, marginBottom: 10 }}>Why you pass on roles</h2>
        <div className="stack" style={{ gap: 8 }}>{data.reasons.map((item) => <div key={item.reason} style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr) 28px", gap: 10, alignItems: "center" }}><span className="small">{humanize(item.reason)}</span><span className="bar"><i style={{ width: `${(item.count / maxReason) * 100}%` }} /></span><span className="small num" style={{ textAlign: "right", fontWeight: 700 }}>{item.count}</span></div>)}</div>
      </section>}

      {data.rejectionReasons.length > 0 && <section className="section card card-pad">
        <h2 style={{ fontSize: 16, marginBottom: 10 }}>Rejection reasons</h2>
        <div className="stack" style={{ gap: 6 }}>{data.rejectionReasons.map((item) => <div className="between" key={item.reason ?? "none"}><span className="small">{item.reason ? humanize(item.reason) : "No reason given"}</span><span className="pill">{item.count}</span></div>)}</div>
      </section>}
    </>}
  </>;
}
