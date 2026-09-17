"use client";

import { useState } from "react";
import { Check, Copy, Download, ExternalLink, Printer, Send } from "lucide-react";
import { markCvReady } from "@/lib/actions";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";

type Props = {
  variant: { id: string; slug: string; contentMd: string };
  mode: "edit" | "pdf";
  pdfUrl: string | null;
  originalUrl: string | null;
};

export function CvToolbar({ variant, mode, pdfUrl, originalUrl }: Props) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(variant.contentMd);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return <div className="cv-toolbar">
    {mode === "edit" && <>
      <Button className="btn-secondary btn-sm" type="button" onClick={copy}>{copied ? <Check aria-hidden /> : <Copy aria-hidden />}{copied ? "Copied" : "Copy text"}</Button>
      <Button className="btn-secondary btn-sm" type="button" onClick={() => window.print()}><Printer aria-hidden />Print / PDF</Button>
    </>}
    {mode === "pdf" && pdfUrl && <a className="btn btn-secondary btn-sm" href={`${pdfUrl}?download=1`}><Download aria-hidden />Download</a>}
    {mode === "pdf" && originalUrl && <a className="btn btn-secondary btn-sm" href={originalUrl} target="_blank" rel="noreferrer"><ExternalLink aria-hidden />Source file</a>}
    <form action={markCvReady} style={{ marginLeft: "auto" }}><input type="hidden" name="variantId" value={variant.id} /><input type="hidden" name="slug" value={variant.slug} /><SubmitButton className="btn-night btn-sm" pendingLabel="Sending…"><Send aria-hidden />Mark ready</SubmitButton></form>
  </div>;
}
