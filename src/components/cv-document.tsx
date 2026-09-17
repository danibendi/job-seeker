"use client";

import { useState } from "react";
import { updateCvContent } from "@/lib/actions";
import type { CvBlock } from "@/lib/cv-document";
import { Sheet } from "@/components/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";

type Change = { id: string; current: string; proposed: string; decision: "pending" | "accepted" | "rejected" };
type Variant = { id: string; slug: string; version: number };

export function CvDocument({ variant, blocks, changes }: { variant: Variant; blocks: CvBlock[]; changes: Change[] }) {
  const [editing, setEditing] = useState<{ index: number; raw: string } | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  function highlight(raw: string) {
    const change = changes.find((item) => item.decision !== "rejected" && item.current && raw.includes(item.current.trim()));
    if (!change) return "";
    return change.decision === "accepted" ? "accepted" : "pending";
  }

  async function save(form: FormData) {
    setPending(true); setError("");
    try {
      await updateCvContent(form);
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not save. Please retry.");
    } finally {
      setPending(false);
    }
  }

  const occurrence = editing ? blocks.slice(0, editing.index).filter((block) => block.raw === editing.raw).length : 0;
  const editable = (index: number, block: CvBlock, className: string, children: React.ReactNode) => (
    <button type="button" key={index} className={`cv-block editable ${className} ${highlight(block.raw)}`} onClick={() => setEditing({ index, raw: block.raw })} title="Tap to edit">{children}</button>
  );

  let sectionOpen = false;
  const elements: React.ReactNode[] = [];
  let sectionChildren: React.ReactNode[] = [];
  let sectionKey = 0;
  const flush = () => { if (sectionOpen) { elements.push(<div className="cv-section" key={`section-${sectionKey++}`}>{sectionChildren}</div>); sectionChildren = []; sectionOpen = false; } };
  blocks.forEach((block, index) => {
    switch (block.kind) {
      case "name": flush(); elements.push(editable(index, block, "cv-name", block.text)); break;
      case "headline": elements.push(editable(index, block, "cv-headline", block.text)); break;
      case "contact": elements.push(editable(index, block, "cv-contact", block.text)); break;
      case "section": flush(); sectionOpen = true; sectionChildren.push(<div className="cv-section-title" key={`title-${index}`}>{block.text}</div>); break;
      case "entry-title": sectionChildren.push(<div className="cv-entry" key={`entry-${index}`}>{editable(index, block, "cv-entry-title", block.text)}</div>); break;
      case "entry-sub": sectionChildren.push(editable(index, block, "cv-entry-sub", block.text)); break;
      case "competency": sectionChildren.push(editable(index, block, "cv-competency", <><b>{block.label}:</b> {block.text}</>)); break;
      case "bullet": sectionChildren.push(editable(index, block, "cv-bullet", block.text)); break;
      default: (sectionOpen ? sectionChildren : elements).push(editable(index, block, "", block.text));
    }
  });
  flush();

  return <>
    <article className="cv-paper">{elements}</article>
    <Sheet open={Boolean(editing)} onClose={() => setEditing(null)} title="Edit text" initialFocus="textarea">
      {editing && <form action={save}>
        <input type="hidden" name="variantId" value={variant.id} />
        <input type="hidden" name="slug" value={variant.slug} />
        <input type="hidden" name="version" value={variant.version} />
        <input type="hidden" name="oldText" value={editing.raw} />
        <input type="hidden" name="occurrence" value={occurrence} />
        <Textarea name="newText" defaultValue={editing.raw} required style={{ minHeight: 140 }} aria-label="Text" />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="sheet-actions"><Button className="btn-secondary" type="button" onClick={() => setEditing(null)}>Cancel</Button><Button className="btn-primary" disabled={pending}>{pending ? "Saving…" : "Save"}</Button></div>
      </form>}
    </Sheet>
  </>;
}
