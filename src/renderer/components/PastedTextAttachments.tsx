import { FileText, X } from "lucide-react";
import { useEffect, useState, type AnimationEvent } from "react";
import type { PastedTextAttachment } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";
import { useAnimatedList } from "../hooks/use-animated-list";

interface PastedTextAttachmentsProps {
  attachments: PastedTextAttachment[];
  variant: "composer" | "message";
  onRemove?: (id: string) => void;
}

function formatByteSize(byteSize: number): string {
  if (byteSize < 1_024) return `${byteSize} B`;
  return `${(byteSize / 1_024).toFixed(1)} KB`;
}

export function PastedTextAttachments({ attachments, variant, onRemove }: PastedTextAttachmentsProps) {
  const { t } = useI18n();
  const { renderedItems, leavingIds, beginRemove, finishRemove } = useAnimatedList(attachments);
  // Keep the dialog mounted until its visual exit completes.
  const [active, setActive] = useState<PastedTextAttachment | null>(null);
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

  const open = (attachment: PastedTextAttachment): void => {
    setClosing(false);
    setActive(attachment);
  };

  const finishClose = (event: AnimationEvent<HTMLDivElement>): void => {
    if (event.animationName !== "overlay-close") return;
    setActive(null);
    setClosing(false);
  };

  return (
    <>
      <div className={`pasted-text-list pasted-text-list-${variant}`}>
        {renderedItems.map((attachment, index) => {
          const name = t("pastedText.name", { index: index + 1 });
          const leaving = leavingIds.has(attachment.id);
          return (
            <div
              className={`pasted-text-chip attachment-item ${leaving ? "leaving" : ""}`}
              key={attachment.id}
              inert={leaving ? true : undefined}
              onAnimationEnd={(event) => finishRemove(attachment.id, event)}
            >
              <button onClick={() => open(attachment)} aria-label={t("pastedText.preview", { name })}>
                <FileText size={16} />
                <span><strong>{name}</strong><small>{t("pastedText.summary", { lines: attachment.lineCount, size: formatByteSize(attachment.byteSize) })}</small></span>
              </button>
              {onRemove && <button className="pasted-text-remove" onClick={() => beginRemove(attachment.id, onRemove)} aria-label={t("pastedText.remove", { name })}><X size={12} /></button>}
            </div>
          );
        })}
      </div>
      {active && (
        <div
          className={`pasted-text-dialog ${closing ? "closing" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={t("pastedText.preview", { name: t("pastedText.name", { index: attachments.indexOf(active) + 1 }) })}
          onClick={dismiss}
          onAnimationEnd={finishClose}
        >
          <div onClick={(event) => event.stopPropagation()}>
            <button onClick={dismiss} aria-label={t("pastedText.close")}><X size={18} /></button>
            <pre>{active.content}</pre>
          </div>
        </div>
      )}
    </>
  );
}
