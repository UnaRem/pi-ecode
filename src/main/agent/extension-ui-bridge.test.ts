import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionUiRequest } from "../../shared/contracts.js";
import { ExtensionUiBridge } from "./extension-ui-bridge.js";

function createHarness() {
  const requests: Array<ExtensionUiRequest | null> = [];
  const notices: string[] = [];
  const bridge = new ExtensionUiBridge(
    (request) => requests.push(request),
    (message) => notices.push(message),
  );
  const context = bridge.createContext({} as ExtensionUIContext);
  return { bridge, context, requests, notices };
}

describe("ExtensionUiBridge", () => {
  it("resolves a select request only from the active request id", async () => {
    const test = createHarness();
    const result = test.context.select("Choose", ["One", "Two"]);
    const request = test.requests[0];
    if (!request) throw new Error("Expected a UI request");

    expect(test.bridge.respond({ requestId: "stale", value: "One" })).toBe(false);
    expect(test.bridge.respond({ requestId: request.id, value: "Unknown" })).toBe(false);
    expect(test.bridge.respond({ requestId: request.id, value: "Two" })).toBe(true);
    await expect(result).resolves.toBe("Two");
    expect(test.requests.at(-1)).toBeNull();
  });

  it("cancels pending input without leaving its promise unresolved", async () => {
    const test = createHarness();
    const result = test.context.input("Explain", "Type here");

    test.bridge.cancelPending();

    await expect(result).resolves.toBeUndefined();
    expect(test.bridge.current).toBeNull();
  });

  it("enriches rpiv multi-select input with checkbox metadata", async () => {
    const test = createHarness();
    test.bridge.setQuestionnaireMetadata({
      questions: [{
        question: "Which checks?",
        header: "Checks",
        multiSelect: true,
        options: [
          { label: "Tests", description: "Run tests" },
          { label: "Build", description: "Run build" },
        ],
      }],
    });
    const result = test.context.input("[Checks] Which checks?\n\n1. Tests\n2. Build", "1,3");
    const request = test.requests[0];
    if (!request) throw new Error("Expected a UI request");

    expect(request).toMatchObject({
      method: "multi-select",
      title: "[Checks] Which checks?",
      questionIndex: 0,
      questionCount: 1,
      options: [
        { value: "1", label: "Tests", description: "Run tests" },
        { value: "2", label: "Build", description: "Run build" },
      ],
    });
    expect(test.bridge.respond({ requestId: request.id, value: ["1", "2"] })).toBe(true);
    await expect(result).resolves.toBe("1,2");
  });

  it("maps extension notifications to the host notice channel", () => {
    const test = createHarness();
    test.context.notify("Ready", "info");
    expect(test.notices).toEqual(["Ready"]);
  });

  it("honors dialog timeouts", async () => {
    vi.useFakeTimers();
    const test = createHarness();
    const result = test.context.confirm("Continue?", "Confirm", { timeout: 50 });

    await vi.advanceTimersByTimeAsync(50);

    await expect(result).resolves.toBe(false);
    expect(test.bridge.current).toBeNull();
    vi.useRealTimers();
  });
});
