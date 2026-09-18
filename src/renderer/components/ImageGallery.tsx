import { useEffect, useMemo, useState, type AnimationEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { ConversationImage } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";

interface ImageGalleryProps {
  images: ConversationImage[];
  variant: "composer" | "message";
  onRemove?: (id: string) => void;
}

function inlineSource(image: ConversationImage): string | null {
  return image.data ? `data:${image.mimeType};base64,${image.data}` : null;
}

function inlineSources(images: ConversationImage[]): Map<string, string> {
  return new Map(images.flatMap((image) => {
    const source = inlineSource(image);
    return source ? [[image.id, source] as const] : [];
  }));
}

function useImageSources(images: ConversationImage[]): ReadonlyMap<string, string> {
  const [loadedSources, setLoadedSources] = useState<ReadonlyMap<string, string>>(() => inlineSources(images));
  useEffect(() => {
    let disposed = false;
    const objectUrls: string[] = [];
    const initial = inlineSources(images);
    setLoadedSources(initial);
    for (const image of images) {
      if (!image.sourceId || initial.has(image.id)) continue;
      void window.piDesktop.getConversationImage(image.sourceId).then((payload) => {
        if (disposed) return;
        const bytes = Uint8Array.from(payload.data);
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType }));
        objectUrls.push(objectUrl);
        setLoadedSources((current) => new Map(current).set(image.id, objectUrl));
      }).catch(() => undefined);
    }
    return () => {
      disposed = true;
      for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
    };
  }, [images]);
  return loadedSources;
}

export function ImageGallery({ images, variant, onRemove }: ImageGalleryProps) {
  const { t } = useI18n();
  const sources = useImageSources(images);
  // active keeps the lightbox mounted while its close animation plays, mirroring ToolExecutionPanelPresence.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const active = useMemo(() => images.find((image) => image.id === activeId) ?? null, [activeId, images]);
  const activeSource = active ? sources.get(active.id) : undefined;

  useEffect(() => {
    if (!active) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setClosing(true);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [active]);

  const dismiss = (): void => setClosing(true);

  const reopen = (image: ConversationImage): void => {
    if (!sources.has(image.id)) return;
    setClosing(false);
    setActiveId(image.id);
  };

  const finishClose = (event: AnimationEvent<HTMLDivElement>): void => {
    if (event.animationName !== "overlay-close") return;
    setActiveId(null);
    setClosing(false);
  };

  return (
    <>
      <div className={variant === "composer" ? "image-strip" : "message-images"}>
        {images.map((image) => {
          const imageSource = sources.get(image.id);
          return (
            <div className={variant === "composer" ? "image-chip" : "message-image"} key={image.id}>
              <button
                className="image-preview-button"
                disabled={!imageSource}
                onClick={() => reopen(image)}
                aria-label={t("image.preview", { name: image.fileName })}
              >
                {imageSource ? <img src={imageSource} alt={image.fileName} /> : <span className="image-loading" aria-hidden="true" />}
                {variant === "composer" && <span>{image.fileName}</span>}
              </button>
              {onRemove && (
                <button className="image-remove-button" onClick={() => onRemove(image.id)} aria-label={t("image.remove", { name: image.fileName })}>
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {active && activeSource && createPortal(
        <div
          className={`image-lightbox ${closing ? "closing" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={t("image.preview", { name: active.fileName })}
          onClick={dismiss}
          onAnimationEnd={finishClose}
        >
          <button className="image-lightbox-close" onClick={dismiss} aria-label={t("image.close")}><X size={18} /></button>
          <img src={activeSource} alt={active.fileName} onClick={(event) => event.stopPropagation()} />
        </div>,
        document.body,
      )}
    </>
  );
}
