import { describe, expect, it } from "vitest";
import type { ConversationItem } from "@shared/contracts";
import { createPastedTextAttachment, serializePastedTexts } from "../../shared/pasted-text";
import { INITIAL_AGENT_STATE, optimisticTimeline, reduceAgentEvent, type AgentViewState } from "./agent-state";

const initial: AgentViewState = { ...INITIAL_AGENT_STATE, projectPath: "C:/demo", sessionId: "session-1" };
const image = { id: "image-1", fileName: "sample.png", mimeType: "image/png" as const, data: "aGVsbG8=" };

function send(state: AgentViewState, id = "send-1", text = "Fix it"): AgentViewState {
  return reduceAgentEvent(state, { type: "prompt-started", prompt: { id, text, images: [image], timestamp: 1 } });
}

function user(id = "user-10-0", text = "Fix it"): ConversationItem {
  return { kind: "message", id, message: { id, role: "user", text, timestamp: 10 } };
}

describe("optimistic prompts", () => {
  it("shows text and attachments before any server response without altering authoritative history", () => {
    const state = send(initial);
    expect(state.timeline).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(optimisticTimeline(state)).toEqual([{
      kind: "message", id: "send-1",
      message: { id: "send-1", role: "user", text: "Fix it", timestamp: 1, images: [image], pastedTexts: [] },
    }]);
  });

  it("renders serialized pasted text as an attachment immediately", () => {
    const pasted = createPastedTextAttachment("abcdef-1234", "long text");
    const state = send(initial, "send-1", serializePastedTexts("Review", [pasted]));
    expect(optimisticTimeline(state)[0]).toMatchObject({ message: { text: "Review", pastedTexts: [{ content: "long text" }] } });
  });

  it("confirms only one repeated send and ignores duplicate live events", () => {
    let state = send(send(initial), "send-2");
    state = reduceAgentEvent(state, { type: "timeline-upsert", item: user() });
    expect(state.pendingPrompts.map((prompt) => prompt.id)).toEqual(["send-2"]);
    state = reduceAgentEvent(state, { type: "timeline-upsert", item: user() });
    expect(optimisticTimeline(state)).toHaveLength(2);
    expect(state.pendingPrompts).toHaveLength(1);
  });

  it("uses the authoritative transformed text when a user event arrives", () => {
    const state = reduceAgentEvent(send(initial), { type: "timeline-upsert", item: user("user-10-0", "Expanded prompt") });
    expect(state.pendingPrompts).toEqual([]);
    expect(optimisticTimeline(state)[0]).toMatchObject({ message: { text: "Expanded prompt" } });
  });

  it("does not confirm a queued send again when a snapshot changes live message IDs", () => {
    let state = reduceAgentEvent(send(send(initial), "send-2"), { type: "timeline-upsert", item: user() });
    state = reduceAgentEvent(state, { type: "snapshot", snapshot: { ...initial, timeline: [user("user-10-5")] } });
    expect(state.pendingPrompts.map((prompt) => prompt.id)).toEqual(["send-2"]);
    expect(optimisticTimeline(state)).toHaveLength(2);
  });

  it("retains unaccepted sends across an unrelated snapshot and confirms new snapshot messages", () => {
    let state = reduceAgentEvent(send(initial), { type: "snapshot", snapshot: initial });
    expect(state.pendingPrompts).toHaveLength(1);
    state = reduceAgentEvent(state, { type: "snapshot", snapshot: { ...initial, timeline: [user()] } });
    expect(state.pendingPrompts).toEqual([]);
  });

  it("keeps a queued send visible after IPC resolves until the user message arrives", () => {
    let state = send({ ...initial, isStreaming: true });
    state = reduceAgentEvent(state, { type: "prompt-finished", id: "send-1" });
    expect(state.pendingPrompts).toHaveLength(1);
    state = reduceAgentEvent(state, { type: "timeline-upsert", item: user() });
    expect(state.pendingPrompts).toEqual([]);
  });

  it("restores preflight failures using merge mode with their images", () => {
    const state = reduceAgentEvent(send(initial), { type: "prompt-failed", id: "send-1", error: "No credentials" });
    expect(optimisticTimeline(state)).toEqual([]);
    expect(state).toMatchObject({ error: "No credentials", restoredEditorText: "Fix it", restoredEditorImages: [image], editorRestoreMode: "merge", editorRestoreVersion: 1 });
  });

  it("collects batched failures and acknowledges restoration without duplicating subsequent failures", () => {
    let state = send(send(initial), "send-2", "Second");
    state = reduceAgentEvent(state, { type: "prompt-failed", id: "send-1", error: "Failed" });
    state = reduceAgentEvent(state, { type: "prompt-failed", id: "send-2", error: "Failed" });
    expect(state.restoredEditorText).toBe("Fix it\n\nSecond");
    state = reduceAgentEvent(state, { type: "editor-restored", version: 1 });
    expect(state.restoredEditorText).not.toBeNull();
    state = reduceAgentEvent(state, { type: "editor-restored", version: 2 });
    state = reduceAgentEvent(send(state, "send-3", "Third"), { type: "prompt-failed", id: "send-3", error: "Failed" });
    expect(state.restoredEditorText).toBe("Third");
  });

  it("does not restore a prompt after it was accepted and the model later failed", () => {
    let state = reduceAgentEvent(send(initial), { type: "timeline-upsert", item: user() });
    state = reduceAgentEvent(state, { type: "prompt-failed", id: "send-1", error: "Provider failed" });
    expect(state.restoredEditorText).toBeNull();
    expect(optimisticTimeline(state)).toHaveLength(1);
  });

  it("discards pending presentation on session change and ignores late failures", () => {
    let state = reduceAgentEvent(send(initial), { type: "snapshot", snapshot: { ...initial, sessionId: "session-2" } });
    state = reduceAgentEvent(state, { type: "prompt-failed", id: "send-1", error: "Late failure" });
    expect(state.pendingPrompts).toEqual([]);
    expect(state.restoredEditorText).toBeNull();
    expect(state.error).toBeNull();
  });

  it("restores unconsumed queued messages when the agent stops", () => {
    let state = reduceAgentEvent(send({ ...initial, isStreaming: true }), { type: "prompt-finished", id: "send-1" });
    state = reduceAgentEvent(state, { type: "state", patch: { isStreaming: false } });
    expect(state.pendingPrompts).toEqual([]);
    expect(state.restoredEditorText).toBe("Fix it");
  });

  it("removes intercepted input without inventing a persistent user message", () => {
    const state = reduceAgentEvent(send(initial), { type: "prompt-finished", id: "send-1" });
    expect(optimisticTimeline(state)).toEqual([]);
    expect(state.restoredEditorText).toBeNull();
  });
});
