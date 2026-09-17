import type { Metadata } from "next";
import Link from "next/link";
import { FileText, PenLine } from "lucide-react";
import { CvDocument } from "@/components/cv-document";
import { CvOriginal } from "@/components/cv-original";
import { CvToolbar } from "@/components/cv-toolbar";
import { EmptyState } from "@/components/empty-state";
import { MobileReviewSheet } from "@/components/mobile-review-sheet";
import { TailoringReview } from "@/components/tailoring-review";
import { cvDocumentUrls, parseCvDocument } from "@/lib/cv-document";
import { getCvData } from "@/lib/data";
import { formatDate } from "@/lib/format";
import { createCvVariant } from "@/lib/actions";
import { SaveForm } from "@/components/save-form";
import { Input, Textarea } from "@/components/ui/input";

export const metadata: Metadata = { title: "CV" };
export const dynamic = "force-dynamic";

function CreateCvForm() {
  return <details className="card card-pad" style={{ marginBottom: 16 }}><summary><strong>Create a CV variant</strong></summary>
    <div style={{ marginTop: 16 }}><SaveForm action={createCvVariant} label="Create CV" pendingLabel="Creating…" className="stack">
      <div><label className="label" htmlFor="cv-name">Name</label><Input id="cv-name" name="name" placeholder="General CV" required /></div>
      <div><label className="label" htmlFor="cv-summary">Short label <span className="opt">optional</span></label><Input id="cv-summary" name="summary" placeholder="Product and programme leadership" /></div>
      <div><label className="label" htmlFor="cv-content">Factual CV text</label><Textarea id="cv-content" name="contentMd" rows={18} placeholder="Paste Markdown or plain text. Keep this factual; search preferences belong in Settings." required /></div>
    </SaveForm></div>
  </details>;
}

export default async function CvPage({ searchParams }: { searchParams: Promise<{ variant?: string; tailoring?: string; view?: string }> }) {
  const query = await searchParams;
  const data = await getCvData(query.variant, query.tailoring);
  if (!data.selected) return <><header className="page-head"><div><h1>CV</h1></div></header><CreateCvForm /><EmptyState title="No CV yet">Create your first factual CV variant above.</EmptyState></>;
  const selected = data.selected;
  const mode = query.view === "pdf" ? "pdf" : "edit";
  const blocks = parseCvDocument(selected.contentMd);
  const drive = cvDocumentUrls(selected.driveFileId);
  const pdfUrl = data.document ? `/api/cv/${selected.id}/document` : null;
  const otherPending = data.pending.filter((item) => item.id !== data.tailoring?.tailoring.id);
  const href = (view: "edit" | "pdf") => `/cv?variant=${selected.slug}${view === "pdf" ? "&view=pdf" : ""}${query.tailoring ? `&tailoring=${query.tailoring}` : ""}`;
  const pendingList = otherPending.length > 0 && <div className="card"><div className="list">{otherPending.map((item) => <Link className="row plain interactive" key={item.id} href={`/cv?tailoring=${item.id}`}><span style={{ minWidth: 0 }}><span className="title truncate">{item.jobTitle}</span><span className="meta">{item.company} · {item.changes.filter((change) => change.decision === "pending").length} to decide</span></span><span className="link small">Review</span></Link>)}</div></div>;

  return <>
    <header className="page-head">
      <div><h1>CV</h1><p className="sub">{selected.summary || selected.name} · v{selected.version} · updated {formatDate(selected.updatedAt)}</p></div>
      <div className="switcher" role="group" aria-label="View">
        <Link href={href("edit")} className={mode === "edit" ? "active" : ""} aria-current={mode === "edit" ? "page" : undefined}><PenLine aria-hidden />Edit</Link>
        <Link href={href("pdf")} className={mode === "pdf" ? "active" : ""} aria-current={mode === "pdf" ? "page" : undefined}><FileText aria-hidden />PDF</Link>
      </div>
    </header>
    <CreateCvForm />
    <div className="scroller" role="tablist" aria-label="CV variant">{data.variants.map((variant) => <Link key={variant.id} role="tab" aria-selected={variant.id === selected.id} className={`seg ${variant.id === selected.id ? "active" : ""}`} href={`/cv?variant=${variant.slug}${mode === "pdf" ? "&view=pdf" : ""}`}>{variant.name}{data.pending.some((item) => item.cvVariantId === variant.id) && <span className="badge" aria-label="changes to review">•</span>}</Link>)}</div>
    <CvToolbar variant={{ id: selected.id, slug: selected.slug, contentMd: selected.contentMd }} mode={mode} pdfUrl={pdfUrl} originalUrl={drive?.open ?? null} />
    {data.tailoring && <MobileReviewSheet pendingCount={data.tailoring.tailoring.changes.filter((change) => change.decision === "pending").length} title={`Changes for ${data.tailoring.company.name}`}><TailoringReview tailoring={data.tailoring.tailoring} job={{ id: data.tailoring.job.id, title: data.tailoring.job.title }} company={{ name: data.tailoring.company.name }} /></MobileReviewSheet>}
    {otherPending.length > 0 && <div className="only-mobile" style={{ marginBottom: 12 }}>{pendingList}</div>}
    <div className="cv-layout">
      <div>
        {mode === "edit"
          ? <CvDocument variant={{ id: selected.id, slug: selected.slug, version: selected.version }} blocks={blocks} changes={data.tailoring?.tailoring.changes ?? []} />
          : <CvOriginal variant={{ id: selected.id, name: selected.name }} document={data.document} pdfUrl={pdfUrl} drive={drive} />}
      </div>
      <aside className="cv-rail stack only-desktop">
        {data.tailoring && <TailoringReview tailoring={data.tailoring.tailoring} job={{ id: data.tailoring.job.id, title: data.tailoring.job.title }} company={{ name: data.tailoring.company.name }} />}
        {pendingList}
      </aside>
    </div>
  </>;
}
