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

export function ConversationOutline(props: ConversationOutlineProps) {
  if (props.messages.length < 2) return null;

  return (
    <nav className="conversation-outline" aria-label="Current conversation overview">
      <div className="outline-track">
        {props.messages.map((message, index) => (
          <button
            key={message.id}
            className={`outline-marker ${message.id === props.activeId ? "active" : ""}`}
            onClick={() => props.onSelect(message.id)}
            aria-label={`Go to turn ${index + 1}: ${messagePreview(message)}`}
          >
            <span className="outline-line" aria-hidden="true" />
            <span className="outline-tooltip" role="tooltip">
              <strong>Turn {index + 1}</strong>
              {messagePreview(message)}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}
