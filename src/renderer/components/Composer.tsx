import { ArrowUp, ImagePlus, Redo2, Square, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";
import type { ContextState, ExtensionUiRequest, ExtensionUiResponse, ImageAttachment, WorkspaceHistoryState } from "@shared/contracts";
import { ExtensionQuestionPanel } from "./ExtensionQuestionPanel";
import { ImageGallery } from "./ImageGallery";
import { useI18n, type Translate } from "../i18n/i18n";

const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

interface ComposerProps {
  isStreaming: boolean;
  pendingCount: number;
  modelReady: boolean;
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

export function Composer(props: ComposerProps) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (props.restoredText !== null) setText(props.restoredText);
    setImages(props.restoredImages);
    if (props.restoredText !== null || props.restoredImages.length > 0) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [props.restoreVersion]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [text]);

  const submit = (): void => {
    const message = text.trim();
    if ((!message && images.length === 0) || !props.modelReady || props.extensionUi) return;
    setText("");
    setImages([]);
    props.onSend(message, images);
  };

  const processImages = async (files: File[]): Promise<void> => {
    try {
      const added = await Promise.all(files.map((file) => readImage(file, t)));
      setImages((current) => [...current, ...added].slice(0, 8));
      setAttachmentError(null);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    }
  };

  const addImages = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    await processImages(files);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    void processImages(files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const contextLabel = props.context.contextWindow
    ? `${props.context.isEstimated ? "~" : ""}${props.context.percent === null ? "?" : Math.round(props.context.percent)}% · ${props.context.isEstimated ? "~" : ""}${props.context.tokens === null ? "?" : Math.round(props.context.tokens / 1000)}k/${Math.round(props.context.contextWindow / 1000)}k`
    : t("composer.contextUnavailable");

  return (
    <footer className="composer-area">
      {props.extensionUi && (
        <ExtensionQuestionPanel request={props.extensionUi} onRespond={props.onRespondExtensionUi} />
      )}
      <div className={`composer ${props.isStreaming ? "working" : ""} ${props.extensionUi ? "blocked" : ""}`}>
        {images.length > 0 && (
          <ImageGallery
            images={images}
            variant="composer"
            onRemove={(id) => setImages((current) => current.filter((item) => item.id !== id))}
          />
        )}
        {attachmentError && <div className="attachment-error">{attachmentError}</div>}
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          placeholder={props.extensionUi
            ? t("composer.answerAbove")
            : props.modelReady ? t("composer.ask") : t("composer.configureModel")}
          disabled={!props.modelReady || Boolean(props.extensionUi)}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-label={t("composer.message")}
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => void addImages(event)} />
            <button className="composer-tool-button" onClick={() => inputRef.current?.click()} disabled={!props.modelReady || Boolean(props.extensionUi)} aria-label={t("composer.attach")} title={t("composer.attach")}><ImagePlus size={15} /></button>
            <button
              className="composer-tool-button"
              onClick={props.onUndo}
              disabled={props.isStreaming || Boolean(props.extensionUi) || props.history.isBusy || !props.history.canUndo}
              aria-label={t("composer.undo")}
              title={t("composer.undo")}
            ><Undo2 size={15} /></button>
            <button
              className="composer-tool-button"
              onClick={props.onRedo}
              disabled={props.isStreaming || Boolean(props.extensionUi) || props.history.isBusy || !props.history.canRedo}
              aria-label={t("composer.redo")}
              title={t("composer.redo")}
            ><Redo2 size={15} /></button>
            <button
              className={`context-button ${props.context.isCompacting ? "cancel" : ""}`}
              onClick={props.context.isCompacting ? props.onCancelCompact : props.onCompact}
              disabled={Boolean(props.extensionUi) || (!props.context.isCompacting && (props.isStreaming || !props.context.contextWindow))}
              title={props.context.isCompacting ? t("composer.cancelCompact") : t("composer.compact")}
            >
              {props.context.isCompacting ? t("composer.cancelCompact") : contextLabel}
            </button>
          </div>
          <span>{props.extensionUi
            ? t("composer.waitingAnswer")
            : props.isStreaming
              ? (props.pendingCount ? t("composer.steeringCount", { count: props.pendingCount }) : t("composer.steerHint"))
              : t("composer.sendHint")}</span>
          <div className="composer-actions">
            <button
              className={`send-button ${props.isStreaming ? "steer" : ""}`}
              onClick={submit}
              disabled={Boolean(props.extensionUi) || (!text.trim() && images.length === 0) || !props.modelReady}
              aria-label={props.isStreaming ? t("composer.steer") : t("composer.send")}
              title={props.isStreaming ? t("composer.steer") : t("composer.send")}
            >
              <ArrowUp size={17} />
            </button>
            {props.isStreaming && (
              <button className="send-button stop" onClick={props.onStop} aria-label={t("composer.stop")} title={t("composer.stop")}>
                <Square size={12} fill="currentColor" />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="composer-note">{t("composer.note")}</div>
    </footer>
  );
}
