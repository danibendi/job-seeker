"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SubmitButton } from "@/components/submit-button";

type Props = {
  action: (form: FormData) => Promise<void>;
  children: React.ReactNode;
  label?: string;
  pendingLabel?: string;
  buttonClass?: string;
  className?: string;
  onSaved?: () => void;
  footer?: React.ReactNode;
};

/** A form that reports "Saved" or the server error inline instead of navigating away. */
export function SaveForm({ action, children, label = "Save", pendingLabel = "Saving…", buttonClass = "btn-primary", className = "", onSaved, footer }: Props) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  return <form
    className={className}
    onChange={() => setMessage("")}
    action={async (form) => {
      setMessage("");
      try { await action(form); setFailed(false); setMessage("Saved"); onSaved?.(); router.refresh(); } catch (cause) { setFailed(true); setMessage(cause instanceof Error ? cause.message : "That did not save. Please retry."); }
    }}
  >
    {children}
    <div className="settings-foot">
      <SubmitButton className={buttonClass} pendingLabel={pendingLabel}>{label}</SubmitButton>
      {footer}
      <span role="status" className={`status ${failed ? "bad" : ""}`}>{message}</span>
    </div>
  </form>;
}
