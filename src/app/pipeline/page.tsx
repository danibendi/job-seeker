import type { Metadata } from "next";
import { Pipeline } from "@/components/pipeline";
import { getPipelineData, getSearchSettings } from "@/lib/data";
import { createManualJob } from "@/lib/actions";
import { SaveForm } from "@/components/save-form";
import { Input, Textarea } from "@/components/ui/input";

export const metadata: Metadata = { title: "Pipeline" };
export const dynamic = "force-dynamic";

export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ stage?: string; min?: string; view?: string }> }) {
  const query = await searchParams;
  const [items, settings] = await Promise.all([getPipelineData(), getSearchSettings()]);
  const requestedMin = query.min == null ? NaN : Number(query.min);
  const initialMin = Number.isInteger(requestedMin) && requestedMin >= 0 && requestedMin <= 100 ? requestedMin : (query.stage === "sourced" ? settings.minimumFitScore : 0);
  const active = items.filter((item) => ["to_apply", "applied", "screening", "interviewing", "offer"].includes(item.job.status)).length;
  return <>
    <header className="page-head"><div><h1>Pipeline</h1><p className="sub">{active} active {active === 1 ? "role" : "roles"}</p></div></header>
    <details className="card card-pad" style={{ marginBottom: 16 }}><summary><strong>Add a job manually</strong></summary>
      <div style={{ marginTop: 16 }}><SaveForm action={createManualJob} label="Add job" pendingLabel="Adding…" className="stack">
        <div className="field-grid"><div><label className="label" htmlFor="manual-company">Company</label><Input id="manual-company" name="company" required /></div><div><label className="label" htmlFor="manual-title">Role title</label><Input id="manual-title" name="title" required /></div></div>
        <div><label className="label" htmlFor="manual-url">Job URL</label><Input id="manual-url" name="url" type="url" placeholder="https://company.example/jobs/role" required /></div>
        <div><label className="label" htmlFor="manual-location">Location <span className="opt">optional</span></label><Input id="manual-location" name="location" /></div>
        <div><label className="label" htmlFor="manual-description">Description <span className="opt">optional</span></label><Textarea id="manual-description" name="descriptionMd" rows={8} /></div>
      </SaveForm></div>
    </details>
    <Pipeline items={items} initialStage={query.stage ?? "active"} initialMin={initialMin} initialView={query.view === "board" ? "board" : "list"} />
  </>;
}
