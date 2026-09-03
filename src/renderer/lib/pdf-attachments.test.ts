import { describe, expect, it } from "vitest";
import {
  MAX_PDF_BYTES,
  PdfAttachmentError,
  isPdfFile,
  loadPdfDocument,
  pdfErrorCode,
  pdfPageAttachmentId,
  pdfPageScale,
  pdfPageSelection,
  validatePdfFile,
  validatePdfPageCount,
} from "./pdf-attachments";

function pdfFile(name = "report.pdf", type = "application/pdf", contents = "%PDF-1.7"): File {
  return new File([contents], name, { type, lastModified: 123 });
}

describe("PDF attachments", () => {
  it("accepts PDF names and MIME types while rejecting mismatches", () => {
    expect(isPdfFile(pdfFile())).toBe(true);
    expect(isPdfFile(pdfFile("report.pdf", ""))).toBe(true);
    expect(isPdfFile(pdfFile("report.txt"))).toBe(false);
    expect(isPdfFile(pdfFile("report.pdf", "text/plain"))).toBe(false);
  });

  it("enforces file-size and page-count limits", () => {
    expect(() => validatePdfFile({ name: "large.pdf", type: "application/pdf", size: MAX_PDF_BYTES + 1 } as File))
      .toThrowError(new PdfAttachmentError("tooLarge"));
    expect(() => validatePdfPageCount(200)).not.toThrow();
    expect(() => validatePdfPageCount(201)).toThrowError(new PdfAttachmentError("tooManyPages"));
  });

  it("rejects files whose contents do not have a PDF header", async () => {
    await expect(loadPdfDocument(pdfFile("fake.pdf", "application/pdf", "plain text")))
      .rejects.toEqual(new PdfAttachmentError("invalidType"));
  });

  it("maps password errors to an explicit rejection", () => {
    expect(pdfErrorCode({ name: "PasswordException" })).toBe("passwordProtected");
  });

  it("calculates rendering scale and stable page attachment IDs", () => {
    expect(pdfPageScale(600, 900, 1800)).toBe(2);
    expect(pdfPageAttachmentId(pdfFile(), 3)).toBe("pdf:report.pdf:8:123:3");
  });

  it("shares the eight-attachment limit and prevents duplicate pages", () => {
    const file = pdfFile();
    const page = { id: pdfPageAttachmentId(file, 3), fileName: "page 3", mimeType: "image/jpeg", data: "" } as const;
    const otherImages = Array.from({ length: 7 }, (_, index) => ({ ...page, id: `image-${index}` }));
    expect(pdfPageSelection(file, 3, [page, ...otherImages], 8)).toEqual({
      isSelected: true,
      selectedCount: 1,
      limitReached: true,
    });
  });
});
