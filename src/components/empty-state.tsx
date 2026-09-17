import { Sparkles } from "lucide-react";

export function EmptyState({ title, children, icon }: { title: string; children?: React.ReactNode; icon?: React.ReactNode }) {
  return <div className="card empty"><div className="icon">{icon ?? <Sparkles aria-hidden />}</div><strong>{title}</strong>{children && <span className="small">{children}</span>}</div>;
}
