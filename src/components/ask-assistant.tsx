"use client";

import { useRef, useState } from "react";
import { Send } from "lucide-react";
import { createRequest } from "@/lib/actions";
import { Button } from "@/components/ui/button";

export function AskAssistant({ jobId, suggestions, placeholder = "Ask something specific about this role" }: { jobId?: string; suggestions: string[]; placeholder?: string }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function submit(form: FormData) {
    setPending(true); setError(""); setSent(false);
    try {
      await createRequest(form);
      setText(""); setSent(true);
      window.setTimeout(() => setSent(false), 2500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not send. Please retry.");
    } finally {
      setPending(false);
    }
  }

  return <div className="stack" style={{ gap: 8 }}>
    <div className="suggest" aria-label="Suggested questions">{suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => { setText(suggestion); inputRef.current?.focus(); }}>{suggestion}</button>)}</div>
    <form action={submit} className="ask-form">
      {jobId && <input type="hidden" name="jobId" value={jobId} />}
      <textarea ref={inputRef} className="field" name="text" required value={text} onChange={(event) => setText(event.target.value)} placeholder={placeholder} rows={2} style={{ minHeight: 48, fontSize: 15 }} aria-label="Question for your assistant" />
      <Button className="btn-night" disabled={pending || !text.trim()} aria-label="Queue question"><Send aria-hidden />{sent ? "Sent" : pending ? "…" : "Ask"}</Button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
