import { describe, expect, it } from "vitest";
import { formatWorkingDuration } from "./Conversation";

describe("formatWorkingDuration", () => {
  it("formats elapsed time as cumulative hours, minutes, and seconds", () => {
    expect(formatWorkingDuration(0)).toBe("00:00:00");
    expect(formatWorkingDuration(3_723_999)).toBe("01:02:03");
    expect(formatWorkingDuration(97_389_000)).toBe("27:03:09");
  });
});
