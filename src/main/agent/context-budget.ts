export const ACTIVE_CONTEXT_BUDGET_TOKENS = 200_000;
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;

interface CompactionSettingsSource {
  compaction?: { reserveTokens?: number };
}

export function configuredCompactionReserveTokens(
  globalSettings: CompactionSettingsSource,
  projectSettings: CompactionSettingsSource,
): number {
  return projectSettings.compaction?.reserveTokens
    ?? globalSettings.compaction?.reserveTokens
    ?? DEFAULT_COMPACTION_RESERVE_TOKENS;
}

export function contextBudgetReserveTokens(contextWindow: number, configuredReserveTokens: number): number {
  return Math.max(1, configuredReserveTokens, contextWindow - ACTIVE_CONTEXT_BUDGET_TOKENS);
}

export function contextBudgetReached(tokens: number | null | undefined): boolean {
  return tokens !== null && tokens !== undefined && tokens >= ACTIVE_CONTEXT_BUDGET_TOKENS;
}
