import Link from "next/link";
import { Disclosure } from "@/components/disclosure";
import { Markdown } from "@/components/markdown";
import { SubmitButton } from "@/components/submit-button";
import { decideTailoringChange } from "@/lib/actions";

type Change = { id: string; section: string; current: string; proposed: string; rationale: string; decision: "pending" | "accepted" | "rejected" };
type Props = { tailoring: { id: string; proposalMd: string; changes: Change[]; status: "proposed" | "reviewed" }; job: { id: string; title: string }; company: { name: string } };

export function TailoringReview({ tailoring, job, company }: Props) {
  const decided = tailoring.changes.filter((change) => change.decision !== "pending").length;
  return <div className="card card-pad stack" style={{ gap: 12 }}>
    <div className="between" style={{ alignItems: "flex-start" }}>
      <div style={{ minWidth: 0 }}><div className="overline">Proposed changes</div><Link className="link" href={`/jobs/${job.id}`} style={{ display: "block", fontSize: 14 }}>{job.title}</Link><div className="faint small">{company.name}</div></div>
      <span className={`pill ${decided === tailoring.changes.length ? "good" : "brand"}`}>{decided}/{tailoring.changes.length}</span>
    </div>
    <div className="bar"><i className="good" style={{ width: `${tailoring.changes.length ? (decided / tailoring.changes.length) * 100 : 0}%` }} /></div>
    {tailoring.changes.map((change) => <div className="inset" key={change.id}>
      <div className="overline" style={{ marginBottom: 6 }}>{change.section}</div>
      <div className="small faint" style={{ textDecoration: change.decision === "accepted" ? "line-through" : "none" }}>{change.current}</div>
      <div style={{ marginTop: 6, fontWeight: 600, fontSize: 13.5 }}>{change.proposed}</div>
      <Disclosure quiet title={<span className="small faint" style={{ fontWeight: 600 }}>Why</span>}><p className="small muted">{change.rationale}</p></Disclosure>
      {change.decision === "pending"
        ? <div className="btn-row" style={{ marginTop: 6 }}>
          <form action={decideTailoringChange}><input type="hidden" name="tailoringId" value={tailoring.id} /><input type="hidden" name="changeId" value={change.id} /><input type="hidden" name="decision" value="accepted" /><SubmitButton className="btn-good btn-sm" pendingLabel="…">Accept</SubmitButton></form>
          <form action={decideTailoringChange}><input type="hidden" name="tailoringId" value={tailoring.id} /><input type="hidden" name="changeId" value={change.id} /><input type="hidden" name="decision" value="rejected" /><SubmitButton className="btn-secondary btn-sm" pendingLabel="…">Reject</SubmitButton></form>
        </div>
        : <span className={`pill ${change.decision === "accepted" ? "good" : ""}`} style={{ marginTop: 8 }}>{change.decision === "accepted" ? "Accepted" : "Rejected"}</span>}
    </div>)}
    <Disclosure quiet title={<span className="small">Assistant summary</span>}><Markdown className="compact" content={tailoring.proposalMd} /></Disclosure>
  </div>;
}
