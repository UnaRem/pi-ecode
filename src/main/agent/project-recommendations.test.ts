import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../../shared/contracts.js";
import { parseProjectRecommendations, ProjectRecommendationService, type RecommendationModelContext } from "./project-recommendations.js";

const directories: string[] = [];
const result = { summary: "已完成会话切换优化，工具反馈仍需核对。", suggestions: [
  { title: "核对近期工具反馈", description: "根据最近的使用记录检查误报。", prompt: "检查近期工具反馈的误报，先定位再提出最小修复。" },
] };
const response = { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(result) }] };

function entry(id: string, parentId: string | null, role: string, content: unknown, timestamp: number, stopReason = "stop") {
  return { type: "message", id, parentId, message: { role, content, timestamp, stopReason } };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-ecode-recommendations-"));
  directories.push(directory);
  const completeSimple = vi.fn().mockResolvedValue(response);
  const context = { model: { provider: "fixture", id: "selected" }, runtime: { completeSimple } } as unknown as RecommendationModelContext;
  const changed = vi.fn();
  const recommendations = new ProjectRecommendationService(changed);
  const save = async (name: string, entries: unknown[], modifiedAt = Date.now()): Promise<SessionSummary> => {
    const path = join(directory, `${name}.jsonl`);
    await writeFile(path, entries.map((value) => JSON.stringify(value)).join("\n") + "\n");
    return { path, id: name, title: name, modifiedAt, messageCount: entries.length, byteSize: (await stat(path)).size };
  };
  const start = (sessions: SessionSummary[]) => recommendations.start({ projectPath: directory, sessions, context });
  return { directory, context, completeSimple, changed, recommendations, save, start };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("recent project recommendations", () => {
  it("uses the selected model and only recent user messages and final answers on the current branch", async () => {
    const test = await fixture();
    const now = Date.now();
    const session = await test.save("recent", [
      entry("old", null, "user", "OLD_PRIVATE_TOPIC", now - 8 * 86_400_000),
      entry("user", "old", "user", "修复会话切换", now),
      entry("working", "user", "assistant", [{ type: "text", text: "INTERMEDIATE_TEXT" }], now, "toolUse"),
      entry("tool", "working", "toolResult", [{ type: "text", text: "PRIVATE_TOOL_OUTPUT" }], now),
      entry("final", "tool", "assistant", [{ type: "text", text: "会话切换已经修复" }, { type: "thinking", thinking: "PRIVATE_THINKING" }], now),
      entry("abandoned", "final", "user", "ABANDONED_REQUEST", now),
      entry("alternative", "abandoned", "assistant", [{ type: "text", text: "ABANDONED_ANSWER" }], now),
      entry("current", "final", "user", "核对工具反馈", now),
      entry("answer", "current", "assistant", [{ type: "text", text: "工具反馈仍需继续核对" }], now),
    ]);
    test.start([session]);
    expect(test.recommendations.state.status).toBe("loading");
    await vi.waitFor(() => expect(test.changed).toHaveBeenCalledOnce());
    expect(test.completeSimple.mock.calls[0]?.[0]).toBe(test.context.model);
    const transcript = test.completeSimple.mock.calls[0]?.[1].messages[0].content[0].text as string;
    expect(transcript).toContain("修复会话切换");
    expect(transcript).toContain("会话切换已经修复");
    expect(transcript).toContain("工具反馈仍需继续核对");
    for (const excluded of ["OLD_PRIVATE_TOPIC", "INTERMEDIATE_TEXT", "PRIVATE_TOOL_OUTPUT", "PRIVATE_THINKING", "ABANDONED_REQUEST", "ABANDONED_ANSWER"]) {
      expect(transcript).not.toContain(excluded);
    }
    expect(test.recommendations.state).toEqual({ ...result, status: "ready", error: null });
    expect(test.start([session])).toBe(false);
    expect(test.completeSimple).toHaveBeenCalledOnce();
    test.recommendations.cancel();
  });

  it("ignores old, running, waiting and unsaved histories without making model requests", async () => {
    const test = await fixture();
    const now = Date.now();
    const base = { path: "unreadable.jsonl", id: "ignored", title: "ignored", messageCount: 1, byteSize: 128, modifiedAt: now };
    test.start([
      { ...base, modifiedAt: now - 8 * 86_400_000 },
      { ...base, runStatus: "running" },
      { ...base, runStatus: "waiting" },
      { ...base, byteSize: null },
      { ...base, messageCount: 0 },
    ]);
    expect(test.recommendations.state.status).toBe("empty");
    expect(test.completeSimple).not.toHaveBeenCalled();
  });

  it("reads bounded tails even when earlier records contain very large tool output", async () => {
    const test = await fixture();
    const now = Date.now();
    const session = await test.save("large", [
      entry("huge", null, "toolResult", [{ type: "text", text: "X".repeat(2 * 1024 * 1024) }], now),
      entry("user", "huge", "user", "RECENT_TASK", now),
      entry("final", "user", "assistant", [{ type: "text", text: "RECENT_FINAL" }], now),
    ]);
    test.start([session]);
    await vi.waitFor(() => expect(test.changed).toHaveBeenCalledOnce());
    const transcript = test.completeSimple.mock.calls[0]?.[1].messages[0].content[0].text as string;
    expect(transcript).toContain("RECENT_TASK");
    expect(transcript).toContain("RECENT_FINAL");
    expect(transcript.length).toBeLessThan(32_100);
    expect(transcript).not.toContain("XXXXX");
    test.recommendations.cancel();
  });

  it("limits history to the newest 20 sessions", async () => {
    const test = await fixture();
    const now = Date.now();
    const sessions = await Promise.all(Array.from({ length: 24 }, (_, index) => test.save(`topic-${index}`,
      [entry(`u${index}`, null, "user", `TASK_${index}_END`, now)], now - index * 1000)));
    test.start(sessions.reverse());
    await vi.waitFor(() => expect(test.changed).toHaveBeenCalledOnce());
    const transcript = test.completeSimple.mock.calls[0]?.[1].messages[0].content[0].text as string;
    expect(transcript.match(/Conversation:/gu)).toHaveLength(20);
    expect(transcript).toContain("TASK_0_END");
    expect(transcript).toContain("TASK_19_END");
    expect(transcript).not.toContain("TASK_20_END");
    test.recommendations.cancel();
  });

  it.each(["success", "timeout"])("gives the model its own 120-second budget: %s", async (outcome) => {
    const test = await fixture();
    const session = await test.save("slow", [entry("user", null, "user", "Recent work", Date.now())]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Native AbortSignal.timeout uses Node's internal timers; adapt just that boundary to the test clock.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const deadline = new AbortController();
      setTimeout(() => deadline.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
      return deadline.signal;
    });
    let finish!: (value: typeof response) => void;
    test.completeSimple.mockImplementationOnce((_model: unknown, _request: unknown, options: { signal: AbortSignal }) =>
      new Promise<typeof response>((resolve) => {
        finish = resolve;
        options.signal.addEventListener("abort", () => resolve({ ...response, stopReason: "aborted" }), { once: true });
      }));
    test.start([session]);
    expect(timeout).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(test.completeSimple).toHaveBeenCalledOnce());
    expect(timeout).toHaveBeenCalledWith(120_000);
    const signal = test.completeSimple.mock.calls[0]?.[2].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(signal.aborted).toBe(false);
    expect(test.recommendations.state.status).toBe("loading");
    if (outcome === "success") {
      finish(response);
      await vi.waitFor(() => expect(test.recommendations.state.status).toBe("ready"));
      expect(test.recommendations.state.suggestions).toEqual(result.suggestions);
    } else {
      await vi.advanceTimersByTimeAsync(88_000);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(signal.aborted).toBe(true);
      await vi.waitFor(() => expect(test.recommendations.state.status).toBe("error"));
      expect(test.recommendations.state.error).toBe("近期工作总结超过 120 秒，请稍后重新进入项目再次生成。");
    }
    expect(test.changed).toHaveBeenCalledOnce();
    test.recommendations.cancel();
  });

  it("cancels obsolete requests and never publishes their late results", async () => {
    const test = await fixture();
    const session = await test.save("task", [entry("user", null, "user", "Recent work", Date.now())]);
    let finish!: (value: typeof response) => void;
    const pending = new Promise<typeof response>((resolve) => { finish = resolve; });
    test.completeSimple.mockReturnValueOnce(pending);
    test.start([session]);
    await vi.waitFor(() => expect(test.completeSimple).toHaveBeenCalledOnce());
    const oldSignal = test.completeSimple.mock.calls[0]?.[2].signal as AbortSignal;
    test.recommendations.start({ projectPath: `${test.directory}-other`, sessions: [], context: test.context });
    expect(oldSignal.aborted).toBe(true);
    finish(response);
    await pending;
    await Promise.resolve();
    await Promise.resolve();
    expect(test.recommendations.state.status).toBe("empty");
    expect(test.changed).not.toHaveBeenCalled();
  });

  it("regenerates when history changes and exposes failures without repeated requests", async () => {
    const test = await fixture();
    const session = await test.save("task", [entry("user", null, "user", "Recent work", Date.now())]);
    test.start([session]);
    await vi.waitFor(() => expect(test.recommendations.state.status).toBe("ready"));
    test.completeSimple.mockRejectedValueOnce(new Error("Provider offline"));
    const changed = { ...session, byteSize: session.byteSize! + 1 };
    test.start([changed]);
    await vi.waitFor(() => expect(test.recommendations.state.status).toBe("error"));
    expect(test.recommendations.state.error).toBe("Provider offline");
    expect(test.start([changed])).toBe(false);
    expect(test.completeSimple).toHaveBeenCalledTimes(2);
    test.recommendations.cancel();
  });

  it("skips model requests when bounded history contains no recent readable messages", async () => {
    const test = await fixture();
    const session = await test.save("metadata", [{ type: "custom", id: "setup", parentId: null }]);
    test.start([session]);
    await vi.waitFor(() => expect(test.changed).toHaveBeenCalledOnce());
    expect(test.recommendations.state.status).toBe("empty");
    expect(test.completeSimple).not.toHaveBeenCalled();
    test.recommendations.cancel();
  });
});

describe("recommendation response validation", () => {
  it("allows variable suggestion counts and fenced JSON", () => {
    expect(parseProjectRecommendations(`\`\`\`json\n${JSON.stringify(result)}\n\`\`\``).suggestions).toHaveLength(1);
    expect(parseProjectRecommendations(JSON.stringify({ summary: "Recent work is complete.", suggestions: [] })).suggestions).toEqual([]);
  });

  it.each([
    "not JSON",
    JSON.stringify({ summary: "", suggestions: [] }),
    JSON.stringify({ summary: "Summary", suggestions: [{ title: "Title", description: "Description" }] }),
    JSON.stringify({ summary: "Summary", suggestions: Array(5).fill(result.suggestions[0]) }),
  ])("rejects malformed or oversized recommendation lists", (text) => {
    expect(() => parseProjectRecommendations(text)).toThrow();
  });
});
