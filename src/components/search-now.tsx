"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Search } from "lucide-react";
import { queueSearchNow } from "@/lib/actions";
import { Button } from "@/components/ui/button";

export function SearchNow({ queued, className = "btn-secondary btn-sm" }: { queued: boolean; className?: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  if (queued) return <span className="pill brand"><Check aria-hidden />Search queued</span>;
  return <>
    <Button className={className} type="button" disabled={pending} onClick={async () => {
      setError("");
      setPending(true);
      try {
        await queueSearchNow();
        router.refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not queue a search");
      } finally {
        setPending(false);
      }
    }}><Search aria-hidden />{pending ? "Queueing…" : "Search now"}</Button>
    {error && <span className="error tiny" role="alert">{error}</span>}
  </>;
}
