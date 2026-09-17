"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = { name: string; label: string; initial: string[]; limit: number; placeholder?: string; hint?: string };

/** One value at a time: chips with a remove button, an input that adds on Enter, and hidden inputs that submit the list. */
export function TokenField({ name, label, initial, limit, placeholder, hint }: Props) {
  const [values, setValues] = useState(initial);
  const [draft, setDraft] = useState("");
  const id = `token-${name}`;
  function add() {
    const text = draft.trim().replace(/\s+/g, " ");
    if (!text) return;
    if (!values.some((value) => value.toLowerCase() === text.toLowerCase()) && values.length < limit) setValues([...values, text]);
    setDraft("");
  }
  return <div>
    <label className="label" htmlFor={id}>{label}{values.length ? <span className="opt"> · {values.length}</span> : null}</label>
    {values.length > 0 && <div className="tokens" style={{ marginBottom: 4 }}>{values.map((value) => <span className="token" key={value}><input type="hidden" name={name} value={value} /><span>{value}</span><button type="button" aria-label={`Remove ${value}`} onClick={() => setValues(values.filter((item) => item !== value))}><X aria-hidden /></button></span>)}</div>}
    <div className="token-add">
      <input id={id} className="field" value={draft} placeholder={placeholder} maxLength={120} disabled={values.length >= limit} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }} />
      <Button type="button" className="btn-secondary" onClick={add} disabled={!draft.trim() || values.length >= limit} aria-label={`Add ${label.toLowerCase()}`}><Plus aria-hidden />Add</Button>
    </div>
    {hint && <p className="hint">{hint}</p>}
  </div>;
}
