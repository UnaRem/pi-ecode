import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Sparkles } from "lucide-react";
import type { ConversationItem } from "@shared/contracts";
import { ConversationOutline } from "./ConversationOutline";
import { ImageGallery } from "./ImageGallery";
import { Markdown } from "./Markdown";
import { groupConsecutiveTools, ToolBatch } from "./ToolBatch";
import { useI18n } from "../i18n/i18n";

interface ConversationProps {
  timeline: ConversationItem[];
  isStreaming: boolean;
  projectName: string;
  error: string | null;
  notice: string | null;
}

const BOTTOM_THRESHOLD = 48;

export function Conversation(props: ConversationProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLElement>(null);
  const userElements = useRef(new Map<string, HTMLElement>());
  const followingRef = useRef(true);
  const [isFollowing, setIsFollowing] = useState(true);
  const userMessages = useMemo(() => props.timeline.flatMap((item) => (
    item.kind === "message" && item.message.role === "user" ? [item.message] : []
  )), [props.timeline]);
  const latestUserId = userMessages.at(-1)?.id ?? null;
  const [activeUserId, setActiveUserId] = useState<string | null>(latestUserId);
  const conversationKey = userMessages.at(0)?.id ?? "empty";
  const renderGroups = useMemo(() => groupConsecutiveTools(props.timeline), [props.timeline]);

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
    if (!latestUserId) return;
    setActiveUserId(latestUserId);
    setFollowing(true);
    requestAnimationFrame(() => scrollToBottom("auto"));
  }, [latestUserId]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container && followingRef.current) container.scrollTop = container.scrollHeight;
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
            <h1>{t("conversation.welcomeTitle")}</h1>
            <p>{t("conversation.welcomeBody", { project: props.projectName })}</p>
          </section>
        ) : (
          <>
            {renderGroups.map((group) => group.kind === "message" ? (
              <article
                key={group.id}
                ref={(element) => {
                  if (group.item.message.role !== "user") return;
                  if (element) userElements.current.set(group.item.message.id, element);
                  else userElements.current.delete(group.item.message.id);
                }}
                data-message-id={group.item.message.id}
                className={`message ${group.item.message.role} ${group.item.message.isError ? "error" : ""}`}
              >
                <div className="message-role">{group.item.message.role === "user" ? t("conversation.you") : "pi"}</div>
                <div className="message-content">
                  {group.item.message.role === "assistant" ? <Markdown>{group.item.message.text}</Markdown> : group.item.message.text}
                  {group.item.message.images && group.item.message.images.length > 0 && (
                    <ImageGallery images={group.item.message.images} variant="message" />
                  )}
                  {hasLiveAssistant && group.id === lastItem?.id && (
                    <span className="stream-caret" aria-label={t("conversation.generating")} />
                  )}
                </div>
              </article>
            ) : <ToolBatch key={group.id} tools={group.tools} />)}
            {props.isStreaming && !hasLiveAssistant && (
              <article className="message assistant waiting">
                <div className="message-role">pi</div>
                <div className="message-content"><span className="working-dot" /> {t("conversation.working")}</div>
              </article>
            )}
          </>
        )}
        {props.error && <div className="error-banner" role="alert">{props.error}</div>}
        {props.notice && <div className="notice-banner" role="status">{props.notice}</div>}
      </div>
      {!isFollowing && (
        <button className="jump-to-latest" onClick={() => scrollToBottom("smooth")} aria-label={t("conversation.jumpLatest")}>
          <ArrowDown size={15} />
          {t("conversation.latest")}
        </button>
      )}
    </main>
  );
}
