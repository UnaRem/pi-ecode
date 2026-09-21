import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectAgentCatalog } from "@shared/agent-contracts";
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

describe("AgentManager", () => {
  it("renders project agent settings without offering deletion for defaults", () => {
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: vi.fn() });
    const markup = renderToStaticMarkup(<I18nProvider><AgentManager
      catalog={catalog}
      models={[{ id: "model", provider: "provider", name: "模型", reasoning: true, supportsImages: false }]}
      onBack={vi.fn()}
      onSave={vi.fn()}
      onCreate={vi.fn()}
      onRemove={vi.fn()}
      onSetConcurrency={vi.fn()}
    /></I18nProvider>);

    expect(markup).toContain("管理代理");
    expect(markup).toContain("继承主会话");
    expect(markup).toContain("自动压缩");
    expect(markup).toContain("只读调查");
    expect(markup).toContain("write");
    expect(markup).not.toContain("删除代理");
  });
});
