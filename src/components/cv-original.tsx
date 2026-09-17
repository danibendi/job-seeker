import { FileText } from "lucide-react";
import { Disclosure } from "@/components/disclosure";
import { PdfPreview } from "@/components/pdf-preview";
import { SaveForm } from "@/components/save-form";
import { Input } from "@/components/ui/input";
import { linkCvOriginal, uploadCvDocument } from "@/lib/actions";
import { formatDate } from "@/lib/format";

type Props = {
  variant: { id: string; name: string };
  document: { fileName: string; updatedAt: Date } | null;
  pdfUrl: string | null;
  drive: { open: string; preview: string } | null;
};

/** The "PDF" view of a CV variant: the uploaded original, or the linked Drive file, plus the forms to change either. */
export function CvOriginal({ variant, document, pdfUrl, drive }: Props) {
  return <div className="stack" style={{ gap: 12 }}>
    {pdfUrl && document
      ? <><PdfPreview url={pdfUrl} title={`${variant.name} PDF`} /><p className="faint tiny" style={{ textAlign: "center" }}>{document.fileName} · uploaded {formatDate(document.updatedAt)}</p></>
      : drive
        ? <iframe className="pdf-frame" src={drive.preview} title={`${variant.name} source file`} allow="fullscreen" />
        : <div className="card empty"><div className="icon"><FileText aria-hidden /></div><strong>No PDF yet</strong><span className="small">Upload the formatted CV or link the Google Drive file.</span></div>}

    <Disclosure title={document ? "Replace PDF" : "Upload PDF"} open={!document && !drive}>
      <SaveForm action={uploadCvDocument} label={document ? "Replace" : "Upload"} pendingLabel="Uploading…" className="stack" buttonClass="btn-primary btn-sm">
        <input type="hidden" name="variantId" value={variant.id} />
        <Input type="file" name="document" accept="application/pdf" required aria-label="PDF file" />
      </SaveForm>
    </Disclosure>
    <Disclosure title={drive ? "Change source link" : "Link source file"}>
      <SaveForm action={linkCvOriginal} label="Save link" className="stack" buttonClass="btn-primary btn-sm">
        <input type="hidden" name="variantId" value={variant.id} />
        <Input name="documentUrl" type="url" inputMode="url" placeholder="https://drive.google.com/file/d/…" defaultValue={drive?.open ?? ""} aria-label="Google Drive or Docs link" />
      </SaveForm>
    </Disclosure>
  </div>;
}
