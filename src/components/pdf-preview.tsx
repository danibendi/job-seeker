"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";

export function PdfPreview({ url, title }: { url: string; title: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState("");
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    setError(""); setDocument(null); setPage(1);
    void import("pdfjs-dist").then((pdfjs) => {
      if (cancelled) return;
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      const loading = pdfjs.getDocument({ url });
      cleanup = () => { void loading.destroy(); };
      return loading.promise.then((doc) => { if (!cancelled) setDocument(doc); });
    }).catch(() => { if (!cancelled) setError("Preview unavailable. Download the PDF to view it."); });
    return () => { cancelled = true; cleanup?.(); };
  }, [url]);

  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    let cancelRender: (() => void) | undefined;
    setRendered(false);
    void document.getPage(page).then((pdfPage) => {
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      const viewport = pdfPage.getViewport({ scale: 1.6 * zoom });
      canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
      const rendering = pdfPage.render({ canvas, viewport });
      cancelRender = () => rendering.cancel();
      return rendering.promise.then(() => { if (!cancelled) setRendered(true); });
    }).catch((cause: { name?: string }) => { if (!cancelled && cause?.name !== "RenderingCancelledException") setError("Preview unavailable. Download the PDF to view it."); });
    return () => { cancelled = true; cancelRender?.(); };
  }, [document, page, zoom]);

  return <div className="pdf">
    <div className="pdf-bar">
      <button type="button" className="icon-btn" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}><ChevronLeft aria-hidden /></button>
      <span className="num" aria-live="polite">{document ? `${page} / ${document.numPages}` : "Loading…"}</span>
      <button type="button" className="icon-btn" aria-label="Next page" disabled={!document || page >= document.numPages} onClick={() => setPage((current) => current + 1)}><ChevronRight aria-hidden /></button>
      <span className="spacer" />
      <button type="button" className="icon-btn" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((current) => Math.max(1, current - 0.25))}><ZoomOut aria-hidden /></button>
      <button type="button" className="icon-btn" aria-label="Zoom in" disabled={zoom >= 2} onClick={() => setZoom((current) => Math.min(2, current + 0.25))}><ZoomIn aria-hidden /></button>
    </div>
    {error ? <p className="empty" role="status">{error}</p> : <div className="pdf-scroll"><canvas ref={canvasRef} role="img" aria-label={`${title}, page ${page}`} data-rendered={rendered} style={{ width: `${zoom * 100}%`, visibility: rendered ? "visible" : "hidden" }} /></div>}
  </div>;
}
