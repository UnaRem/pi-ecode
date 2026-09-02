import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mapTimeline } from "./timeline-mapper.js";

describe("mapTimeline", () => {
  it("keeps text, tool calls, results, and later text in conversation order", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Update it" }], timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will read the file." },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "app.ts" } },
        ],
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "const value = 1;" }],
        isError: false,
        timestamp: 3,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "The file is ready to edit." }],
        stopReason: "stop",
        timestamp: 4,
      },
    ] as unknown as AgentMessage[];

    const timeline = mapTimeline(messages);
    expect(timeline.map((item) => item.kind)).toEqual(["message", "message", "tool", "message"]);
    expect(timeline[2]).toMatchObject({
      kind: "tool",
      tool: { id: "call-1", input: expect.stringContaining("app.ts"), output: "const value = 1;" },
    });
  });

  it("keeps images attached to their user message", () => {
    const messages = [{
      role: "user",
      content: [
        { type: "text", text: "Inspect this" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      timestamp: 1,
    }] as unknown as AgentMessage[];

    expect(mapTimeline(messages)[0]).toMatchObject({
      kind: "message",
      message: { text: "Inspect this", images: [{ mimeType: "image/png", data: "aGVsbG8=" }] },
    });
  });
});
