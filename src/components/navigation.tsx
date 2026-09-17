"use client";

import { Activity, BarChart3, Building2, CalendarDays, BriefcaseBusiness, FileText, House, Layers, LogOut, Menu, Radar, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const primary = [
  { href: "/", label: "Home", icon: House },
  { href: "/pipeline", label: "Pipeline", icon: Layers },
  { href: "/interviews", label: "Interviews", icon: CalendarDays },
  { href: "/cv", label: "CV", icon: FileText },
];
const secondary = [
  { group: "Agents", links: [
    { href: "/activity", label: "Activity", icon: Activity },
    { href: "/insights", label: "Insights", icon: BarChart3 },
  ] },
  { group: "Network", links: [
    { href: "/agencies", label: "Agencies", icon: Building2 },
    { href: "/watchlist", label: "Watchlist", icon: Radar },
  ] },
  { group: "Setup", links: [
    { href: "/settings", label: "Settings", icon: SlidersHorizontal },
  ] },
];
const secondaryHrefs = secondary.flatMap((group) => group.links.map((link) => link.href));

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/" || pathname.startsWith("/jobs/");
  if (href === "/more") return pathname === "/more" || secondaryHrefs.some((link) => pathname.startsWith(link));
  return pathname === href || pathname.startsWith(href + "/");
}

function NavLink({ href, label, icon: Icon, pathname }: { href: string; label: string; icon: typeof House; pathname: string }) {
  const active = isActive(pathname, href);
  return <Link className={`tab ${active ? "active" : ""}`} href={href} aria-current={active ? "page" : undefined}><span className="tab-icon"><Icon aria-hidden /></span><span>{label}</span></Link>;
}

export function Navigation({ showLogout = true }: { showLogout?: boolean }) {
  const pathname = usePathname();
  if (pathname === "/login") return null;
  return <>
    <aside className="sidebar">
      <Link className="brand-link" href="/"><span className="brand-mark"><BriefcaseBusiness aria-hidden /></span>Job Seeker</Link>
      <nav className="side-links" aria-label="Primary">
        {primary.map((link) => <NavLink key={link.href} {...link} pathname={pathname} />)}
        {secondary.map((group) => <div key={group.group}><div className="group">{group.group}</div>{group.links.map((link) => <NavLink key={link.href} {...link} pathname={pathname} />)}</div>)}
      </nav>
      {showLogout && <div className="side-foot"><form action="/api/auth/logout" method="post"><button className="tab" type="submit" style={{ width: "100%" }}><LogOut aria-hidden /><span>Log out</span></button></form></div>}
    </aside>
    <nav className="tabbar" aria-label="Primary">
      {primary.map((link) => <NavLink key={link.href} {...link} pathname={pathname} />)}
      <NavLink href="/more" label="More" icon={Menu} pathname={pathname} />
    </nav>
  </>;
}
