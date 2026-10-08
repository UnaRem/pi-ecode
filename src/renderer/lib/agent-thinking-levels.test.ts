import { describe, expect, it } from "vitest";
import type { ModelOption, ThinkingLevel } from "@shared/contracts";
import { clampAgentThinkingLevel, resolveAgentThinkingLevels } from "./agent-thinking-levels";

const models: ModelOption[] = [
  { provider: "provider", id: "reasoner", name: "推理模型", reasoning: true, supportsImages: false, thinkingLevels: ["off", "low", "high", "max"] },
  { provider: "provider", id: "plain", name: "普通模型", reasoning: false, supportsImages: false, thinkingLevels: ["off"] },
  { provider: "provider", id: "unknown", name: "未知能力", reasoning: true, supportsImages: false, thinkingLevels: [] },
];

describe("resolveAgentThinkingLevels", () => {
  it("继承当前主模型能力，固定模型独立解析", () => {
    expect(resolveAgentThinkingLevels("inherit", "provider/reasoner", models)).toEqual(["off", "low", "high", "max"]);
    expect(resolveAgentThinkingLevels("provider/plain", "provider/reasoner", models)).toEqual(["off"]);
    expect(resolveAgentThinkingLevels("provider/reasoner", null, models)).not.toContain("xhigh");
  });

  it.each([null, "missing/model"])("未知继承模型不猜测等级：%s", (inheritedModel) => {
    expect(resolveAgentThinkingLevels("inherit", inheritedModel, models)).toEqual([]);
  });

  it("混合模型、旧模型及空能力均保持未知", () => {
    for (const modelValue of ["", "retired/model", "provider/unknown"]) {
      expect(resolveAgentThinkingLevels(modelValue, "provider/reasoner", models)).toEqual([]);
    }
  });
});

describe("clampAgentThinkingLevel", () => {
  it.each([
    { level: "high", supported: ["high", "max"], expected: "high" },
    { level: "xhigh", supported: ["high", "max"], expected: "max" },
    { level: "medium", supported: ["low", "max", "high"], expected: "high" },
    { level: "max", supported: ["low", "high"], expected: "high" },
    { level: "high", supported: ["off"], expected: "off" },
    { level: "high", supported: [], expected: "" },
    { level: "", supported: ["off", "high"], expected: "" },
  ] satisfies { level: ThinkingLevel | ""; supported: ThinkingLevel[]; expected: ThinkingLevel | "" }[])("按全档顺序约束等级：%j", ({ level, supported, expected }) => {
    expect(clampAgentThinkingLevel(level, supported)).toBe(expected);
  });
});
