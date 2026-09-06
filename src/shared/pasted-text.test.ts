import { describe, expect, it } from "vitest";
import {
  createPastedTextAttachment,
  parsePastedTexts,
  serializePastedTexts,
  shouldAttachPastedText,
} from "./pasted-text.js";

describe("pasted text protocol", () => {
  it("attaches text beyond either the character or line threshold", () => {
    expect(shouldAttachPastedText("a".repeat(2_000))).toBe(false);
    expect(shouldAttachPastedText("a".repeat(2_001))).toBe(true);
    expect(shouldAttachPastedText(Array.from({ length: 20 }, () => "line").join("\n"))).toBe(false);
    expect(shouldAttachPastedText(Array.from({ length: 21 }, () => "line").join("\n"))).toBe(true);
  });

  it("round trips multiple attachments without exposing protocol markers", () => {
    const attachments = [
      createPastedTextAttachment("11111111-1111-4111-8111-111111111111", "first\ntext"),
      createPastedTextAttachment("22222222-2222-4222-8222-222222222222", "second text"),
    ];

    const serialized = serializePastedTexts("Review these", attachments);
    const parsed = parsePastedTexts(serialized);

    expect(serialized).toContain("Pasted text #1:");
    expect(parsed.message).toBe("Review these");
    expect(parsed.attachments).toEqual(attachments);
  });

  it("leaves ordinary user text unchanged", () => {
    expect(parsePastedTexts("ordinary text")).toEqual({ message: "ordinary text", attachments: [] });
  });
});
