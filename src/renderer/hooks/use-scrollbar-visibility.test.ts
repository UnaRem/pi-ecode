import { afterEach, describe, expect, it, vi } from "vitest";
import { observeScrollbarVisibility } from "./use-scrollbar-visibility";

class ScrollContainer extends EventTarget {
  readonly attributes = new Set<string>();
  setAttribute(name: string): void { this.attributes.add(name); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
}

function harness() {
  vi.useFakeTimers();
  vi.stubGlobal("Element", ScrollContainer);
  const owner = new EventTarget();
  const stop = observeScrollbarVisibility(owner as Document);
  const scroll = (container: ScrollContainer): void => {
    const event = new Event("scroll");
    Object.defineProperty(event, "target", { value: container });
    owner.dispatchEvent(event);
  };
  return { scroll, stop };
}

// Lightweight DOM boundary doubles keep these timer tests independent of a browser framework.
describe("scrollbar visibility", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reveals on scroll and hides 1500ms after the last scroll", () => {
    const { scroll, stop } = harness();
    const container = new ScrollContainer();
    expect(container.attributes.has("data-scrolling")).toBe(false);
    scroll(container);
    expect(container.attributes.has("data-scrolling")).toBe(true);
    vi.advanceTimersByTime(1000);
    scroll(container);
    vi.advanceTimersByTime(1499);
    expect(container.attributes.has("data-scrolling")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(container.attributes.has("data-scrolling")).toBe(false);
    stop();
  });

  it("tracks containers independently and cleans up pending timers and listeners", () => {
    const { scroll, stop } = harness();
    const first = new ScrollContainer();
    const second = new ScrollContainer();
    scroll(first);
    vi.advanceTimersByTime(1000);
    scroll(second);
    vi.advanceTimersByTime(500);
    expect(first.attributes.has("data-scrolling")).toBe(false);
    expect(second.attributes.has("data-scrolling")).toBe(true);
    stop();
    expect(second.attributes.has("data-scrolling")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    scroll(first);
    expect(first.attributes.has("data-scrolling")).toBe(false);
  });
});
