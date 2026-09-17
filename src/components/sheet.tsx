"use client";

import { useId, useRef } from "react";
import { X } from "lucide-react";
import { useModalFocus } from "@/components/use-modal-focus";

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  initialFocus?: string;
};

export function Sheet({ open, onClose, title, subtitle, children, initialFocus }: Props) {
  const ref = useRef<HTMLElement>(null);
  const id = useId();
  useModalFocus(open, ref, onClose, initialFocus);
  if (!open) return null;
  return <div className="sheet-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="sheet" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={id} onMouseDown={(event) => event.stopPropagation()}>
      <div className="sheet-handle" />
      <div className="between" style={{ alignItems: "flex-start" }}>
        <div><h2 id={id}>{title}</h2>{subtitle && <p className="sub">{subtitle}</p>}</div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><X aria-hidden /></button>
      </div>
      {children}
    </section>
  </div>;
}
