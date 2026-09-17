import { ChevronDown } from "lucide-react";

export function Disclosure({ title, meta, children, open = false, quiet = false, id }: { title: React.ReactNode; meta?: React.ReactNode; children: React.ReactNode; open?: boolean; quiet?: boolean; id?: string }) {
  return <details className={`disclosure ${quiet ? "quiet" : ""}`} open={open} id={id}>
    <summary><span>{title}{meta && <span className="meta">{meta}</span>}</span><ChevronDown className="caret" aria-hidden /></summary>
    <div className="body">{children}</div>
  </details>;
}
