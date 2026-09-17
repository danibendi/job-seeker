"use client";

import { useState } from "react";
import { ListChecks } from "lucide-react";
import { Sheet } from "@/components/sheet";
import { Button } from "@/components/ui/button";

export function MobileReviewSheet({ pendingCount, title, children }: { pendingCount: number; title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div className="only-mobile" style={{ marginBottom: 12 }}>
    <Button className={pendingCount ? "btn-primary btn-block" : "btn-secondary btn-block"} type="button" onClick={() => setOpen(true)}><ListChecks aria-hidden />{pendingCount ? `Review ${pendingCount} proposed ${pendingCount === 1 ? "change" : "changes"}` : "Proposed changes"}</Button>
    <Sheet open={open} onClose={() => setOpen(false)} title={title} initialFocus="button.btn-good">{children}</Sheet>
  </div>;
}
