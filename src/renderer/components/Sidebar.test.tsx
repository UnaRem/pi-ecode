import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { language: "zh-CN", title: "新对话", justNow: "刚刚", hint: "发送消息开始对话" },
    { language: "en", title: "New conversation", justNow: "Just now", hint: "Send a message to start" },
  ])("renders a clean unsaved conversation in $language", ({ language, title, justNow, hint }) => {
    vi.stubGlobal("localStorage", { getItem: () => language, setItem: vi.fn() });
    const markup = renderToStaticMarkup(<I18nProvider><Sidebar
      projectName="demo" projectPath="C:/demo" iconSrc="./ecode-icon.png" activeSessionFile="new.jsonl"
      sessions={[{ path: "new.jsonl", id: "new", title: "New conversation", modifiedAt: Date.now(), messageCount: 0, byteSize: null, runStatus: "idle" }]}
      disabled={false} taskPlan={null} settingsActive={false} open onChooseProject={vi.fn()} onNewSession={vi.fn()}
      onSwitchSession={vi.fn()} onDeleteSession={vi.fn()} onOpenSettings={vi.fn()} onCollapse={vi.fn()}
    /></I18nProvider>);
    expect(markup).toContain(`<span class="session-title">${title}</span>`);
    expect(markup).toContain(`<time>${justNow}</time>`);
    expect(markup).toContain(hint);
    expect(markup).toContain('aria-current="page"');
    expect(markup).not.toContain("大小未知");
    expect(markup).not.toContain("Size unknown");
    expect(markup).not.toContain('class="session-run-status idle"');
  });

  it("preserves renamed empty conversations and titles from saved history", () => {
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: vi.fn() });
    const markup = renderToStaticMarkup(<I18nProvider><Sidebar
      projectName="demo" projectPath="C:/demo" iconSrc="./ecode-icon.png" activeSessionFile="named.jsonl"
      sessions={[
        { path: "named.jsonl", id: "named", title: "我的空白任务", modifiedAt: Date.now(), messageCount: 0, byteSize: null, runStatus: "idle" },
        { path: "saved.jsonl", id: "saved", title: "New conversation", modifiedAt: Date.now(), messageCount: 1, byteSize: 12, runStatus: "completed" },
      ]}
      disabled={false} taskPlan={null} settingsActive={false} open onChooseProject={vi.fn()} onNewSession={vi.fn()}
      onSwitchSession={vi.fn()} onDeleteSession={vi.fn()} onOpenSettings={vi.fn()} onCollapse={vi.fn()}
    /></I18nProvider>);
    expect(markup).toContain('<span class="session-title">我的空白任务</span>');
    expect(markup).toContain('<span class="session-title">New conversation</span>');
    expect(markup.match(/发送消息开始对话/g)).toHaveLength(1);
    expect(markup).toContain('class="session-run-status completed"');
  });

  it("offers deletion only for inactive sessions", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <Sidebar
          projectName="demo"
          projectPath="C:/demo"
          iconSrc="./ecode-icon.png"
          sessions={[
            { path: "active.jsonl", id: "active", title: "Active", modifiedAt: 2, messageCount: 1 },
            { path: "inactive.jsonl", id: "inactive", title: "Inactive", modifiedAt: 1, messageCount: 1 },
          ]}
          activeSessionFile="active.jsonl"
          disabled={false}
          taskPlan={null}
          settingsActive={false}
          open
          onChooseProject={vi.fn()}
          onNewSession={vi.fn()}
          onSwitchSession={vi.fn()}
          onDeleteSession={vi.fn()}
          onOpenSettings={vi.fn()}
          onCollapse={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(markup.match(/aria-label="Delete conversation"/g)).toHaveLength(1);
    expect(markup).toContain('class="session-row active"');
    expect(markup).toContain('aria-hidden="false"');
    expect(markup).not.toContain("inert");
    expect(markup).toContain('class="sidebar-task-work-status idle"');
    expect(markup).toContain('aria-label="Idle"');
    expect(markup).not.toContain("sidebar-task-section");
  });

  it("shows the exact reminder boundary and keeps parallel navigation enabled during a run", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(<I18nProvider><Sidebar
      projectName="demo" projectPath="C:/demo" iconSrc="./ecode-icon.png" activeSessionFile="large.jsonl"
      sessions={[
        { path: "small.jsonl", id: "small", title: "Small", modifiedAt: 1, messageCount: 1, byteSize: 10 * 1024 * 1024 - 1 },
        { path: "large.jsonl", id: "large", title: "Large", modifiedAt: 2, messageCount: 1, byteSize: 10 * 1024 * 1024, runStatus: "running" },
      ]}
      disabled parallel={{ maxRunning: 2, runningCount: 1, canCreate: true, reason: null }}
      taskPlan={null} settingsActive={false} open onStopSession={vi.fn()} onChooseProject={vi.fn()} onNewSession={vi.fn()}
      onSwitchSession={vi.fn()} onDeleteSession={vi.fn()} onOpenSettings={vi.fn()} onCollapse={vi.fn()}
    /></I18nProvider>);
    expect(markup.match(/Consider a new thread/g)).toHaveLength(1);
    expect(markup).toContain("10.0 MiB");
    expect(markup).toContain("1/2 running");
    expect(markup).toContain('aria-label="Stop “Large”"');
    expect(markup).not.toMatch(/class="session-row-main"[^>]*disabled/u);
    expect(markup).not.toMatch(/class="new-thread-button"[^>]*disabled/u);
  });

  it("keeps the sidebar mounted and animates collapse through a reversible transition", () => {
    const stylesheet = readFileSync(new URL("../styles/components/legacy.css", import.meta.url), "utf8");
    expect(stylesheet).toMatch(/\.sidebar\s*\{[^}]*margin-left:\s*calc\(0px - var\(--sidebar-width\)\);[^}]*opacity:\s*0;/u);
    expect(stylesheet).toMatch(/\.app-shell\.sidebar-visible \.sidebar\s*\{[^}]*margin-left:\s*0;[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/u);
    expect(stylesheet).not.toContain("@keyframes sidebar-enter");
    expect(stylesheet).not.toContain(".sidebar.closing");
  });
});
