import { BackButton } from "@/components/back-button";

export function AppBar({ title, back = "/", actions }: { title: string; back?: string; actions?: React.ReactNode }) {
  return <header className="appbar">
    <BackButton fallback={back} />
    <div className="appbar-title truncate">{title}</div>
    <div className="appbar-actions">{actions}</div>
  </header>;
}
