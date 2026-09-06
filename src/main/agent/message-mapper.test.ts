import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createPastedTextAttachment, serializePastedTexts } from "../../shared/pasted-text.js";
import { formatToolInput, mapMessages, textFromContent, textFromToolResult, toolTitle } from "./message-mapper.js";

describe("message mapper helpers", () => {
  it("keeps only visible text blocks", () => {
    expect(textFromContent([
      { type: "thinking", thinking: "private" },
      { type: "text", text: "first" },
      { type: "toolCall", id: "1", name: "read" },
      { type: "text", text: "second" },
    ])).toBe("first\nsecond");
  });

  it("maps pasted text attachments into the message snapshot", () => {
    const text = serializePastedTexts("Review", [
      createPastedTextAttachment("11111111-1111-4111-8111-111111111111", "attached content"),
    ]);
    const messages = [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }] as unknown as AgentMessage[];

    expect(mapMessages(messages).messages[0]).toMatchObject({
      text: "Review",
      pastedTexts: [{ content: "attached content" }],
    });
  });

  it("formats shell commands directly and other inputs as JSON", () => {
    expect(formatToolInput({ command: "npm test" })).toBe("npm test");
    expect(formatToolInput({ path: "src/App.tsx", offset: 1 })).toContain('"path": "src/App.tsx"');
  });

  it("extracts text from tool results and creates compact titles", () => {
    expect(textFromToolResult({ content: [{ type: "text", text: "done" }] })).toBe("done");
    expect(toolTitle("read", { path: "src/main/index.ts" })).toBe("read · src/main/index.ts");
  });
});
