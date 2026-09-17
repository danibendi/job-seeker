"use client";

import { Button } from "@/components/ui/button";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return <div className="card card-pad" style={{ marginTop: 40 }}>
    <h1 style={{ fontSize: 22 }}>Something went wrong</h1>
    <p className="muted" style={{ margin: "6px 0 14px" }}>Nothing was lost. Try again, or go back.</p>
    <Button className="btn-primary" type="button" onClick={reset}>Try again</Button>
  </div>;
}
