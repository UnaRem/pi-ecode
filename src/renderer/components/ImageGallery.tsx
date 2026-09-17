import { useEffect, useState, type AnimationEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { ImageAttachment } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";

interface ImageGalleryProps {
  images: ImageAttachment[];
  variant: "composer" | "message";
  onRemove?: (id: string) => void;
}

function source(image: ImageAttachment): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function ImageGallery({ images, variant, onRemove }: ImageGalleryProps) {
  const { t } = useI18n();
  // active keeps the lightbox mounted while its close animation plays, mirroring ToolExecutionPanelPresence.
  const [active, setActive] = useState<ImageAttachment | null>(null);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (!active) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setClosing(true);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [active]);

  const dismiss = (): void => setClosing(true);

  const reopen = (image: ImageAttachment): void => {
    setClosing(false);
    setActive(image);
  };

  const finishClose = (event: AnimationEvent<HTMLDivElement>): void => {
    if (event.animationName !== "overlay-close") return;
    setActive(null);
    setClosing(false);
  };

  return (
    <>
      <div className={variant === "composer" ? "image-strip" : "message-images"}>
        {images.map((image) => (
          <div className={variant === "composer" ? "image-chip" : "message-image"} key={image.id}>
            <button className="image-preview-button" onClick={() => reopen(image)} aria-label={t("image.preview", { name: image.fileName })}>
              <img src={source(image)} alt={image.fileName} />
              {variant === "composer" && <span>{image.fileName}</span>}
            </button>
            {onRemove && (
              <button className="image-remove-button" onClick={() => onRemove(image.id)} aria-label={t("image.remove", { name: image.fileName })}>
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
      {active && createPortal(
        <div
          className={`image-lightbox ${closing ? "closing" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={t("image.preview", { name: active.fileName })}
          onClick={dismiss}
          onAnimationEnd={finishClose}
        >
          <button className="image-lightbox-close" onClick={dismiss} aria-label={t("image.close")}><X size={18} /></button>
          <img src={source(active)} alt={active.fileName} onClick={(event) => event.stopPropagation()} />
        </div>,
        document.body,
      )}
    </>
  );
}
