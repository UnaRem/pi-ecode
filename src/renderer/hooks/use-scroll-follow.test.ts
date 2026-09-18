import { describe, expect, it, vi } from "vitest";
import { createScrollFollowController } from "./use-scroll-follow";

function scrollArea(scrollTop = 100) {
  return { scrollHeight: 200, scrollTop, clientHeight: 100 };
}

describe("scroll follow controller", () => {
  it("follows content growth while following is enabled", () => {
    const container = scrollArea();
    const followingRef = { current: true };
    const controller = createScrollFollowController({ container, followingRef, threshold: 8 });

    container.scrollHeight = 260;
    controller.follow();

    expect(container.scrollTop).toBe(260);
  });

  it("does not mistake content growth for user scrolling away", () => {
    const container = scrollArea();
    const followingRef = { current: true };
    const onFollowingChange = vi.fn();
    const controller = createScrollFollowController({ container, followingRef, threshold: 8, onFollowingChange });

    container.scrollHeight = 260;
    controller.onScroll();

    expect(followingRef.current).toBe(true);
    expect(onFollowingChange).not.toHaveBeenCalled();
  });

  it("pauses on upward movement and resumes when the bottom is reached", () => {
    const container = scrollArea();
    const followingRef = { current: true };
    const onFollowingChange = vi.fn();
    const controller = createScrollFollowController({ container, followingRef, threshold: 8, onFollowingChange });

    container.scrollTop = 60;
    controller.onScroll();
    expect(followingRef.current).toBe(false);

    container.scrollTop = 100;
    controller.onScroll();
    expect(followingRef.current).toBe(true);
    expect(onFollowingChange.mock.calls).toEqual([[false], [true]]);
  });
});
