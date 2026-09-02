import { describe, expect, it } from "vitest";
import { formatToolInput, textFromContent, textFromToolResult, toolTitle } from "./message-mapper.js";

describe("message mapper helpers", () => {
  it("keeps only visible text blocks", () => {
    expect(textFromContent([
      { type: "thinking", thinking: "private" },
      { type: "text", text: "first" },
      { type: "toolCall", id: "1", name: "read" },
      { type: "text", text: "second" },
    ])).toBe("first\nsecond");
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
