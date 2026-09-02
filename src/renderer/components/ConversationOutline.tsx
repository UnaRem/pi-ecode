import { useState } from "react";
import type { ConversationMessage } from "@shared/contracts";

interface ConversationOutlineProps {
  messages: ConversationMessage[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

function messagePreview(message: ConversationMessage): string {
  const text = message.text.replace(/\s+/g, " ").trim();
  if (!text) return message.images?.length ? "Image request" : "Empty message";
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

interface OutlinePreview {
  index: number;
  text: string;
  top: number;
}

export function ConversationOutline(props: ConversationOutlineProps) {
  const [preview, setPreview] = useState<OutlinePreview | null>(null);
  if (props.messages.length < 2) return null;

  const showPreview = (message: ConversationMessage, index: number, marker: HTMLElement): void => {
    const outline = marker.closest<HTMLElement>(".conversation-outline");
    if (!outline) return;
    const markerBounds = marker.getBoundingClientRect();
    const outlineBounds = outline.getBoundingClientRect();
    setPreview({
      index,
      text: messagePreview(message),
      top: markerBounds.top - outlineBounds.top + markerBounds.height / 2,
    });
  };

  return (
    <nav className="conversation-outline" aria-label="Current conversation overview">
      <div className="outline-track">
        {props.messages.map((message, index) => (
          <button
            key={message.id}
            className={`outline-marker ${message.id === props.activeId ? "active" : ""}`}
            onClick={() => props.onSelect(message.id)}
            onMouseEnter={(event) => showPreview(message, index, event.currentTarget)}
            onMouseLeave={() => setPreview(null)}
            onFocus={(event) => showPreview(message, index, event.currentTarget)}
            onBlur={() => setPreview(null)}
            aria-label={`Go to turn ${index + 1}: ${messagePreview(message)}`}
          >
            <span className="outline-line" aria-hidden="true" />
          </button>
        ))}
      </div>
      {preview && (
        <span className="outline-preview" role="tooltip" style={{ top: preview.top }}>
          <strong>Turn {preview.index + 1}</strong>
          {preview.text}
        </span>
      )}
    </nav>
  );
}
