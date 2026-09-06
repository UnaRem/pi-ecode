import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";
import type { ContextState, ExtensionUiRequest, ExtensionUiResponse, ImageAttachment, PastedTextAttachment, WorkspaceHistoryState } from "@shared/contracts";
import { createPastedTextAttachment, parsePastedTexts, serializePastedTexts, shouldAttachPastedText } from "@shared/pasted-text";
import { ComposerView, MAX_ATTACHMENTS } from "./ComposerView";
import { useI18n, type Translate } from "../i18n/i18n";

const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ComposerProps {
  isStreaming: boolean;
  pendingCount: number;
  modelReady: boolean;
  supportsImages: boolean;
  restoredText: string | null;
  restoredImages: ImageAttachment[];
  restoreVersion: number;
  context: ContextState;
  history: WorkspaceHistoryState;
  extensionUi: ExtensionUiRequest | null;
  onRespondExtensionUi: (response: ExtensionUiResponse) => void;
  onSend: (message: string, images: ImageAttachment[]) => void;
  onStop: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onCompact: () => void;
  onCancelCompact: () => void;
}

function readImage(file: File, t: Translate): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) return reject(new Error(t("composer.unsupportedImage", { name: file.name })));
    if (file.size > MAX_IMAGE_BYTES) return reject(new Error(t("composer.imageTooLarge", { name: file.name })));
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(t("composer.readImageFailed")));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const comma = value.indexOf(",");
      resolve({
        id: crypto.randomUUID(),
        fileName: file.name,
        mimeType: file.type as ImageAttachment["mimeType"],
        data: comma >= 0 ? value.slice(comma + 1) : value,
      });
    };
    reader.readAsDataURL(file);
  });
}

function contextLabel(context: ContextState, t: Translate): string {
  if (!context.contextWindow) return t("composer.contextUnavailable");
  const estimate = context.isEstimated ? "~" : "";
  const percent = context.percent === null ? "?" : Math.round(context.percent);
  const tokens = context.tokens === null ? "?" : Math.round(context.tokens / 1000);
  return `${estimate}${percent}% · ${estimate}${tokens}k/${Math.round(context.contextWindow / 1000)}k`;
}

function clipboardImages(event: ClipboardEvent<HTMLTextAreaElement>): File[] {
  return [...event.clipboardData.items]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function Composer(props: ComposerProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [pastedTexts, setPastedTexts] = useState<PastedTextAttachment[]>([]);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (props.restoredText !== null) {
      const restored = parsePastedTexts(props.restoredText);
      setText(restored.message);
      setPastedTexts(restored.attachments);
    }
    setImages(props.restoredImages);
    if (props.restoredText !== null || props.restoredImages.length > 0) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [props.restoreVersion]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = text ? "0px" : "35px";
    if (text) textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [text]);

  const submit = (): void => {
    const message = serializePastedTexts(text, pastedTexts);
    if ((!message && images.length === 0) || !props.modelReady || props.extensionUi) return;
    if (images.length > 0 && !props.supportsImages) {
      setAttachmentError(t("composer.attachUnsupported"));
      return;
    }
    setText("");
    setImages([]);
    setPastedTexts([]);
    setPdfFile(null);
    props.onSend(message, images);
  };

  const processImages = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    if (!props.supportsImages) {
      setAttachmentError(t("composer.attachUnsupported"));
      return;
    }
    try {
      const added = await Promise.all(files.map((file) => readImage(file, t)));
      if (images.length + pastedTexts.length + added.length > MAX_ATTACHMENTS) throw new Error(t("composer.attachmentLimit"));
      setImages((current) => [...current, ...added]);
      setAttachmentError(null);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    }
  };

  const addAttachments = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    const pdfFiles = files.filter((file) => file.name.toLowerCase().endsWith(".pdf"));
    if (pdfFiles.length > 1) {
      setAttachmentError(t("pdf.oneAtATime"));
      return;
    }
    if (pdfFiles[0]) setPdfFile(pdfFiles[0]);
    await processImages(files.filter((file) => ACCEPTED_IMAGE_TYPES.has(file.type)));
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = clipboardImages(event);
    if (files.length > 0) {
      event.preventDefault();
      void processImages(files);
      return;
    }
    const content = event.clipboardData.getData("text/plain");
    if (!shouldAttachPastedText(content)) return;
    event.preventDefault();
    if (images.length + pastedTexts.length >= MAX_ATTACHMENTS) {
      setAttachmentError(t("composer.attachmentLimit"));
      return;
    }
    setPastedTexts((current) => [...current, createPastedTextAttachment(crypto.randomUUID(), content)]);
    setAttachmentError(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return <ComposerView
    agent={props} text={text} images={images} pastedTexts={pastedTexts} pdfFile={pdfFile} attachmentError={attachmentError}
    contextLabel={contextLabel(props.context, t)} textareaRef={textareaRef} inputRef={inputRef}
    onTextChange={setText} onKeyDown={onKeyDown} onPaste={onPaste}
    onAddAttachments={(event) => void addAttachments(event)}
    onRemoveImage={(id) => setImages((current) => current.filter((item) => item.id !== id))}
    onRemovePastedText={(id) => setPastedTexts((current) => current.filter((item) => item.id !== id))}
    onAddPdfPage={(attachment) => { setImages((current) => [...current, attachment]); setAttachmentError(null); }}
    onClosePdf={() => setPdfFile(null)} onSubmit={submit}
  />;
}
