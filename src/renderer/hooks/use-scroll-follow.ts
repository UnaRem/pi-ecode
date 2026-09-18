import { useCallback, useLayoutEffect, type RefObject, type WheelEvent } from "react";

interface ScrollFollowOptions {
  container: { scrollHeight: number; scrollTop: number; clientHeight: number };
  followingRef: RefObject<boolean>;
  threshold: number;
  onFollowingChange?: ((following: boolean) => void) | undefined;
}

export function createScrollFollowController({ container, followingRef, threshold, onFollowingChange }: ScrollFollowOptions) {
  let previousScrollTop = container.scrollTop;
  const follow = (): void => {
    if (followingRef.current) container.scrollTop = container.scrollHeight;
    previousScrollTop = container.scrollTop;
  };
  const onScroll = (): void => {
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
    const movedUp = container.scrollTop < previousScrollTop;
    previousScrollTop = container.scrollTop;
    // Growth can increase the bottom gap without user input; only upward movement pauses following.
    const following = atBottom ? true : movedUp ? false : followingRef.current;
    if (following === followingRef.current) return;
    followingRef.current = following;
    onFollowingChange?.(following);
  };
  return { follow, onScroll };
}

export function useScrollFollow(
  containerRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  followingRef: RefObject<boolean>,
  { threshold = 8, onFollowingChange }: { threshold?: number; onFollowingChange?: (following: boolean) => void } = {},
) {
  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    const controller = createScrollFollowController({ container, followingRef, threshold, onFollowingChange });
    controller.follow();
    // Observe natural content and the viewport: card animations and panel reflow happen after commit.
    const observer = new ResizeObserver(controller.follow);
    observer.observe(content);
    observer.observe(container);
    container.addEventListener("scroll", controller.onScroll);
    return () => {
      observer.disconnect();
      container.removeEventListener("scroll", controller.onScroll);
    };
  }, [containerRef, contentRef, followingRef, threshold, onFollowingChange]);

  return useCallback((event: WheelEvent<HTMLElement>): void => {
    const container = containerRef.current;
    if (!container || event.deltaY >= 0 || container.scrollTop <= 0) return;
    // Nested tool lists own their scrolling; their wheel input must not pause the conversation.
    if (event.target instanceof Element && event.target.closest("[data-scroll-follow]") !== container) return;
    followingRef.current = false;
    onFollowingChange?.(false);
  }, [containerRef, followingRef, onFollowingChange]);
}
