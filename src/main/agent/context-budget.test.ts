import { describe, expect, it } from "vitest";
import {
  ACTIVE_CONTEXT_BUDGET_TOKENS,
  configuredCompactionReserveTokens,
  contextBudgetReached,
  contextBudgetReserveTokens,
} from "./context-budget.js";

describe("context budget", () => {
  it("caps a 1.05M model at 200K active tokens", () => {
    expect(contextBudgetReserveTokens(1_050_000, 16_384)).toBe(850_000);
  });

  it("preserves a stricter configured reserve", () => {
    expect(contextBudgetReserveTokens(1_050_000, 900_000)).toBe(900_000);
  });

  it("uses project, global, then SDK default reserve precedence", () => {
    expect(configuredCompactionReserveTokens(
      { compaction: { reserveTokens: 20_000 } },
      { compaction: { reserveTokens: 30_000 } },
    )).toBe(30_000);
    expect(configuredCompactionReserveTokens({ compaction: { reserveTokens: 20_000 } }, {})).toBe(20_000);
    expect(configuredCompactionReserveTokens({}, {})).toBe(16_384);
  });

  it("treats 200K as the inclusive budget boundary", () => {
    expect(contextBudgetReached(ACTIVE_CONTEXT_BUDGET_TOKENS - 1)).toBe(false);
    expect(contextBudgetReached(ACTIVE_CONTEXT_BUDGET_TOKENS)).toBe(true);
    expect(contextBudgetReached(null)).toBe(false);
  });
});
