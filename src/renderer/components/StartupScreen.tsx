import { useEffect, useRef, useState, type AnimationEvent } from "react";

export const STARTUP_MINIMUM_MS = 1_800;

export function remainingStartupTime(startedAt: number, now: number): number {
  return Math.max(0, STARTUP_MINIMUM_MS - (now - startedAt));
}

interface StartupScreenProps {
  ready: boolean;
  iconSrc: string;
  onFinished: () => void;
}

export function StartupScreen({ ready, iconSrc, onFinished }: StartupScreenProps) {
  const visibleAtRef = useRef<number | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);

  useEffect(() => {
    const reveal = (): void => {
      if (document.visibilityState !== "visible") return;
      visibleAtRef.current ??= Date.now();
      setIsVisible(true);
    };
    reveal();
    document.addEventListener("visibilitychange", reveal);
    return () => document.removeEventListener("visibilitychange", reveal);
  }, []);

  useEffect(() => {
    if (!ready || !isVisible) return;
    const timeout = window.setTimeout(
      () => setIsLeaving(true),
      remainingStartupTime(visibleAtRef.current ?? Date.now(), Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [isVisible, ready]);

  const finish = (event: AnimationEvent<HTMLElement>): void => {
    if (isLeaving && event.currentTarget === event.target && event.animationName === "startup-screen-leave") {
      onFinished();
    }
  };

  return (
    <main className={`startup-screen${isVisible ? " visible" : ""}${isLeaving ? " leaving" : ""}`} onAnimationEnd={finish} aria-label="PiECode">
      <div className="startup-brand">
        <img src={iconSrc} alt="" />
        <h1>PiECode</h1>
      </div>
    </main>
  );
}
