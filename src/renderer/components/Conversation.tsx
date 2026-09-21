import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type AnimationEvent, type RefObject } from "react";
import { ArrowDown, Sparkles } from "lucide-react";
import type { ChangeReview, ConversationItem, ExplorerTask, ValidationState } from "@shared/contracts";
import type { ConversationIdentity } from "@shared/app-config-contracts";
import { ConversationOutline } from "./ConversationOutline";
import { ImageGallery } from "./ImageGallery";
import { Markdown } from "./Markdown";
import { groupConsecutiveTools, ToolBatch, type ConversationRenderGroup } from "./ToolBatch";
import { MessageRoleLabel, type MessageNicknames, type MessageRole, useMessageNicknames } from "./MessageRoleLabel";
import { PastedTextAttachments } from "./PastedTextAttachments";
import { useI18n } from "../i18n/i18n";
import { useScrollFollow } from "../hooks/use-scroll-follow";

interface ConversationProps {
  timeline: ConversationItem[];
  viewKey?: string;
  explorers?: ExplorerTask[];
  validation?: ValidationState;
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
  conversationIdentity?: ConversationIdentity | undefined;
  review?: ChangeReview | undefined;
}

const BOTTOM_THRESHOLD = 48;

function isScrollNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_THRESHOLD;
}

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
  workingDuration: string | null;
  nicknames: MessageNicknames;
  onNicknameChange: (role: MessageRole, nickname: string) => void;
  selectedToolId: string | null;
  onSelectTool: (toolId: string) => void;
  conversationIdentity?: ConversationIdentity | undefined;
  review?: ChangeReview | undefined;
}

function ChangedFilesSummary({ review }: { review: ChangeReview }) {
  const { t } = useI18n();
  const files = [...review.files]
    .sort((left, right) => (right.additions ?? -1) + (right.deletions ?? -1) - ((left.additions ?? -1) + (left.deletions ?? -1)))
    .slice(0, 5);
  return (
    <section className="conversation-changed-files" aria-label={t("conversation.changedFiles")}>
      <strong>{t("conversation.changedFiles")}</strong>
      {files.map((file) => <div className="conversation-changed-file" key={file.path}>
        <code title={file.path}>{file.path}</code>
        <span><b>+{file.additions ?? "?"}</b> <em>−{file.deletions ?? "?"}</em></span>
      </div>)}
    </section>
  );
}

function ConversationErrorBanner(props: Pick<ConversationBodyProps, "error" | "canContinue" | "isStreaming" | "onContinue">) {
  const { t } = useI18n();
  const [visibleError, setVisibleError] = useState(() => props.error ? { message: props.error, canContinue: props.canContinue } : null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (props.error) {
      setVisibleError({ message: props.error, canContinue: props.canContinue });
      setLeaving(false);
    } else if (visibleError) {
      setLeaving(true);
    }
  }, [props.canContinue, props.error]);

  if (!visibleError) return null;
  return (
    <div
      className={`error-banner transient-panel ${visibleError.canContinue ? "recoverable" : ""} ${leaving ? "leaving" : ""}`}
      role="alert"
      inert={leaving ? true : undefined}
      onAnimationEnd={(event: AnimationEvent<HTMLDivElement>) => {
        if (leaving && event.animationName === "panel-leave") setVisibleError(null);
      }}
    >
      <span>{visibleError.message}</span>
      {visibleError.canContinue && <button onClick={props.onContinue} disabled={props.isStreaming}>{t("conversation.continue")}</button>}
    </div>
  );
}

function ConversationNoticeBanner({ notice }: { notice: string | null }) {
  const [visibleNotice, setVisibleNotice] = useState(notice);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (notice) {
      setVisibleNotice(notice);
      setLeaving(false);
    } else if (visibleNotice) {
      setLeaving(true);
    }
  }, [notice]);

  if (!visibleNotice) return null;
  return (
    <div
      className={`notice-banner transient-panel ${leaving ? "leaving" : ""}`}
      role="status"
      inert={leaving ? true : undefined}
      onAnimationEnd={(event: AnimationEvent<HTMLDivElement>) => {
        if (leaving && event.animationName === "panel-leave") setVisibleNotice(null);
      }}
    >{visibleNotice}</div>
  );
}

function ChangedFilesPresence({ review }: { review: ChangeReview | null }) {
  const [visibleReview, setVisibleReview] = useState(review);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (review) {
      setVisibleReview(review);
      setLeaving(false);
    } else if (visibleReview) {
      setLeaving(true);
    }
  }, [review]);

  if (!visibleReview) return null;
  return (
    <div
      className={`changed-files-presence ${leaving ? "leaving" : ""}`}
      inert={leaving ? true : undefined}
      onAnimationEnd={(event: AnimationEvent<HTMLDivElement>) => {
        if (leaving && event.animationName === "changed-files-leave") setVisibleReview(null);
      }}
    >
      <ChangedFilesSummary review={visibleReview} />
    </div>
  );
}

function JumpLatestButton(props: { visible: boolean; label: string; onClick: () => void }) {
  const [mounted, setMounted] = useState(props.visible);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (props.visible) {
      setMounted(true);
      setLeaving(false);
    } else if (mounted) {
      setLeaving(true);
    }
  }, [props.visible]);

  if (!mounted) return null;
  return (
    <button
      type="button"
      className={`conversation-latest ${leaving ? "leaving" : ""}`}
      onClick={props.onClick}
      aria-label={props.label}
      title={props.label}
      aria-hidden={leaving}
      inert={leaving ? true : undefined}
      onAnimationEnd={(event: AnimationEvent<HTMLButtonElement>) => {
        if (leaving && event.animationName === "latest-button-leave") setMounted(false);
      }}
    >
      <ArrowDown size={24} aria-hidden="true" />
    </button>
  );
}

function isVisibleTimelineItem(item: ConversationItem): boolean {
  if (item.kind !== "message" || item.message.role !== "assistant") return true;
  return item.message.text.trim().length > 0
    || Boolean(item.message.images?.length)
    || Boolean(item.message.pastedTexts?.length);
}

function firstAssistantIdsByTurn(groups: ConversationRenderGroup[]): Set<string> {
  const ids = new Set<string>();
  let hasAssistant = false;
  for (const group of groups) {
    if (group.kind !== "message") continue;
    if (group.item.message.role === "user") {
      hasAssistant = false;
    } else if (!hasAssistant) {
      ids.add(group.id);
      hasAssistant = true;
    }
  }
  return ids;
}

function ConversationBody(props: ConversationBodyProps) {
  const { t } = useI18n();
  const visibleTimeline = useMemo(() => props.timeline.filter(isVisibleTimelineItem), [props.timeline]);
  const renderGroups = useMemo(() => groupConsecutiveTools(visibleTimeline), [visibleTimeline]);
  const firstAssistantIds = useMemo(() => firstAssistantIdsByTurn(renderGroups), [renderGroups]);
  const firstUserId = renderGroups.find((group) => group.kind === "message" && group.item.message.role === "user")?.id;
  const isEmpty = visibleTimeline.length === 0;
  const lastItem = visibleTimeline.at(-1);
  const latestUserGroupId = [...renderGroups].reverse().find((group) => group.kind === "message" && group.item.message.role === "user")?.id;
  const latestUserGroupIndex = renderGroups.findIndex((group) => group.id === latestUserGroupId);
  const activeAssistantHeaderId = renderGroups.slice(latestUserGroupIndex + 1).find((group) => group.kind === "message"
    && group.item.message.role === "assistant" && firstAssistantIds.has(group.id))?.id;
  const latestRunningTool = [...visibleTimeline].reverse().find((item): item is Extract<ConversationItem, { kind: "tool" }> => item.kind === "tool" && item.tool.status === "running");
  const assistantStatus = props.isStreaming
    ? latestRunningTool && /bash|shell|execute|command|run/i.test(latestRunningTool.tool.name) ? t("conversation.statusExecuting") : t("conversation.statusWorking")
    : null;
  const activeStatus = assistantStatus && props.workingDuration ? `${assistantStatus} · ${props.workingDuration}` : assistantStatus;
  const hasAssistantInActiveTurn = activeAssistantHeaderId !== undefined;
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
                group.item.message.role === "assistant" && !firstAssistantIds.has(group.id) ? "continuation" : null,
              ].filter(Boolean).join(" ")}
            >
              {(group.item.message.role === "user" || firstAssistantIds.has(group.id)) && <MessageRoleLabel
                role={group.item.message.role}
                nickname={props.conversationIdentity?.[group.item.message.role]?.nickname ?? props.nicknames[group.item.message.role]}
                avatarUrl={props.conversationIdentity?.[group.item.message.role]?.avatarUrl ?? null}
                status={group.item.message.role === "assistant" && group.id === activeAssistantHeaderId ? activeStatus : null}
              />}
              <div className="message-content">
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
            explorers={props.explorers ?? []}
            {...(props.validation ? { validation: props.validation } : {})}
          />)}
          <ChangedFilesPresence review={!props.isStreaming && props.review?.available && lastItem?.kind === "message" && lastItem.message.role === "assistant" ? props.review : null} />
          {props.isStreaming && !hasAssistantInActiveTurn && (
            <article className="message assistant waiting">
              <MessageRoleLabel
                role="assistant"
                nickname={props.conversationIdentity?.assistant.nickname ?? props.nicknames.assistant}
                avatarUrl={props.conversationIdentity?.assistant.avatarUrl ?? null}
                status={activeStatus}
              />
            </article>
          )}
        </>
      )}
      <ConversationErrorBanner {...props} />
      <ConversationNoticeBanner notice={props.notice} />
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
  const initialScrollPendingRef = useRef(true);
  const previousViewKeyRef = useRef(props.viewKey ?? "conversation");
  const latestUserViewKeyRef = useRef(props.viewKey ?? "conversation");
  const followingRef = useRef(true);
  const [isFollowing, setIsFollowing] = useState(true);
  const { nicknames, saveNickname } = useMessageNicknames({
    assistant: props.conversationIdentity?.assistant.nickname ?? "PiECode",
    user: props.conversationIdentity?.user.nickname ?? "你",
  });
  const userMessages = useMemo(() => props.timeline.flatMap((item) => (
    item.kind === "message" && item.message.role === "user" ? [item.message] : []
  )), [props.timeline]);
  const latestUserId = userMessages.at(-1)?.id ?? null;
  const [activeUserId, setActiveUserId] = useActiveUserTracking(containerRef, userElements, userMessages, latestUserId);
  const conversationKey = userMessages.at(0)?.id ?? "empty";
  const workingDuration = useWorkingDuration(props.isStreaming ? props.workingStartedAt : null);

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

  const viewKey = props.viewKey ?? conversationKey;
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || previousViewKeyRef.current === viewKey) return;
    previousViewKeyRef.current = viewKey;
    initialScrollPendingRef.current = true;
    container.scrollTop = 0;
    setFollowing(true);
  }, [viewKey]);

  useEffect(() => {
    const switchedView = latestUserViewKeyRef.current !== viewKey;
    latestUserViewKeyRef.current = viewKey;
    if (!latestUserId) return;
    setActiveUserId(latestUserId);
    if (switchedView) return;
    setFollowing(true);
    requestAnimationFrame(() => scrollToBottom("auto"));
  }, [latestUserId, viewKey]);

  const firstTimelineId = props.timeline[0]?.id;
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !initialScrollPendingRef.current || props.timeline.length === 0) return;
    initialScrollPendingRef.current = false;
    container.scrollTop = container.scrollHeight;
    setFollowing(true);
  }, [firstTimelineId, props.timeline.length, viewKey]);

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
    element.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
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
          workingDuration={workingDuration}
          nicknames={nicknames}
          onNicknameChange={saveNickname}
          onSelectTool={props.onSelectTool ?? (() => undefined)}
          selectedToolId={props.selectedToolId ?? null}
        />
      </main>
      <JumpLatestButton
        visible={!isFollowing}
        label={t("conversation.jumpLatest")}
        onClick={() => scrollToBottom(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth")}
      />
    </div>
  );
}
