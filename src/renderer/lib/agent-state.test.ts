import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "@shared/contracts";
import { INITIAL_AGENT_STATE, reduceAgentEvent } from "./agent-state";

const snapshot: AgentSnapshot = {
  ...INITIAL_AGENT_STATE,
  projectPath: "C:/work/demo",
  projectName: "demo",
  sessionId: "session-1",
  sessionFile: "session.jsonl",
};

describe("reduceAgentEvent", () => {
  it("assembles streaming text and clears it on the final message", () => {
    let state = reduceAgentEvent(INITIAL_AGENT_STATE, { type: "snapshot", snapshot });
    state = reduceAgentEvent(state, { type: "assistant-delta", delta: "Hello " });
    state = reduceAgentEvent(state, { type: "assistant-delta", delta: "world" });
    expect(state.liveAssistant).toBe("Hello world");

    state = reduceAgentEvent(state, {
      type: "message",
      message: { id: "answer-1", role: "assistant", text: "Hello world", timestamp: 1 },
    });
    expect(state.liveAssistant).toBe("");
    expect(state.messages.at(-1)?.text).toBe("Hello world");
  });

  it("keeps assistant segments and tools in streamed timeline order", () => {
    let state = reduceAgentEvent(INITIAL_AGENT_STATE, {
      type: "timeline-upsert",
      item: {
        kind: "message",
        id: "assistant-part-1",
        message: { id: "assistant-part-1", role: "assistant", text: "I will inspect it.", timestamp: 1 },
      },
    });
    state = reduceAgentEvent(state, {
      type: "timeline-upsert",
      item: {
        kind: "tool",
        id: "call-1",
        tool: { id: "call-1", name: "read", title: "read · app.ts", input: "app.ts", output: "line 1", status: "running" },
      },
    });
    state = reduceAgentEvent(state, {
      type: "timeline-upsert",
      item: {
        kind: "message",
        id: "assistant-part-2",
        message: { id: "assistant-part-2", role: "assistant", text: "Now I will edit it.", timestamp: 2 },
      },
    });
    state = reduceAgentEvent(state, {
      type: "timeline-upsert",
      item: {
        kind: "tool",
        id: "call-1",
        tool: { id: "call-1", name: "read", title: "read · app.ts", input: "app.ts", output: "line 1\nline 2", status: "success" },
      },
    });

    expect(state.timeline.map((item) => item.kind)).toEqual(["message", "tool", "message"]);
    expect(state.timeline[1]).toMatchObject({ kind: "tool", tool: { status: "success", output: "line 1\nline 2" } });
  });

  it("replaces tool progress by call id", () => {
    const running = reduceAgentEvent(INITIAL_AGENT_STATE, {
      type: "tool",
      tool: { id: "call-1", name: "bash", title: "bash · npm test", input: "npm test", output: "", status: "running" },
    });
    const finished = reduceAgentEvent(running, {
      type: "tool",
      tool: { id: "call-1", name: "bash", title: "bash · npm test", input: "npm test", output: "passed", status: "success" },
    });
    expect(finished.tools).toHaveLength(1);
    expect(finished.tools[0]).toMatchObject({ output: "passed", status: "success" });
  });

  it("applies task plan updates without changing the conversation timeline", () => {
    const taskPlan = {
      title: "Implement feature",
      items: [{ id: "build", text: "Build it", status: "in_progress" as const }],
      updatedAt: 1,
    };
    const state = reduceAgentEvent(INITIAL_AGENT_STATE, { type: "task-plan", taskPlan });
    expect(state.taskPlan).toEqual(taskPlan);
    expect(state.timeline).toEqual([]);
  });

  it("tracks the active extension UI request", () => {
    const request = { id: "question-1", method: "select" as const, title: "Choose", options: [{ value: "one", label: "One" }] };
    const opened = reduceAgentEvent(INITIAL_AGENT_STATE, { type: "extension-ui", request });
    expect(opened.extensionUi).toEqual(request);
    expect(reduceAgentEvent(opened, { type: "extension-ui", request: null }).extensionUi).toBeNull();
  });

  it("restores text and images to the composer after undo", () => {
    const restored = reduceAgentEvent(INITIAL_AGENT_STATE, {
      type: "history",
      history: INITIAL_AGENT_STATE.history,
      editorText: "Inspect this",
      editorImages: [{ id: "image-1", fileName: "image.png", mimeType: "image/png", data: "aGVsbG8=" }],
    });
    expect(restored.restoredEditorText).toBe("Inspect this");
    expect(restored.restoredEditorImages).toHaveLength(1);
    expect(restored.editorRestoreVersion).toBe(1);
  });

  it("applies structured compaction progress updates", () => {
    const compaction = {
      status: "running" as const,
      reason: "threshold" as const,
      method: "native" as const,
      tokensBefore: 102_400,
    };
    const state = reduceAgentEvent(INITIAL_AGENT_STATE, {
      type: "context",
      context: { ...INITIAL_AGENT_STATE.context, isCompacting: true, compactionMethod: "native", compaction },
    });
    expect(state.context.compaction).toEqual(compaction);
    expect(state.context.isCompacting).toBe(true);
  });

  it("shows compaction cancellation as a notice instead of an error", () => {
    const state = reduceAgentEvent({ ...INITIAL_AGENT_STATE, error: "old error" }, {
      type: "notice",
      message: "Context compaction cancelled.",
    });
    expect(state.notice).toBe("Context compaction cancelled.");
    expect(state.error).toBeNull();
  });

  it("tracks whether an interrupted response can continue", () => {
    const interrupted = reduceAgentEvent(INITIAL_AGENT_STATE, {
      type: "state",
      patch: { error: "502 Bad Gateway", canContinue: true },
    });
    expect(interrupted.error).toBe("502 Bad Gateway");
    expect(interrupted.canContinue).toBe(true);

    const resumed = reduceAgentEvent(interrupted, {
      type: "state",
      patch: { isStreaming: true, error: null, canContinue: false },
    });
    expect(resumed.canContinue).toBe(false);
    expect(resumed.error).toBeNull();
  });

  it("keeps the busy state when a recoverable error is reported", () => {
    const state = reduceAgentEvent({ ...INITIAL_AGENT_STATE, isStreaming: true }, {
      type: "error",
      message: "Temporary provider failure",
    });
    expect(state.error).toBe("Temporary provider failure");
    expect(state.isStreaming).toBe(true);
  });

  it("does not append duplicate finalized messages", () => {
    const event = {
      type: "message" as const,
      message: { id: "user-1", role: "user" as const, text: "Fix it", timestamp: 1 },
    };
    const once = reduceAgentEvent(INITIAL_AGENT_STATE, event);
    const twice = reduceAgentEvent(once, event);
    expect(twice.messages).toHaveLength(1);
  });
});
