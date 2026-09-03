import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ImageAttachment } from "@shared/contracts";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_PDF_PAGES = 200;
export const PDF_RENDER_EDGE = 1800;
export const PDF_JPEG_QUALITY = 0.88;

export interface LoadedPdfDocument {
  document: PDFDocumentProxy;
  destroy: () => Promise<void>;
}

export type PdfErrorCode = "invalidType" | "tooLarge" | "tooManyPages" | "passwordProtected" | "loadFailed" | "renderFailed";

export class PdfAttachmentError extends Error {
  constructor(readonly code: PdfErrorCode) {
    super(code);
    this.name = "PdfAttachmentError";
  }
}

export function isPdfFile(file: File): boolean {
  const mimeTypeValid = file.type === "" || file.type === "application/pdf" || file.type === "application/x-pdf";
  return file.name.toLowerCase().endsWith(".pdf") && mimeTypeValid;
}

export function validatePdfFile(file: File): void {
  if (!isPdfFile(file)) throw new PdfAttachmentError("invalidType");
  if (file.size > MAX_PDF_BYTES) throw new PdfAttachmentError("tooLarge");
}

export function validatePdfPageCount(pageCount: number): void {
  if (pageCount > MAX_PDF_PAGES) throw new PdfAttachmentError("tooManyPages");
}

function pdfAttachmentPrefix(file: File): string {
  return `pdf:${file.name}:${file.size}:${file.lastModified}:`;
}

export function pdfPageAttachmentId(file: File, pageNumber: number): string {
  return `${pdfAttachmentPrefix(file)}${pageNumber}`;
}

export function pdfPageSelection(
  file: File,
  pageNumber: number,
  attachments: ImageAttachment[],
  maximumAttachments: number,
): { isSelected: boolean; selectedCount: number; limitReached: boolean } {
  const attachmentId = pdfPageAttachmentId(file, pageNumber);
  return {
    isSelected: attachments.some((attachment) => attachment.id === attachmentId),
    selectedCount: attachments.filter((attachment) => attachment.id.startsWith(pdfAttachmentPrefix(file))).length,
    limitReached: attachments.length >= maximumAttachments,
  };
}

export function pdfPageScale(width: number, height: number, maxEdge: number): number {
  return maxEdge / Math.max(width, height);
}

export function pdfErrorCode(error: unknown): PdfErrorCode {
  if (error instanceof PdfAttachmentError) return error.code;
  if (typeof error === "object" && error !== null && "name" in error && error.name === "PasswordException") {
    return "passwordProtected";
  }
  return "loadFailed";
}

export async function loadPdfDocument(file: File): Promise<LoadedPdfDocument> {
  validatePdfFile(file);
  const source = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder("ascii").decode(source.subarray(0, 5)) !== "%PDF-") {
    throw new PdfAttachmentError("invalidType");
  }
  // Keep the large parser lazy and point it at the locally bundled worker so PDF contents never require a CDN.
  const pdf = await import("pdfjs-dist");
  pdf.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdf.getDocument({ data: source, enableXfa: false });
  // The MVP deliberately has no password flow, so reject on the first password request instead of leaving loading suspended.
  const passwordRequest = new Promise<never>((_resolve, reject) => {
    loadingTask.onPassword = () => {
      reject(new PdfAttachmentError("passwordProtected"));
      void loadingTask.destroy().catch(() => undefined);
    };
  });
  try {
    const document = await Promise.race([loadingTask.promise, passwordRequest]);
    try {
      validatePdfPageCount(document.numPages);
    } catch (error) {
      await loadingTask.destroy();
      throw error;
    }
    return { document, destroy: () => loadingTask.destroy() };
  } catch (error) {
    if (pdfErrorCode(error) === "passwordProtected") throw new PdfAttachmentError("passwordProtected");
    throw error;
  }
}

export async function renderPdfPage(
  document: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  options: { maxEdge: number; signal?: AbortSignal },
): Promise<void> {
  const page = await document.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: pdfPageScale(baseViewport.width, baseViewport.height, options.maxEdge) });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const renderTask = page.render({ canvas, viewport });
  const cancel = (): void => renderTask.cancel();
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    await renderTask.promise;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    page.cleanup();
  }
}

export async function renderPdfPageAttachment(
  document: PDFDocumentProxy,
  file: File,
  pageNumber: number,
  fileName: string,
): Promise<ImageAttachment> {
  const canvas = window.document.createElement("canvas");
  try {
    await renderPdfPage(document, pageNumber, canvas, { maxEdge: PDF_RENDER_EDGE });
    const dataUrl = canvas.toDataURL("image/jpeg", PDF_JPEG_QUALITY);
    return {
      id: pdfPageAttachmentId(file, pageNumber),
      fileName,
      mimeType: "image/jpeg",
      data: dataUrl.slice(dataUrl.indexOf(",") + 1),
    };
  } catch (error) {
    throw error instanceof PdfAttachmentError ? error : new PdfAttachmentError("renderFailed");
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
