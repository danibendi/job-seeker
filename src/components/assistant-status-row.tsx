import Link from "next/link";
import { Bot, ChevronRight } from "lucide-react";
import type { AssistantStatus } from "@/lib/assistant-status";

export function AssistantStatusRow({
  status,
  href,
  variant = "home",
}: {
  status: AssistantStatus;
  href?: string;
  variant?: "home" | "activity";
}) {
  if (variant === "home" && status.state === "none") return null;

  const content = <>
    <span className={`menu-icon st-${status.tone}`}><Bot aria-hidden /></span>
    <span style={{ minWidth: 0 }}>
      <span className="title">{status.title}</span>
      {status.meta && <span className="meta">{status.meta}</span>}
    </span>
  </>;

  return (
    <div className={`card status-card${variant === "activity" ? " act" : ""}`}>
      <div className="list">
        {href ? (
          <Link className="row interactive" href={href}>
            {content}
            <ChevronRight className="chev" aria-hidden />
          </Link>
        ) : (
          <div className="row plain-icon">{content}</div>
        )}
      </div>
    </div>
  );
}
