import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentCatalog, SetAllProjectAgentPreferencesRequest } from "@shared/agent-contracts";
import { I18nProvider } from "../i18n/i18n";
import { AgentManager } from "./AgentManager";

const catalog: ProjectAgentCatalog = {
  version: 1,
  projectPath: "C:/work/demo",
  maxConcurrent: 3,
  updatedAt: 1,
  agents: [{
    id: "explorer-1",
    name: "探索者 1",
    role: "explorer",
    builtIn: true,
    enabled: true,
    model: { mode: "inherit" },
    thinkingLevel: "low",
    autoCompaction: { enabled: true, thresholdPercent: null },
    prompt: "只读调查",
    disabledTools: ["write"],
    createdAt: 1,
    updatedAt: 1,
  }],
};

function renderManager(currentCatalog: ProjectAgentCatalog, availableModels = true): string {
  vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: vi.fn() });
  return renderToStaticMarkup(<I18nProvider><AgentManager
    catalog={currentCatalog}
    models={availableModels ? [{ id: "model", provider: "provider", name: "模型", reasoning: true, supportsImages: false }] : []}
    onBack={vi.fn()} onSave={vi.fn()} onSetAllPreferences={vi.fn()}
    onCreate={vi.fn()} onRemove={vi.fn()} onSetConcurrency={vi.fn()}
  /></I18nProvider>);
}

function bulkMarkup(currentCatalog: ProjectAgentCatalog, availableModels = true): string {
  // 只检查批量区域，避免单代理表单的同名选项掩盖回显错误。
  return renderManager(currentCatalog, availableModels).split('class="agent-manager-all"')[1]!.split("</section>")[0]!;
}

function expectSelected(markup: string, value: string): void {
  expect(markup).toMatch(new RegExp(`<option(?=[^>]*value="${value}")(?=[^>]*selected="")[^>]*>`));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentManager", () => {
  it("renders project agent settings without offering deletion for defaults", () => {
    const markup = renderManager(catalog);

    expect(markup).toContain("管理代理");
    expect(markup).toContain("继承主会话");
    expect(markup).toContain("应用到全部代理");
    expect(markup).toContain("已派发任务保留原设置");
    expect(markup).toContain("自动压缩");
    expect(markup).toContain("只读调查");
    expect(markup).toContain("write");
    expect(markup).not.toContain("删除代理");
  });

  it.each([
    { model: { mode: "inherit" }, thinkingLevel: "high" },
    { model: { mode: "fixed", provider: "provider", modelId: "model" }, thinkingLevel: "max" },
  ] satisfies SetAllProjectAgentPreferencesRequest[])("回显序列化目录数据重建组件后的设置：%j", (request) => {
    expectSelected(bulkMarkup(catalog), "low");
    const updatedCatalog: ProjectAgentCatalog = {
      ...catalog,
      updatedAt: 2,
      agents: catalog.agents.map((agent) => ({
        ...agent, model: request.model, thinkingLevel: request.thinkingLevel, updatedAt: 2,
      })),
    };
    // 模拟重新收到目录数据；真实写盘与重载由 main 层服务测试覆盖。
    const restored = JSON.parse(JSON.stringify(updatedCatalog)) as ProjectAgentCatalog;
    const markup = bulkMarkup(restored);
    const modelValue = request.model.mode === "inherit" ? "inherit" : `${request.model.provider}/${request.model.modelId}`;
    expectSelected(markup, modelValue);
    expectSelected(markup, request.thinkingLevel);
    expect(markup).not.toMatch(/<button[^>]*disabled=""/);
  });

  it.each(["model", "thinking", "both"])("混合设置显示提示并禁用应用：%s", (mixedField) => {
    const first = catalog.agents[0]!;
    const second = { ...structuredClone(first), id: "explorer-2" };
    if (mixedField !== "thinking") second.model = { mode: "fixed", provider: "provider", modelId: "model" };
    if (mixedField !== "model") second.thinkingLevel = "high";
    const markup = bulkMarkup({ ...catalog, agents: [first, second] });

    expectSelected(markup, "");
    expect(markup.match(/<option(?=[^>]*value="")(?=[^>]*selected="")[^>]*>/g)).toHaveLength(mixedField === "both" ? 2 : 1);
    expect(markup).toContain("设置不一致，请选择");
    expect(markup).toMatch(/<button[^>]*disabled=""/);
    if (mixedField === "model") expectSelected(markup, "low");
    if (mixedField === "thinking") expectSelected(markup, "inherit");
  });

  it("保留不可用旧模型的批量回显，不回退为继承主会话", () => {
    const agent = { ...structuredClone(catalog.agents[0]!), model: { mode: "fixed" as const, provider: "retired", modelId: "old/model" } };
    const markup = bulkMarkup({ ...catalog, agents: [agent] }, false);
    expectSelected(markup, "retired/old/model");
    expect(markup).toContain(">retired/old/model</option>");
    expectSelected(markup, "low");
    expect(markup).not.toMatch(/<button[^>]*disabled=""/);
  });

  it("没有代理时禁用批量应用", () => {
    expect(bulkMarkup({ ...catalog, agents: [] })).toMatch(/<button[^>]*disabled=""/);
  });
});
