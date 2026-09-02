import { describe, expect, it } from "vitest";
import { formatTokenCount } from "./CompactionStatusPanel";

describe("formatTokenCount", () => {
  it("keeps small token counts exact", () => {
    expect(formatTokenCount(842)).toBe("842");
  });

  it("formats larger contexts compactly", () => {
    expect(formatTokenCount(40_000)).toBe("40K");
    expect(formatTokenCount(102_400)).toBe("102.4K");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });
});
