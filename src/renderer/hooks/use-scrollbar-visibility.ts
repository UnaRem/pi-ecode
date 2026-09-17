import { useEffect } from "react";

/** Capture scroll events because nested scroll containers do not bubble them. */
export function observeScrollbarVisibility(owner: Document): () => void {
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  const onScroll = (event: Event): void => {
    const container = event.target === owner ? owner.scrollingElement : event.target;
    if (!(container instanceof Element)) return;
    clearTimeout(timers.get(container));
    container.setAttribute("data-scrolling", "");
    timers.set(container, setTimeout(() => {
      container.removeAttribute("data-scrolling");
      timers.delete(container);
    }, 1500));
  };
  owner.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    owner.removeEventListener("scroll", onScroll, { capture: true });
    for (const [container, timer] of timers) {
      clearTimeout(timer);
      container.removeAttribute("data-scrolling");
    }
    timers.clear();
  };
}

export function useScrollbarVisibility(): void {
  useEffect(() => observeScrollbarVisibility(document), []);
}
