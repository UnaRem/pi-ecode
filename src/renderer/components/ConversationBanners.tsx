import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n/i18n";

export function useBannerExit(leaving: boolean, onExited: () => void): void {
  const exitRef = useRef(onExited);
  useEffect(() => { exitRef.current = onExited; }, [onExited]);
  useEffect(() => {
    if (!leaving) return;
    // Cleanup must also run when animations are reduced, cancelled, or never emit animationend.
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timeout = window.setTimeout(() => exitRef.current(), reducedMotion ? 0 : 180);
    return () => window.clearTimeout(timeout);
  }, [leaving]);
}

function TransientBanner({ message, timeoutMs, className, children }: {
  message: string | null;
  timeoutMs: number | null;
  className: string;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const [visibleMessage, setVisibleMessage] = useState(message);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!message) { setLeaving(true); return; }
    setVisibleMessage(message);
    setLeaving(false);
    if (timeoutMs === null) return;
    const timeout = window.setTimeout(() => setLeaving(true), timeoutMs);
    return () => window.clearTimeout(timeout);
  }, [message, timeoutMs]);
  useBannerExit(leaving, () => { setVisibleMessage(null); setLeaving(false); });
  if (!visibleMessage) return null;
  return <div className={`${className} transient-panel ${leaving ? "leaving" : ""}`}
    role={className.startsWith("error-banner") ? "alert" : "status"} inert={leaving ? true : undefined}>
    <span>{visibleMessage}</span>{children}
    <button type="button" className="icon-button banner-dismiss" onClick={() => setLeaving(true)} aria-label={t("conversation.dismiss")}><X size={14} /></button>
  </div>;
}

export function ConversationBanners(props: {
  error: string | null;
  notice: string | null;
  canContinue: boolean;
  isStreaming: boolean;
  onContinue: () => void;
}) {
  const { t } = useI18n();
  return <>
    <TransientBanner message={props.error} timeoutMs={props.canContinue ? null : 8_000} className={`error-banner ${props.canContinue ? "recoverable" : ""}`}>
      {props.canContinue && <button onClick={props.onContinue} disabled={props.isStreaming}>{t("conversation.continue")}</button>}
    </TransientBanner>
    <TransientBanner message={props.notice} timeoutMs={5_000} className="notice-banner" />
  </>;
}
