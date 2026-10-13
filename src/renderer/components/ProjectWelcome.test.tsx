import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRecommendations } from "../../shared/contracts";
import { I18nProvider } from "../i18n/i18n";
import { ProjectWelcome } from "./ProjectWelcome";

afterEach(() => vi.unstubAllGlobals());

function render(recommendations: ProjectRecommendations, disabled = false) {
  vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: vi.fn() });
  return renderToStaticMarkup(<I18nProvider><ProjectWelcome projectName="demo" disabled={disabled} onChoose={vi.fn()}
    profile={{ description: null, technologies: ["react"], features: [], hasTests: true, recommendations }} />
  </I18nProvider>);
}

describe("project start page", () => {
  it("renders the generated summary and a variable number of specific recommendations", () => {
    const markup = render({ status: "ready", summary: "最近完成了历史加载优化。", error: null, suggestions: [
      { title: "检查剩余切换延迟", description: "验证大型会话的切换表现。", prompt: "检查切换延迟" },
      { title: "核对工具统计误报", description: "近期反馈仍有未核实项。", prompt: "核对统计误报" },
    ] });
    expect(markup).toContain("最近完成了历史加载优化。");
    expect(markup).toContain("检查剩余切换延迟");
    expect(markup).toContain("核对工具统计误报");
    expect(markup.match(/<button /gu)).toHaveLength(2);
    expect(markup).not.toContain("让会话切换更顺畅");
    expect(markup).not.toContain("<small>");
  });

  it.each([
    { status: "loading" as const, message: "正在总结近期工作", error: null },
    { status: "empty" as const, message: "近期还没有可参考的对话内容", error: null },
    { status: "error" as const, message: "近期推荐生成失败", error: "Provider offline" },
  ])("shows an informative $status state without fixed suggestions", ({ status, message, error }) => {
    const markup = render({ status, summary: "", suggestions: [], error });
    expect(markup).toContain(message);
    expect(markup).toContain(`aria-busy="${status === "loading"}"`);
    expect(markup).not.toContain("<button ");
    if (error) expect(markup).toContain(error);
  });

  it("disables recommendation choices when interaction is unavailable", () => {
    const markup = render({ status: "ready", summary: "近期工作", error: null,
      suggestions: [{ title: "下一步", description: "具体建议", prompt: "执行下一步" }] }, true);
    expect(markup).toMatch(/<button[^>]*disabled/u);
  });
});
