import { ChevronLeft, ChevronRight, FileText, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ImageAttachment } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";
import type { MessageKey } from "../i18n/messages";
import {
  loadPdfDocument,
  pdfErrorCode,
  pdfPageSelection,
  renderPdfPage,
  renderPdfPageAttachment,
  type LoadedPdfDocument,
  type PdfErrorCode,
} from "../lib/pdf-attachments";

interface PdfAttachmentPanelProps {
  file: File;
  attachments: ImageAttachment[];
  maximumAttachments: number;
  disabled: boolean;
  onAdd: (attachment: ImageAttachment) => void;
  onClose: () => void;
}

const PREVIEW_EDGE = 900;
const PDF_ERROR_MESSAGES: Record<PdfErrorCode, MessageKey> = {
  invalidType: "pdf.error.invalidType",
  tooLarge: "pdf.error.tooLarge",
  tooManyPages: "pdf.error.tooManyPages",
  passwordProtected: "pdf.error.passwordProtected",
  loadFailed: "pdf.error.loadFailed",
  renderFailed: "pdf.error.renderFailed",
};

export function PdfAttachmentPanel(props: PdfAttachmentPanelProps) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loadedPdf, setLoadedPdf] = useState<LoadedPdfDocument | null>(null);
  const document = loadedPdf?.document ?? null;
  const [pageNumber, setPageNumber] = useState(1);
  const [error, setError] = useState<PdfErrorCode | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const selection = pdfPageSelection(props.file, pageNumber, props.attachments, props.maximumAttachments);
  useEffect(() => {
    let disposed = false;
    let loadedDocument: LoadedPdfDocument | null = null;
    setLoadedPdf(null);
    setPageNumber(1);
    setError(null);
    void loadPdfDocument(props.file).then((nextDocument) => {
      loadedDocument = nextDocument;
      if (disposed) void nextDocument.destroy().catch(() => undefined);
      else setLoadedPdf(nextDocument);
    }).catch((reason: unknown) => {
      if (!disposed) setError(pdfErrorCode(reason));
    });
    return () => {
      disposed = true;
      if (loadedDocument) void loadedDocument.destroy().catch(() => undefined);
    };
  }, [props.file]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!document || !canvas) return;
    // Cancel stale page renders when the user navigates quickly or closes the PDF.
    const controller = new AbortController();
    setIsRendering(true);
    setError(null);
    void renderPdfPage(document, pageNumber, canvas, { maxEdge: PREVIEW_EDGE, signal: controller.signal })
      .catch((reason: unknown) => {
        const code = pdfErrorCode(reason);
        if (!controller.signal.aborted) setError(code === "loadFailed" ? "renderFailed" : code);
      })
      .finally(() => { if (!controller.signal.aborted) setIsRendering(false); });
    return () => controller.abort();
  }, [document, pageNumber]);
  const changePage = (nextPage: number): void => {
    if (!document) return;
    setPageNumber(Math.min(document.numPages, Math.max(1, nextPage)));
  };

  const addPage = async (): Promise<void> => {
    if (!document || selection.isSelected || selection.limitReached) return;
    setIsAdding(true);
    try {
      const fileName = t("pdf.pageAttachmentName", { name: props.file.name, page: pageNumber });
      props.onAdd(await renderPdfPageAttachment(document, props.file, pageNumber, fileName));
    } catch (reason) {
      setError(pdfErrorCode(reason));
    } finally {
      setIsAdding(false);
    }
  };

  const pageCount = document?.numPages ?? 0;
  return (
    <section className="pdf-panel" aria-label={t("pdf.preview", { name: props.file.name })}>
      <header className="pdf-panel-header">
        <FileText size={15} />
        <strong title={props.file.name}>{props.file.name}</strong>
        {document && <span>{t("pdf.pageCount", { count: document.numPages })}</span>}
        <button type="button" onClick={props.onClose} aria-label={t("pdf.close")}><X size={14} /></button>
      </header>
      <div className="pdf-preview">
        {!document && !error && <span>{t("pdf.loading")}</span>}
        <canvas ref={canvasRef} hidden={!document || Boolean(error)} />
        {isRendering && document && !error && <span className="pdf-rendering">{t("pdf.rendering")}</span>}
        {error && <div className="pdf-error" role="alert">{t(PDF_ERROR_MESSAGES[error])}</div>}
      </div>
      {document && !error && (
        <footer className="pdf-controls">
          <button type="button" onClick={() => changePage(pageNumber - 1)} disabled={pageNumber <= 1} aria-label={t("pdf.previous")}><ChevronLeft size={15} /></button>
          <label>
            <span className="sr-only">{t("pdf.page")}</span>
            <input type="number" min={1} max={pageCount} value={pageNumber} onChange={(event) => changePage(Number(event.target.value))} />
            <span>/ {pageCount}</span>
          </label>
          <button type="button" onClick={() => changePage(pageNumber + 1)} disabled={pageNumber >= pageCount} aria-label={t("pdf.next")}><ChevronRight size={15} /></button>
          <span className="pdf-selected-count">{t("pdf.selected", { count: selection.selectedCount })}</span>
          <button
            type="button"
            className="pdf-add-page"
            onClick={() => void addPage()}
            disabled={props.disabled || selection.isSelected || selection.limitReached || isAdding || isRendering}
          >
            <Plus size={14} />
            {selection.isSelected ? t("pdf.pageSelected") : selection.limitReached ? t("pdf.limitReached") : t("pdf.addPage")}
          </button>
        </footer>
      )}
    </section>
  );
}
