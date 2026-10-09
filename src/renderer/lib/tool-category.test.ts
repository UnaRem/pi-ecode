import { describe, expect, it } from "vitest";
import { toolCategory } from "./tool-category";

describe("toolCategory", () => {
  it("classifies built-in tools by their effect", () => {
    expect(toolCategory("read", "src/App.tsx")).toBe("inspect");
    expect(toolCategory("edit", "src/App.tsx")).toBe("mutate");
    expect(toolCategory("bash", "npm test")).toBe("execute");
    expect(toolCategory("web_search", "query")).toBe("research");
    expect(toolCategory("task_plan", "")).toBe("plan");
  });

  it("classifies managed process starts as execution regardless of command text", () => {
    expect(toolCategory("start_process", "bun run dev")).toBe("execute");
    expect(toolCategory("START_PROCESS", "git daemon")).toBe("execute");
  });

  it("recognizes git commands without treating every shell command as version work", () => {
    expect(toolCategory("bash", " git status --short")).toBe("version");
    expect(toolCategory("bash", "npm run build && git status")).toBe("execute");
    expect(toolCategory("third_party", "")).toBe("other");
  });
});
