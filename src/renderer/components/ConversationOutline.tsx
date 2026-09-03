import { useState } from "react";
import { ArrowDown } from "lucide-react";
import type { ConversationMessage } from "@shared/contracts";
import { useI18n, type Translate } from "../i18n/i18n";

interface ConversationOutlineProps {
  messages: ConversationMessage[];
  activeId: string | null;
  showLatest: boolean;
  onSelect: (id: string) => void;
  onLatest: () => void;
}

function messagePreview(message: ConversationMessage, t: Translate): string {
  const text = message.text.replace(/\s+/g, " ").trim();
  if (!text) return message.images?.length ? t("conversation.imageRequest") : t("conversation.emptyMessage");
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

interface OutlinePreview {
  index: number;
  text: string;
  top: number;
}

export function ConversationOutline(props: ConversationOutlineProps) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<OutlinePreview | null>(null);
  if (props.messages.length < 2 && !props.showLatest) return null;

  const showPreview = (message: ConversationMessage, index: number, marker: HTMLElement): void => {
    const outline = marker.closest<HTMLElement>(".conversation-outline");
    if (!outline) return;
    const markerBounds = marker.getBoundingClientRect();
    const outlineBounds = outline.getBoundingClientRect();
    setPreview({
      index,
      text: messagePreview(message, t),
      top: markerBounds.top - outlineBounds.top + markerBounds.height / 2,
    });
  };

  return (
    <nav className="conversation-outline" aria-label={t("conversation.overview")}>
      <div className="outline-track">
        <div className="outline-markers">
          {props.messages.map((message, index) => (
            <button
              key={message.id}
              className={`outline-marker ${message.id === props.activeId ? "active" : ""}`}
              onClick={() => props.onSelect(message.id)}
              onMouseEnter={(event) => showPreview(message, index, event.currentTarget)}
              onMouseLeave={() => setPreview(null)}
              onFocus={(event) => showPreview(message, index, event.currentTarget)}
              onBlur={() => setPreview(null)}
              aria-label={t("conversation.goTurn", { turn: index + 1, preview: messagePreview(message, t) })}
            >
              <span className="outline-line" aria-hidden="true" />
            </button>
          ))}
        </div>
        {props.showLatest && (
          <button
            className="outline-latest"
            onClick={props.onLatest}
            aria-label={t("conversation.jumpLatest")}
            title={t("conversation.jumpLatest")}
          >
            <ArrowDown size={14} />
          </button>
        )}
      </div>
      {preview && (
        <span className="outline-preview" role="tooltip" style={{ top: preview.top }}>
          <strong>{t("conversation.turn", { turn: preview.index + 1 })}</strong>
          {preview.text}
        </span>
      )}
    </nav>
  );
}
