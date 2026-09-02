import { useEffect, useRef } from "react";
import { Sparkles } from "lucide-react";
import type { ConversationItem } from "@shared/contracts";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

interface ConversationProps {
  timeline: ConversationItem[];
  isStreaming: boolean;
  projectName: string;
  error: string | null;
  notice: string | null;
}

export function Conversation(props: ConversationProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: props.isStreaming ? "auto" : "smooth" });
  }, [props.timeline, props.isStreaming]);

  const isEmpty = props.timeline.length === 0;
  const lastItem = props.timeline.at(-1);
  const hasLiveAssistant = props.isStreaming && lastItem?.kind === "message" && lastItem.message.role === "assistant";

  return (
    <main className="conversation" aria-live="polite">
      <div className={`conversation-inner ${isEmpty ? "empty" : ""}`}>
        {isEmpty ? (
          <section className="welcome">
            <div className="welcome-icon"><Sparkles size={21} /></div>
            <h1>What should we build?</h1>
            <p>pi is ready to work in <strong>{props.projectName}</strong>. Ask for a change, an explanation, or a review.</p>
          </section>
        ) : (
          <>
            {props.timeline.map((item, index) => item.kind === "message" ? (
              <article key={item.id} className={`message ${item.message.role} ${item.message.isError ? "error" : ""}`}>
                <div className="message-role">{item.message.role === "user" ? "You" : "pi"}</div>
                <div className="message-content">
                  {item.message.role === "assistant" ? <Markdown>{item.message.text}</Markdown> : item.message.text}
                  {hasLiveAssistant && index === props.timeline.length - 1 && (
                    <span className="stream-caret" aria-label="Generating" />
                  )}
                </div>
              </article>
            ) : (
              <div className="timeline-tool" key={item.id}>
                <ToolCard tool={item.tool} />
              </div>
            ))}
            {props.isStreaming && !hasLiveAssistant && (
              <article className="message assistant waiting">
                <div className="message-role">pi</div>
                <div className="message-content"><span className="working-dot" /> Working…</div>
              </article>
            )}
          </>
        )}
        {props.error && <div className="error-banner" role="alert">{props.error}</div>}
        {props.notice && <div className="notice-banner" role="status">{props.notice}</div>}
        <div ref={endRef} />
      </div>
    </main>
  );
}
