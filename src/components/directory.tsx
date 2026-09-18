"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { addAgency, addWatchlistSource, removeWatchlistSource, updateAgency, updateWatchlistSource } from "@/lib/actions";
import { SaveForm } from "@/components/save-form";
import { Sheet } from "@/components/sheet";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { AGENCY_STATUS_LABELS, SOURCE_KIND_LABELS } from "@/lib/directory-labels";

export function AddAgency() {
  const [open, setOpen] = useState(false);
  return <>
    <Button className="btn-primary btn-sm" type="button" onClick={() => setOpen(true)}><Plus aria-hidden />Add</Button>
    <Sheet open={open} onClose={() => setOpen(false)} title="Add agency" initialFocus="input">
      <SaveForm action={addAgency} label="Add agency" pendingLabel="Adding…" className="field-group" onSaved={() => setOpen(false)}>
        <div className="field-grid">
          <div className="wide"><label className="label" htmlFor="agency-name">Name</label><Input id="agency-name" name="name" required maxLength={240} /></div>
          <div><label className="label" htmlFor="agency-website">Website <span className="opt">optional</span></label><Input id="agency-website" name="website" type="url" inputMode="url" placeholder="https://" /></div>
          <div><label className="label" htmlFor="agency-status">Status</label><Select id="agency-status" name="status" defaultValue="not_contacted">{Object.entries(AGENCY_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></div>
          <div><label className="label" htmlFor="agency-contact">Contact <span className="opt">optional</span></label><Input id="agency-contact" name="contactName" placeholder="Name" /></div>
          <div><label className="label" htmlFor="agency-contact-role">Their role <span className="opt">optional</span></label><Input id="agency-contact-role" name="contactRole" /></div>
          <div className="wide"><label className="label" htmlFor="agency-contact-email">Contact email <span className="opt">optional</span></label><Input id="agency-contact-email" name="contactEmail" type="email" inputMode="email" /></div>
          <div className="wide"><label className="label" htmlFor="agency-notes">Notes <span className="opt">optional</span></label><Textarea id="agency-notes" name="notesMd" placeholder="One point per line" style={{ minHeight: 64 }} /></div>
        </div>
      </SaveForm>
    </Sheet>
  </>;
}

export function AgencyEditor({ agency }: { agency: { id: string; status: keyof typeof AGENCY_STATUS_LABELS; notesMd: string | null } }) {
  return <SaveForm action={updateAgency} label="Save" buttonClass="btn-secondary btn-sm" className="stack" >
    <input type="hidden" name="agencyId" value={agency.id} />
    <div className="field-grid">
      <div><label className="label" htmlFor={`status-${agency.id}`}>Status</label><Select id={`status-${agency.id}`} name="status" defaultValue={agency.status}>{Object.entries(AGENCY_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></div>
      <div className="wide"><label className="label" htmlFor={`notes-${agency.id}`}>Notes</label><Textarea id={`notes-${agency.id}`} name="notesMd" defaultValue={agency.notesMd ?? ""} placeholder="One point per line" style={{ minHeight: 64 }} /></div>
    </div>
  </SaveForm>;
}

export function AddSource({ kind }: { kind: keyof typeof SOURCE_KIND_LABELS }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button className="btn-primary btn-sm" type="button" onClick={() => setOpen(true)}><Plus aria-hidden />Add</Button>
    <Sheet open={open} onClose={() => setOpen(false)} title="Add source" initialFocus="input">
      <SaveForm action={addWatchlistSource} label="Add source" pendingLabel="Adding…" className="field-group" onSaved={() => setOpen(false)}>
        <div className="field-grid">
          <div className="wide"><label className="label" htmlFor="source-label">Name</label><Input id="source-label" name="label" required maxLength={240} placeholder="Northwind careers" /></div>
          <div className="wide"><label className="label" htmlFor="source-url">Link</label><Input id="source-url" name="url" type="url" inputMode="url" required placeholder="https://" /></div>
          <div><label className="label" htmlFor="source-kind">Type</label><Select id="source-kind" name="kind" defaultValue={kind}>{Object.entries(SOURCE_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></div>
          <div><label className="label" htmlFor="source-cadence">Check</label><Select id="source-cadence" name="cadence" defaultValue="daily"><option value="daily">Daily</option><option value="weekly">Weekly</option></Select></div>
        </div>
      </SaveForm>
    </Sheet>
  </>;
}

export function SourceEditor({ source }: { source: { id: string; cadence: "daily" | "weekly" } }) {
  return <div className="between" style={{ gap: 8, flexWrap: "wrap" }}>
    <SaveForm action={updateWatchlistSource} label="Save" buttonClass="btn-secondary btn-sm" className="cluster" >
      <input type="hidden" name="sourceId" value={source.id} />
      <label className="cluster" style={{ gap: 6 }}><span className="small muted">Check</span><Select name="cadence" defaultValue={source.cadence} aria-label="Check frequency" style={{ width: "auto", minHeight: 38, padding: "6px 30px 6px 10px", fontSize: 14 }}><option value="daily">Daily</option><option value="weekly">Weekly</option></Select></label>
    </SaveForm>
    <form action={removeWatchlistSource}><input type="hidden" name="sourceId" value={source.id} /><SubmitButton className="btn-danger btn-sm" pendingLabel="Removing…"><Trash2 aria-hidden />Stop watching</SubmitButton></form>
  </div>;
}
