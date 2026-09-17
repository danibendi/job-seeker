"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { safeInternalPath } from "@/lib/safe-redirect";

export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => { setReady(true); }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true); setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: form.get("password") }) });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) { setError(body.error || "Something went wrong. Please try again."); setPending(false); return; }
    router.replace(safeInternalPath(search.get("next"))); router.refresh();
  }
  return <form method="post" onSubmit={submit}><label className="label" htmlFor="password">Password</label><Input id="password" name="password" type="password" autoComplete="current-password" autoFocus required /><Button className="btn-primary btn-block" style={{ marginTop: 12 }} disabled={!ready || pending}>{pending ? "Opening…" : "Open Job Seeker"}</Button>{error && <div className="error" role="alert">{error}</div>}</form>;
}
