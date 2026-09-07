import { FileText, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PastedTextAttachment } from "@shared/contracts";
import { useI18n } from "../i18n/i18n";

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
  const [active, setActive] = useState<PastedTextAttachment | null>(null);

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
      <div className={`pasted-text-list pasted-text-list-${variant}`}>
        {attachments.map((attachment, index) => {
          const name = t("pastedText.name", { index: index + 1 });
          return (
            <div className="pasted-text-chip" key={attachment.id}>
              <button onClick={() => setActive(attachment)} aria-label={t("pastedText.preview", { name })}>
                <FileText size={16} />
                <span><strong>{name}</strong><small>{t("pastedText.summary", { lines: attachment.lineCount, size: formatByteSize(attachment.byteSize) })}</small></span>
              </button>
              {onRemove && <button className="pasted-text-remove" onClick={() => onRemove(attachment.id)} aria-label={t("pastedText.remove", { name })}><X size={12} /></button>}
            </div>
          );
        })}
      </div>
      {active && (
        <div className="pasted-text-dialog" role="dialog" aria-modal="true" aria-label={t("pastedText.preview", { name: t("pastedText.name", { index: attachments.indexOf(active) + 1 }) })} onClick={() => setActive(null)}>
          <div onClick={(event) => event.stopPropagation()}>
            <button onClick={() => setActive(null)} aria-label={t("pastedText.close")}><X size={18} /></button>
            <pre>{active.content}</pre>
          </div>
        </div>
      )}
    </>
  );
}
