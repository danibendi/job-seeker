import type { Metadata } from "next";
import Link from "next/link";
import { Activity, BarChart3, Building2, ChevronRight, LogOut, Radar, SlidersHorizontal } from "lucide-react";
import { isOpenAccess } from "@/lib/open-access";

export const metadata: Metadata = { title: "More" };
export const dynamic = "force-dynamic";

const destinations = [
  { href: "/activity", label: "Agent activity", detail: "Searches, answers, requests", icon: Activity },
  { href: "/insights", label: "Insights", detail: "Pace and funnel", icon: BarChart3 },
  { href: "/agencies", label: "Agencies", detail: "Recruiters to work with", icon: Building2 },
  { href: "/watchlist", label: "Watchlist", detail: "Sites your assistant checks", icon: Radar },
  { href: "/settings", label: "Settings", detail: "Scope, pace, notifications", icon: SlidersHorizontal },
];

export default function MorePage() {
  return <>
    <header className="page-head"><div><h1>More</h1></div></header>
    <div className="card menu-list"><div className="list">{destinations.map(({ href, label, detail, icon: Icon }) => <Link className="row interactive" key={href} href={href}><span className="menu-icon"><Icon aria-hidden /></span><span><span className="title">{label}</span><span className="meta">{detail}</span></span><ChevronRight className="chev" aria-hidden /></Link>)}</div></div>
    {!isOpenAccess() && <form action="/api/auth/logout" method="post" style={{ marginTop: 18 }}><button type="submit" className="btn btn-secondary btn-block"><LogOut aria-hidden /> Log out</button></form>}
  </>;
}
