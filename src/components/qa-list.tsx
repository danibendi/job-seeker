import { Disclosure } from "@/components/disclosure";
import { Markdown } from "@/components/markdown";
import { roleQuestionStatusLabel, type AssistantStatus } from "@/lib/assistant-status";
import { formatShortDate } from "@/lib/format";

type Request = { id: string; text: string; status: "open" | "in_progress" | "answered" | "failed" | "dismissed"; responseMd: string | null; errorMd: string | null; createdAt: Date; answeredAt: Date | null };

export function QaList({
  requests,
  limit = 6,
  assistantStatus,
  interruptedRequestIds = [],
}: {
  requests: Request[];
  limit?: number;
  assistantStatus?: AssistantStatus;
  interruptedRequestIds?: readonly string[];
}) {
  if (!requests.length) return null;
  const interrupted = new Set(interruptedRequestIds);
  return <div className="qa">{requests.slice(0, limit).map((request) => {
    const statusText = assistantStatus
      ? roleQuestionStatusLabel(request, assistantStatus, interrupted)
      : request.status === "failed"
        ? `Failed · ${request.errorMd ?? "no details"}`
        : request.status === "dismissed"
          ? "Dismissed"
          : request.status === "in_progress" && !interrupted.has(request.id)
            ? "An agent is working on it"
            : "Waiting for an agent";
    return <div className="qa-item" key={request.id}>
      {request.status === "answered" && request.responseMd
        ? <Disclosure quiet title={<span className="qa-q">{request.text}</span>} meta={formatShortDate(request.answeredAt ?? request.createdAt)}><Markdown className="compact" content={request.responseMd} /></Disclosure>
        : <><div className="qa-q">{request.text}</div><div className="qa-status">{statusText}</div></>}
    </div>;
  })}</div>;
}
