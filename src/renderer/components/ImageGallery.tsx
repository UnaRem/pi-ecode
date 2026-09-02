import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { ImageAttachment } from "@shared/contracts";

interface ImageGalleryProps {
  images: ImageAttachment[];
  variant: "composer" | "message";
  onRemove?: (id: string) => void;
}

function source(image: ImageAttachment): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function ImageGallery({ images, variant, onRemove }: ImageGalleryProps) {
  const [active, setActive] = useState<ImageAttachment | null>(null);

  useEffect(() => {
    if (!active) return;
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [active]);

  return (
    <>
      <div className={variant === "composer" ? "image-strip" : "message-images"}>
        {images.map((image) => (
          <div className={variant === "composer" ? "image-chip" : "message-image"} key={image.id}>
            <button className="image-preview-button" onClick={() => setActive(image)} aria-label={`Preview ${image.fileName}`}>
              <img src={source(image)} alt={image.fileName} />
              {variant === "composer" && <span>{image.fileName}</span>}
            </button>
            {onRemove && (
              <button className="image-remove-button" onClick={() => onRemove(image.id)} aria-label={`Remove ${image.fileName}`}>
                <X size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
      {active && (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={`Preview ${active.fileName}`} onClick={() => setActive(null)}>
          <button className="image-lightbox-close" onClick={() => setActive(null)} aria-label="Close image preview"><X size={18} /></button>
          <img src={source(active)} alt={active.fileName} onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </>
  );
}
