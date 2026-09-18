import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowDown, Sparkles } from "lucide-react";
import type { ConversationItem } from "@shared/contracts";
import { ConversationOutline } from "./ConversationOutline";
import { ImageGallery } from "./ImageGallery";
import { Markdown } from "./Markdown";
import { groupConsecutiveTools, ToolBatch } from "./ToolBatch";
import { MessageRoleLabel, type MessageNicknames, type MessageRole, useMessageNicknames } from "./MessageRoleLabel";
import { PastedTextAttachments } from "./PastedTextAttachments";
import { useI18n } from "../i18n/i18n";
import { useScrollFollow } from "../hooks/use-scroll-follow";

interface ConversationProps {
  timeline: ConversationItem[];
  isStreaming: boolean;
  workingStartedAt: number | null;
  projectName: string;
  error: string | null;
  canContinue: boolean;
  notice: string | null;
  hasOlderTimeline?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
  onContinue: () => void;
  selectedToolId?: string | null;
  onSelectTool?: (toolId: string) => void;
}

const BOTTOM_THRESHOLD = 48;

export function formatWorkingDuration(elapsedMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function useWorkingDuration(startedAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const update = (): void => setNow(Date.now());
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);
  return startedAt === null ? null : formatWorkingDuration(now - startedAt);
}

interface ConversationBodyProps extends ConversationProps {
  contentRef: RefObject<HTMLDivElement | null>;
  userElements: { current: Map<string, HTMLElement> };
  workingLabel: string;
  nicknames: MessageNicknames;
  onNicknameChange: (role: MessageRole, nickname: string) => void;
  selectedToolId: string | null;
  onSelectTool: (toolId: string) => void;
}

function ConversationBody(props: ConversationBodyProps) {
  const { t } = useI18n();
  const renderGroups = useMemo(() => groupConsecutiveTools(props.timeline), [props.timeline]);
  const firstUserId = renderGroups.find((group) => group.kind === "message" && group.item.message.role === "user")?.id;
  const isEmpty = props.timeline.length === 0;
  const lastItem = props.timeline.at(-1);
  const hasLiveAssistant = props.isStreaming && lastItem?.kind === "message" && lastItem.message.role === "assistant";
  return (
    <div ref={props.contentRef} className={`conversation-inner ${isEmpty ? "empty" : ""}`}>
      {isEmpty ? (
        <section className="welcome">
          <div className="welcome-icon"><Sparkles size={21} /></div>
          <h1>{t("conversation.welcomeTitle")}</h1>
          <p>{t("conversation.welcomeBody", { project: props.projectName })}</p>
        </section>
      ) : (
        <>
          {props.hasOlderTimeline && (
            <div className="conversation-history-loader">
              <button type="button" disabled={props.isLoadingOlder} onClick={props.onLoadOlder}>
                {t(props.isLoadingOlder ? "conversation.loadingOlder" : "conversation.loadOlder")}
              </button>
            </div>
          )}
          {renderGroups.map((group, groupIndex) => group.kind === "message" ? (
            <article
              key={group.id}
              ref={(element) => {
                if (group.item.message.role !== "user") return;
                if (element) props.userElements.current.set(group.item.message.id, element);
                else props.userElements.current.delete(group.item.message.id);
              }}
              data-message-id={group.item.message.id}
              className={[
                "message",
                group.item.message.role,
                group.item.message.isError ? "error" : null,
                group.item.message.role === "user" && group.id !== firstUserId ? "turn-start" : null,
              ].filter(Boolean).join(" ")}
            >
              <MessageRoleLabel
                role={group.item.message.role}
                nickname={props.nicknames[group.item.message.role]}
                onSave={props.onNicknameChange}
              />
              <div className="message-content">
                {hasLiveAssistant && group.id === lastItem?.id && <div className="working-time"><span className="working-dot" /> {props.workingLabel}</div>}
                {group.item.message.role === "assistant" ? <Markdown>{group.item.message.text}</Markdown> : group.item.message.text}
                {group.item.message.pastedTexts && group.item.message.pastedTexts.length > 0 && <PastedTextAttachments attachments={group.item.message.pastedTexts} variant="message" />}
                {group.item.message.images && group.item.message.images.length > 0 && <ImageGallery images={group.item.message.images} variant="message" />}
                {hasLiveAssistant && group.id === lastItem?.id && <span className="stream-caret" aria-label={t("conversation.generating")} />}
              </div>
            </article>
          ) : <ToolBatch
            key={group.id}
            tools={group.tools}
            animateNewTools={props.isStreaming && groupIndex === renderGroups.length - 1}
            selectedToolId={props.selectedToolId}
            onSelectTool={props.onSelectTool}
          />)}
          {props.isStreaming && !hasLiveAssistant && (
            <article className="message assistant waiting">
              <MessageRoleLabel role="assistant" nickname={props.nicknames.assistant} onSave={props.onNicknameChange} />
              <div className="message-content"><span className="working-dot" /> {props.workingLabel}</div>
            </article>
          )}
        </>
      )}
      {props.error && (
        <div className={`error-banner ${props.canContinue ? "recoverable" : ""}`} role="alert">
          <span>{props.error}</span>
          {props.canContinue && <button onClick={props.onContinue} disabled={props.isStreaming}>{t("conversation.continue")}</button>}
        </div>
      )}
      {props.notice && <div className="notice-banner" role="status">{props.notice}</div>}
    </div>
  );
}

function useActiveUserTracking(
  containerRef: RefObject<HTMLElement | null>,
  userElements: RefObject<Map<string, HTMLElement>>,
  userMessages: Array<{ id: string }>,
  latestUserId: string | null,
): [string | null, (id: string) => void] {
  const [activeUserId, setActiveUserId] = useState<string | null>(latestUserId);
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
  }, [containerRef, userElements, userMessages]);
  return [activeUserId, setActiveUserId];
}

export function Conversation(props: ConversationProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const userElements = useRef(new Map<string, HTMLElement>());
  const historyAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const followingRef = useRef(true);
  const [isFollowing, setIsFollowing] = useState(true);
  const { nicknames, saveNickname } = useMessageNicknames();
  const userMessages = useMemo(() => props.timeline.flatMap((item) => (
    item.kind === "message" && item.message.role === "user" ? [item.message] : []
  )), [props.timeline]);
  const latestUserId = userMessages.at(-1)?.id ?? null;
  const [activeUserId, setActiveUserId] = useActiveUserTracking(containerRef, userElements, userMessages, latestUserId);
  const conversationKey = userMessages.at(0)?.id ?? "empty";
  const workingDuration = useWorkingDuration(props.isStreaming ? props.workingStartedAt : null);
  const workingLabel = workingDuration
    ? t("conversation.workingTime", { time: workingDuration })
    : t("conversation.working");

  const setFollowing = useCallback((following: boolean): void => {
    followingRef.current = following;
    setIsFollowing(following);
  }, []);
  const onWheel = useScrollFollow(containerRef, contentRef, followingRef, {
    threshold: BOTTOM_THRESHOLD,
    onFollowingChange: setFollowing,
  });
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

  const firstTimelineId = props.timeline[0]?.id;
  useLayoutEffect(() => {
    const container = containerRef.current;
    const anchor = historyAnchorRef.current;
    if (!container || !anchor) return;
    container.scrollTop = anchor.scrollTop + container.scrollHeight - anchor.scrollHeight;
    historyAnchorRef.current = null;
  }, [firstTimelineId]);

  const loadOlder = (): void => {
    const container = containerRef.current;
    if (!container || props.isLoadingOlder) return;
    historyAnchorRef.current = { scrollHeight: container.scrollHeight, scrollTop: container.scrollTop };
    setFollowing(false);
    props.onLoadOlder?.();
  };

  const selectTurn = (id: string): void => {
    const element = userElements.current.get(id);
    if (!element) return;
    setFollowing(false);
    setActiveUserId(id);
    element.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="conversation-stage">
      <main
        ref={containerRef}
        className="conversation"
        aria-live="polite"
        data-scroll-follow
        onWheel={onWheel}
      >
        <ConversationOutline
          messages={userMessages}
          activeId={activeUserId}
          onSelect={selectTurn}
        />
        <ConversationBody
          {...props}
          onLoadOlder={loadOlder}
          contentRef={contentRef}
          userElements={userElements}
          workingLabel={workingLabel}
          nicknames={nicknames}
          onNicknameChange={saveNickname}
          onSelectTool={props.onSelectTool ?? (() => undefined)}
          selectedToolId={props.selectedToolId ?? null}
        />
      </main>
      {!isFollowing && (
        <button
          type="button"
          className="conversation-latest"
          onClick={() => scrollToBottom(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth")}
          aria-label={t("conversation.jumpLatest")}
          title={t("conversation.jumpLatest")}
        >
          <ArrowDown size={24} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
