import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { nextOptionIndex, TopbarSelect } from "./TopbarSelect";

describe("TopbarSelect", () => {
  it("renders a styled listbox trigger instead of a native select", () => {
    const markup = renderToStaticMarkup(createElement(TopbarSelect, {
      className: "thinking-select",
      label: "思考级别",
      value: "xhigh",
      options: [
        { value: "high", label: "high" },
        { value: "xhigh", label: "xhigh" },
      ],
      disabled: false,
      onChange: vi.fn(),
    }));

    expect(markup).toContain('class="select-trigger"');
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain(">xhigh</span>");
    expect(markup).not.toContain("<select");
  });

  it("moves within option bounds and supports Home and End", () => {
    expect(nextOptionIndex(1, "ArrowDown", 3)).toBe(2);
    expect(nextOptionIndex(2, "ArrowDown", 3)).toBe(2);
    expect(nextOptionIndex(1, "ArrowUp", 3)).toBe(0);
    expect(nextOptionIndex(0, "ArrowUp", 3)).toBe(0);
    expect(nextOptionIndex(1, "Home", 3)).toBe(0);
    expect(nextOptionIndex(1, "End", 3)).toBe(2);
  });
});
