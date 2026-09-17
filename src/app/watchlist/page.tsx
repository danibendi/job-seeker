import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { AppBar } from "@/components/app-bar";
import { AddSource, SourceEditor } from "@/components/directory";
import { Disclosure } from "@/components/disclosure";
import { EmptyState } from "@/components/empty-state";
import { Markdown } from "@/components/markdown";
import { getWatchlistData } from "@/lib/data-extra";
import { daysAgo } from "@/lib/format";
import { safeHttpUrl } from "@/lib/safe-url";

export const metadata: Metadata = { title: "Watchlist" };
export const dynamic = "force-dynamic";

const KINDS = [
  { id: "company", label: "Companies" },
  { id: "board", label: "Job boards" },
  { id: "alert", label: "Alerts" },
] as const;

export default async function WatchlistPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const rows = await getWatchlistData();
  const requested = (await searchParams).kind;
  const kind = KINDS.some((option) => option.id === requested) ? requested as (typeof KINDS)[number]["id"] : KINDS.find((option) => rows.some((row) => row.kind === option.id))?.id ?? "company";
  const visible = rows.filter((row) => row.kind === kind).sort((a, b) => (b.lastCheckedAt ? 1 : 0) - (a.lastCheckedAt ? 1 : 0) || a.label.localeCompare(b.label));
  return <>
    <AppBar title="Watchlist" back="/more" actions={<AddSource kind={kind} />} />
    <div className="scroller" role="tablist" aria-label="Kind" style={{ marginBottom: 10 }}>{KINDS.map((option) => { const count = rows.filter((row) => row.kind === option.id).length; return <Link key={option.id} role="tab" aria-selected={kind === option.id} className={`seg ${kind === option.id ? "active" : ""}`} href={`/watchlist?kind=${option.id}`}>{option.label}<span className="count">{count}</span></Link>; })}</div>
    {visible.length ? <div>{visible.map((item) => {
      const url = safeHttpUrl(item.url);
      return <Disclosure key={item.id} title={item.label} meta={<span className="cluster" style={{ gap: 6 }}><span className="pill outline">{item.cadence}</span><span className="faint tiny">{item.lastCheckedAt ? `checked ${daysAgo(item.lastCheckedAt)}` : "not checked yet"}</span></span>}>
        <div className="stack" style={{ gap: 10 }}>
          <Markdown className="compact" content={item.lastFindingsMd} fallback="No findings recorded yet." />
          {url && <a className="link small" href={url} target="_blank" rel="noreferrer">Open <ExternalLink size={12} style={{ display: "inline", verticalAlign: -1 }} aria-hidden /></a>}
          <SourceEditor source={{ id: item.id, cadence: item.cadence }} />
        </div>
      </Disclosure>;
    })}</div> : <EmptyState title="Nothing watched here">Add a careers page, job board search, or alert for your assistant to check.</EmptyState>}
  </>;
}
