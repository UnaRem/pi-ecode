import type { ModelOption, ThinkingLevel } from "@shared/contracts";

const THINKING_ORDER: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function resolveAgentThinkingLevels(modelValue: string, inheritedModel: string | null, models: ModelOption[]): ThinkingLevel[] {
  const modelKey = modelValue === "inherit" ? inheritedModel : modelValue;
  return models.find((model) => `${model.provider}/${model.id}` === modelKey)?.thinkingLevels ?? [];
}

export function clampAgentThinkingLevel(level: ThinkingLevel | "", supported: readonly ThinkingLevel[]): ThinkingLevel | "" {
  if (!level || supported.length === 0) return "";
  // 与 SDK 顺序一致：优先向更高等级寻找，再从当前位置向低等级寻找；混合值不自动选定。
  const index = THINKING_ORDER.indexOf(level);
  return THINKING_ORDER.slice(index).find((candidate) => supported.includes(candidate))
    ?? THINKING_ORDER.slice(0, index).reverse().find((candidate) => supported.includes(candidate))
    ?? "";
}
