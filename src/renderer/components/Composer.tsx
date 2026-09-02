import { ArrowUp, ImagePlus, Square } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";
import type { ContextState, ImageAttachment } from "@shared/contracts";
import { ImageGallery } from "./ImageGallery";

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
  onSend: (message: string, images: ImageAttachment[]) => void;
  onStop: () => void;
  onCompact: () => void;
}

function readImage(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) return reject(new Error(`Unsupported image: ${file.name}`));
    if (file.size > MAX_IMAGE_BYTES) return reject(new Error(`${file.name} exceeds the 10MB limit.`));
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image."));
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
    if ((!message && images.length === 0) || !props.modelReady) return;
    setText("");
    setImages([]);
    props.onSend(message, images);
  };

  const processImages = async (files: File[]): Promise<void> => {
    try {
      const added = await Promise.all(files.map(readImage));
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
    ? `${props.context.percent === null ? "?" : Math.round(props.context.percent)}% · ${props.context.tokens === null ? "?" : Math.round(props.context.tokens / 1000)}k/${Math.round(props.context.contextWindow / 1000)}k`
    : "Context unavailable";

  return (
    <footer className="composer-area">
      <div className={`composer ${props.isStreaming ? "working" : ""}`}>
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
          placeholder={props.modelReady ? "Ask pi to work on this project…" : "Configure a pi model to begin"}
          disabled={!props.modelReady}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-label="Message pi"
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => void addImages(event)} />
            <button className="composer-tool-button" onClick={() => inputRef.current?.click()} disabled={!props.modelReady} aria-label="Attach images" title="Attach images"><ImagePlus size={15} /></button>
            <button className="context-button" onClick={props.onCompact} disabled={props.isStreaming || props.context.isCompacting || !props.context.contextWindow} title="Compact conversation context">
              {props.context.isCompacting ? "Compacting…" : contextLabel}
            </button>
          </div>
          <span>{props.isStreaming ? (props.pendingCount ? `${props.pendingCount} queued` : "pi is working") : "Enter to send · Shift Enter for newline"}</span>
          {props.isStreaming ? (
            <button className="send-button stop" onClick={props.onStop} aria-label="Stop agent"><Square size={12} fill="currentColor" /></button>
          ) : (
            <button className="send-button" onClick={submit} disabled={(!text.trim() && images.length === 0) || !props.modelReady} aria-label="Send message"><ArrowUp size={17} /></button>
          )}
        </div>
      </div>
      <div className="composer-note">pi can make mistakes. Review commands and file changes.</div>
    </footer>
  );
}
