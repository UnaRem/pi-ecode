import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Sparkles } from "lucide-react";
import type { ConversationItem } from "@shared/contracts";
import { ConversationOutline } from "./ConversationOutline";
import { ImageGallery } from "./ImageGallery";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

interface ConversationProps {
  timeline: ConversationItem[];
  isStreaming: boolean;
  projectName: string;
  error: string | null;
  notice: string | null;
}

const BOTTOM_THRESHOLD = 48;

export function Conversation(props: ConversationProps) {
  const containerRef = useRef<HTMLElement>(null);
  const userElements = useRef(new Map<string, HTMLElement>());
  const followingRef = useRef(true);
  const [isFollowing, setIsFollowing] = useState(true);
  const userMessages = useMemo(() => props.timeline.flatMap((item) => (
    item.kind === "message" && item.message.role === "user" ? [item.message] : []
  )), [props.timeline]);
  const [activeUserId, setActiveUserId] = useState<string | null>(userMessages.at(-1)?.id ?? null);
  const conversationKey = userMessages.at(0)?.id ?? "empty";

  const setFollowing = (following: boolean): void => {
    followingRef.current = following;
    setIsFollowing(following);
  };

  const scrollToBottom = (behavior: ScrollBehavior): void => {
    const container = containerRef.current;
    if (!container) return;
    setFollowing(true);
    container.scrollTo({ top: container.scrollHeight, behavior });
  };

  useEffect(() => {
    setFollowing(true);
    requestAnimationFrame(() => scrollToBottom("auto"));
  }, [conversationKey]);

  useEffect(() => {
    if (!followingRef.current) return;
    requestAnimationFrame(() => {
      const container = containerRef.current;
      if (container && followingRef.current) container.scrollTop = container.scrollHeight;
    });
  }, [props.timeline, props.isStreaming]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root || userMessages.length === 0) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
      const current = visible.at(-1)?.target.getAttribute("data-message-id");
      if (current) setActiveUserId(current);
    }, { root, rootMargin: "-12% 0px -68% 0px", threshold: 0 });
    for (const message of userMessages) {
      const element = userElements.current.get(message.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [userMessages]);

  const onScroll = (): void => {
    const container = containerRef.current;
    if (!container) return;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= BOTTOM_THRESHOLD;
    if (atBottom !== followingRef.current) setFollowing(atBottom);
  };

  const selectTurn = (id: string): void => {
    const element = userElements.current.get(id);
    if (!element) return;
    setFollowing(false);
    setActiveUserId(id);
    element.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const isEmpty = props.timeline.length === 0;
  const lastItem = props.timeline.at(-1);
  const hasLiveAssistant = props.isStreaming && lastItem?.kind === "message" && lastItem.message.role === "assistant";

  return (
    <main
      ref={containerRef}
      className="conversation"
      aria-live="polite"
      onScroll={onScroll}
      onWheel={(event) => { if (event.deltaY < 0) setFollowing(false); }}
    >
      <ConversationOutline messages={userMessages} activeId={activeUserId} onSelect={selectTurn} />
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
              <article
                key={item.id}
                ref={(element) => {
                  if (item.message.role !== "user") return;
                  if (element) userElements.current.set(item.message.id, element);
                  else userElements.current.delete(item.message.id);
                }}
                data-message-id={item.message.id}
                className={`message ${item.message.role} ${item.message.isError ? "error" : ""}`}
              >
                <div className="message-role">{item.message.role === "user" ? "You" : "pi"}</div>
                <div className="message-content">
                  {item.message.role === "assistant" ? <Markdown>{item.message.text}</Markdown> : item.message.text}
                  {item.message.images && item.message.images.length > 0 && (
                    <ImageGallery images={item.message.images} variant="message" />
                  )}
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
      </div>
      {!isFollowing && (
        <button className="jump-to-latest" onClick={() => scrollToBottom("smooth")} aria-label="Jump to latest message">
          <ArrowDown size={15} />
          Latest
        </button>
      )}
    </main>
  );
}
