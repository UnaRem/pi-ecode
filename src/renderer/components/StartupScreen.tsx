import { useEffect, useRef, useState, type AnimationEvent } from "react";

export const STARTUP_MINIMUM_MS = 1_200;

export function remainingStartupTime(startedAt: number, now: number): number {
  return Math.max(0, STARTUP_MINIMUM_MS - (now - startedAt));
}

interface StartupScreenProps {
  ready: boolean;
  onFinished: () => void;
}

export function StartupScreen({ ready, onFinished }: StartupScreenProps) {
  const startedAtRef = useRef(Date.now());
  const [isLeaving, setIsLeaving] = useState(false);

  useEffect(() => {
    if (!ready) return;
    const timeout = window.setTimeout(
      () => setIsLeaving(true),
      remainingStartupTime(startedAtRef.current, Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [ready]);

  const finish = (event: AnimationEvent<HTMLElement>): void => {
    if (isLeaving && event.currentTarget === event.target && event.animationName === "startup-screen-leave") {
      onFinished();
    }
  };

  return (
    <main className={isLeaving ? "startup-screen leaving" : "startup-screen"} onAnimationEnd={finish} aria-label="pi ecode">
      <div className="startup-brand">
        <img src="./ecode-icon.png" alt="" />
        <h1>pi ecode</h1>
      </div>
    </main>
  );
}
