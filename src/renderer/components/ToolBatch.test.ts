import { describe, expect, it } from "vitest";
import type { ConversationItem, ToolActivity } from "@shared/contracts";
import { groupConsecutiveTools, visibleToolsInBatch } from "./ToolBatch";

function tool(id: string): ConversationItem {
  const activity: ToolActivity = {
    id,
    name: "read",
    title: `read · ${id}`,
    input: id,
    output: id,
    status: "success",
  };
  return { kind: "tool", id, tool: activity };
}

function message(id: string, role: "user" | "assistant" = "assistant"): ConversationItem {
  return { kind: "message", id, message: { id, role, text: id, timestamp: 1 } };
}

describe("groupConsecutiveTools", () => {
  it("groups only consecutive tool calls", () => {
    const groups = groupConsecutiveTools([
      message("user", "user"),
      tool("one"),
      tool("two"),
      message("commentary"),
      tool("three"),
      tool("four"),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(["message", "tools", "message", "tools"]);
    expect(groups[1]).toMatchObject({ kind: "tools", tools: [{ id: "one" }, { id: "two" }] });
    expect(groups[3]).toMatchObject({ kind: "tools", tools: [{ id: "three" }, { id: "four" }] });
  });

  it("keeps at most three calls open and otherwise shows the latest three calls", () => {
    const activities = ["one", "two", "three", "four"].map((id) => {
      const item = tool(id);
      if (item.kind !== "tool") throw new Error("Expected tool item");
      return item.tool;
    });

    expect(visibleToolsInBatch(activities.slice(0, 3), false).map((item) => item.id)).toEqual(["one", "two", "three"]);
    expect(visibleToolsInBatch(activities, false).map((item) => item.id)).toEqual(["two", "three", "four"]);
    expect(visibleToolsInBatch(activities, true).map((item) => item.id)).toEqual(["one", "two", "three", "four"]);
  });

  it("does not merge tools across a user message boundary", () => {
    const groups = groupConsecutiveTools([tool("before"), message("next-user", "user"), tool("after")]);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ kind: "tools", tools: [{ id: "before" }] });
    expect(groups[2]).toMatchObject({ kind: "tools", tools: [{ id: "after" }] });
  });
});
