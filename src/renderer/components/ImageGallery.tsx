import { useEffect, useMemo, useRef, useState, type AnimationEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { ConversationImage } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";
import { useAnimatedList } from "../hooks/use-animated-list";

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
        if (disposed || !payload) return;
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
  const { renderedItems, leavingIds, beginRemove, finishRemove } = useAnimatedList(images);
  const sources = useImageSources(renderedItems);
  // Keep the lightbox mounted until its visual exit completes.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const active = useMemo(() => renderedItems.find((image) => image.id === activeId) ?? null, [activeId, renderedItems]);
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

  const reopen = (image: ConversationImage, opener: HTMLButtonElement): void => {
    if (!sources.has(image.id)) return;
    openerRef.current = opener;
    setClosing(false);
    setActiveId(image.id);
  };

  const finishClose = (event: AnimationEvent<HTMLDivElement>): void => {
    if (event.animationName !== "overlay-close") return;
    setActiveId(null);
    setClosing(false);
    requestAnimationFrame(() => openerRef.current?.focus());
  };

  return (
    <>
      <div className={variant === "composer" ? "image-strip" : "message-images"}>
        {renderedItems.map((image) => {
          const imageSource = sources.get(image.id);
          const leaving = leavingIds.has(image.id);
          return (
            <div
              className={`${variant === "composer" ? "image-chip" : "message-image"} attachment-item ${leaving ? "leaving" : ""}`}
              key={image.id}
              inert={leaving ? true : undefined}
              onAnimationEnd={(event) => finishRemove(image.id, event)}
            >
              <button
                className="image-preview-button"
                disabled={!imageSource}
                onClick={(event) => reopen(image, event.currentTarget)}
                aria-label={t("image.preview", { name: image.fileName })}
              >
                {imageSource ? <img src={imageSource} alt={image.fileName} /> : <span className="image-loading" aria-hidden="true" />}
                {variant === "composer" && <span>{image.fileName}</span>}
              </button>
              {onRemove && (
                <button className="image-remove-button" onClick={() => beginRemove(image.id, onRemove)} aria-label={t("image.remove", { name: image.fileName })}>
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
          inert={closing ? true : undefined}
          onClick={dismiss}
          onAnimationEnd={finishClose}
        >
          <button autoFocus className="image-lightbox-close" onClick={dismiss} aria-label={t("image.close")}><X size={18} /></button>
          <img src={activeSource} alt={active.fileName} onClick={(event) => event.stopPropagation()} />
        </div>,
        document.body,
      )}
    </>
  );
}
