import { describe, expect, it } from "vitest";
import type { ConversationItem, ToolActivity } from "./contracts.js";
import {
  confirmationDisplayText, createConfirmationResponse, findPendingConfirmation,
  matchesConfirmationResponse, parseConfirmationResponse, type PendingConfirmation,
} from "./confirmation.js";

const request: PendingConfirmation = { requestId: "confirm-1", title: "修改两个文件", message: "更新配置与入口。" };
const marker = { kind: "pi-ecode.confirmation", version: 1, status: "pending", requestId: request.requestId };

function tool(patch: Partial<ToolActivity> = {}): ConversationItem {
  return { kind: "tool", id: request.requestId, tool: {
    id: request.requestId, name: "request_confirmation", title: "request_confirmation",
    input: JSON.stringify({ title: request.title, message: request.message }),
    output: `确认请求已保存。\n${JSON.stringify(marker)}`, status: "success", ...patch,
  } };
}

function user(id: string): ConversationItem {
  return { kind: "message", id, message: { id, role: "user", text: "继续", timestamp: 1 } };
}

describe("confirmation projection", () => {
  it("restores a pending request from serialized timeline data", () => {
    const timeline = JSON.parse(JSON.stringify([tool()])) as ConversationItem[];
    expect(findPendingConfirmation(timeline)).toEqual(request);
  });

  it.each([
    { name: "read" }, { status: "running" as const }, { status: "error" as const },
    { id: "another-id" }, { input: "invalid" }, { input: JSON.stringify({ title: "", message: "说明" }) },
    { output: "The user confirmed" }, { output: JSON.stringify({ confirmed: true }) },
    { output: JSON.stringify({ ...marker, status: "confirmed" }) },
    { output: JSON.stringify({ ...marker, status: "failed" }) },
    { output: JSON.stringify({ ...marker, version: 2 }) },
    { output: JSON.stringify({ ...marker, requestId: "old-id" }) },
    { outputTruncated: true },
  ])("rejects an unrelated, legacy or invalid tool result: %j", (patch) => {
    expect(findPendingConfirmation([tool(patch)])).toBeUndefined();
  });

  it("retains pending across optimistic messages but clears it after persisted user input", () => {
    expect(findPendingConfirmation([tool(), user("pending-user-1")])).toEqual(request);
    expect(findPendingConfirmation([tool(), user("user-1")])).toBeUndefined();
  });

  it("keeps the first pending request when a repeated sibling confirmation is blocked", () => {
    expect(findPendingConfirmation([tool(), tool({ id: "duplicate", status: "error" })])).toEqual(request);
  });

  it.each([true, false])("round trips readable action and optional requirements: %s", (confirmed) => {
    const response = createConfirmationResponse(request, confirmed, "  保留原配置\n先运行验证  ");
    const display = confirmationDisplayText(response);
    expect(display).toBe(`${confirmed ? "确认执行" : "取消执行"}：修改两个文件\n补充要求：保留原配置\n先运行验证`);
    expect(display).not.toContain(request.requestId);
    expect(display).not.toContain("pi-ecode");
    const parsed = parseConfirmationResponse(response);
    expect(parsed).toMatchObject({ requestId: request.requestId, confirmed });
    expect(parsed && matchesConfirmationResponse(request, parsed)).toBe(true);
  });

  it.each(["plain text", "<pi-ecode-confirmation-response>{}</pi-ecode-confirmation-response>",
    '继续\n<pi-ecode-confirmation-response>{"requestId":"x","confirmed":"true"}</pi-ecode-confirmation-response>',
    '继续\n<pi-ecode-confirmation-response>{"requestId":"x","confirmed":true}</pi-ecode-confirmation-response> trailing',
  ])("preserves text without a valid suffix", (text) => {
    expect(confirmationDisplayText(text)).toBe(text);
  });

  it("rejects altered title, action and request identity", () => {
    const parsed = parseConfirmationResponse(createConfirmationResponse(request, true, ""))!;
    expect(matchesConfirmationResponse(request, { ...parsed, requestId: "old" })).toBe(false);
    expect(matchesConfirmationResponse(request, { ...parsed, confirmed: false })).toBe(false);
    expect(matchesConfirmationResponse(request, { ...parsed, displayText: "确认执行：其他标题" })).toBe(false);
  });
});
