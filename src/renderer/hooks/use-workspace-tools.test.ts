import { describe, expect, it } from "vitest";
import type { ConversationItem, ToolActivity } from "@shared/contracts";
import { toolsInLatestTurn } from "./use-workspace-tools";

function tool(id: string): ConversationItem {
  const activity: ToolActivity = { id, name: "read", title: id, input: id, output: id, status: "success" };
  return { kind: "tool", id, tool: activity };
}

function user(id: string): ConversationItem {
  return { kind: "message", id, message: { id, role: "user", text: id, timestamp: 1 } };
}

describe("workspace tools", () => {
  it("keeps only tools after the latest user request", () => {
    expect(toolsInLatestTurn([user("one"), tool("old"), user("two"), tool("read"), tool("test")]).map((item) => item.id))
      .toEqual(["read", "test"]);
  });

  it("uses all loaded tools when no user request is present", () => {
    expect(toolsInLatestTurn([tool("one"), tool("two")]).map((item) => item.id)).toEqual(["one", "two"]);
  });
});
