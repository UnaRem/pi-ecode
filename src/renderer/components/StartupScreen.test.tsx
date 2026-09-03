import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { remainingStartupTime, STARTUP_MINIMUM_MS, StartupScreen } from "./StartupScreen";

describe("StartupScreen", () => {
  it("keeps the brand visible for the minimum startup duration", () => {
    expect(STARTUP_MINIMUM_MS).toBe(1_800);
    expect(remainingStartupTime(1_000, 1_250)).toBe(STARTUP_MINIMUM_MS - 250);
    expect(remainingStartupTime(1_000, 3_000)).toBe(0);
  });

  it("renders the current icon and product name", () => {
    const markup = renderToStaticMarkup(<StartupScreen ready={false} onFinished={vi.fn()} />);
    expect(markup).toContain('src="./ecode-icon.png"');
    expect(markup).toContain("<h1>PiECode</h1>");
    expect(markup).toContain('aria-label="PiECode"');
    expect(markup).toContain('class="startup-screen"');
  });
});
