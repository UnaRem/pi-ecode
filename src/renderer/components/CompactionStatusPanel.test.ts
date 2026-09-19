import { describe, expect, it } from "vitest";
import { formatTokenCount, isFreshCompactionResult } from "./CompactionStatusPanel";

describe("CompactionStatusPanel helpers", () => {
  it("keeps small token counts exact", () => {
    expect(formatTokenCount(842)).toBe("842");
  });

  it("surfaces only terminal results reached from a live compaction", () => {
    expect(isFreshCompactionResult("running", "completed")).toBe(true);
    expect(isFreshCompactionResult("running", "failed")).toBe(true);
    expect(isFreshCompactionResult("running", "cancelled")).toBe(true);
    expect(isFreshCompactionResult("completed", "completed")).toBe(false);
    expect(isFreshCompactionResult("idle", "completed")).toBe(false);
    expect(isFreshCompactionResult("running", "idle")).toBe(false);
  });

  it("formats larger contexts compactly", () => {
    expect(formatTokenCount(40_000)).toBe("40K");
    expect(formatTokenCount(102_400)).toBe("102.4K");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });
});
