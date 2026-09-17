import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import { AppBar } from "@/components/app-bar";
import { AddAgency, AGENCY_STATUS_LABELS, AgencyEditor } from "@/components/directory";
import { Disclosure } from "@/components/disclosure";
import { EmptyState } from "@/components/empty-state";
import { Markdown } from "@/components/markdown";
import { getAgenciesData } from "@/lib/data-extra";
import { formatShortDate } from "@/lib/format";
import { safeHttpUrl } from "@/lib/safe-url";

export const metadata: Metadata = { title: "Agencies" };
export const dynamic = "force-dynamic";

const tone: Record<string, string> = { active: "good", contacted: "brand", dead: "", not_contacted: "outline" };

export default async function AgenciesPage() {
  const rows = await getAgenciesData();
  const order = ["active", "contacted", "not_contacted", "dead"];
  const sorted = [...rows].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.name.localeCompare(b.name));
  return <>
    <AppBar title="Agencies" back="/more" actions={<AddAgency />} />
    {sorted.length ? <div>{sorted.map((agency) => {
      const site = safeHttpUrl(agency.website);
      const contacts = (agency.contacts as Record<string, unknown>[]).filter((contact) => contact && typeof contact === "object");
      return <Disclosure key={agency.id} title={agency.name} meta={<span className={`pill ${tone[agency.status] ?? ""}`}>{AGENCY_STATUS_LABELS[agency.status]}</span>}>
        <div className="stack" style={{ gap: 10 }}>
          {agency.lastContactAt && <div className="small muted">Last contact {formatShortDate(agency.lastContactAt)}</div>}
          <Markdown className="compact" content={agency.notesMd} fallback="No notes." />
          {contacts.length > 0 && <ul className="bullets">{contacts.map((contact, index) => <li className="bullet neutral" key={index}><span className="mark">@</span><span>{[contact.name, contact.role ?? contact.title, contact.email, contact.phone].filter(Boolean).join(" · ") || JSON.stringify(contact)}</span></li>)}</ul>}
          {site && <a className="link small" href={site} target="_blank" rel="noreferrer">Website <ExternalLink size={12} style={{ display: "inline", verticalAlign: -1 }} aria-hidden /></a>}
          <Disclosure quiet title={<span className="small">Edit</span>}><AgencyEditor agency={{ id: agency.id, status: agency.status, notesMd: agency.notesMd }} /></Disclosure>
        </div>
      </Disclosure>;
    })}</div> : <EmptyState title="No agencies yet">Add the recruiters you want your assistant to keep in mind.</EmptyState>}
  </>;
}
