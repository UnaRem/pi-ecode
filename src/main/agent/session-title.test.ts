import { describe, expect, it, vi } from "vitest";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionTitleService } from "./session-title.js";

function fixture() {
  const manager = SessionManager.inMemory("/project");
  manager.appendMessage({ role: "user", content: "修复登录问题", timestamp: 1 });
  const completeSimple = vi.fn();
  const setSessionName = vi.fn();
  const session = { sessionManager: manager, sessionId: manager.getSessionId(), sessionName: undefined,
    model: { id: "chosen", provider: "fixture" }, modelRuntime: { completeSimple }, setSessionName } as unknown as AgentSession;
  const onError = vi.fn();
  const titles = new SessionTitleService(onError);
  return { session, titles, completeSimple, setSessionName, onError };
}

const response = { stopReason: "stop", content: [{ type: "text", text: "登录问题修复" }] };

describe("automatic session titles", () => {
  it("uses the selected model once and persists the resulting title", async () => {
    const test = fixture();
    test.completeSimple.mockResolvedValue(response);
    test.titles.start(test.session, "修复登录问题", () => true);
    test.titles.start(test.session, "修复登录问题", () => true);
    await vi.waitFor(() => expect(test.setSessionName).toHaveBeenCalledWith("登录问题修复"));
    expect(test.completeSimple).toHaveBeenCalledTimes(1);
    expect(test.completeSimple.mock.calls[0]?.[0]).toBe(test.session.model);
  });

  it.each(["renamed", "replaced", "cancelled"])("does not overwrite a %s session", async (condition) => {
    const test = fixture();
    let finish!: (result: typeof response) => void;
    test.completeSimple.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    let current = true;
    test.titles.start(test.session, "修复登录问题", () => current);
    if (condition === "renamed") Object.assign(test.session, { sessionName: "我的标题" });
    if (condition === "replaced") current = false;
    if (condition === "cancelled") test.titles.cancel(test.session.sessionId);
    finish(response);
    await Promise.resolve();
    await Promise.resolve();
    expect(test.setSessionName).not.toHaveBeenCalled();
  });

  it("does not start an untracked request when its attempt cannot be persisted", () => {
    const test = fixture();
    vi.spyOn(test.session.sessionManager, "appendCustomEntry").mockImplementation(() => { throw new Error("disk full"); });
    expect(() => test.titles.start(test.session, "修复登录问题", () => true)).not.toThrow();
    expect(test.completeSimple).not.toHaveBeenCalled();
    expect(test.titles.hasPending).toBe(false);
    expect(test.onError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  });

  it("reports failures without renaming or retrying", async () => {
    const test = fixture();
    test.completeSimple.mockRejectedValue(new Error("offline"));
    test.titles.start(test.session, "修复登录问题", () => true);
    await vi.waitFor(() => expect(test.onError).toHaveBeenCalledWith(expect.stringContaining("offline")));
    test.titles.start(test.session, "修复登录问题", () => true);
    expect(test.completeSimple).toHaveBeenCalledTimes(1);
    expect(test.setSessionName).not.toHaveBeenCalled();
  });
});
