import { Disclosure } from "@/components/disclosure";
import { Markdown } from "@/components/markdown";
import { formatShortDate } from "@/lib/format";

type Request = { id: string; text: string; status: "open" | "in_progress" | "answered" | "failed"; responseMd: string | null; errorMd: string | null; createdAt: Date; answeredAt: Date | null };

export function QaList({ requests, limit = 6 }: { requests: Request[]; limit?: number }) {
  if (!requests.length) return null;
  return <div className="qa">{requests.slice(0, limit).map((request) => <div className="qa-item" key={request.id}>
    {request.status === "answered" && request.responseMd
      ? <Disclosure quiet title={<span className="qa-q">{request.text}</span>} meta={formatShortDate(request.answeredAt ?? request.createdAt)}><Markdown className="compact" content={request.responseMd} /></Disclosure>
      : <><div className="qa-q">{request.text}</div><div className="qa-status">{request.status === "failed" ? `Failed · ${request.errorMd ?? "no details"}` : request.status === "in_progress" ? "An agent is working on it" : "Waiting for an agent"}</div></>}
  </div>)}</div>;
}
