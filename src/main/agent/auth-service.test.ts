import { describe, expect, it, vi } from "vitest";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthFlowEvent } from "../../shared/settings-contracts.js";
import { AuthService } from "./auth-service.js";

function createRuntime(login: (interaction: AuthInteraction) => Promise<void>): ModelRuntime {
  return {
    getProvider: () => ({ id: "demo", name: "Demo", auth: { apiKey: { name: "Demo key", login: vi.fn() } } }),
    login: vi.fn(async (_providerId: string, _type: string, interaction: AuthInteraction) => login(interaction)),
    logout: vi.fn(async () => undefined),
  } as unknown as ModelRuntime;
}

describe("AuthService", () => {
  it("keeps secret prompt values out of emitted state", async () => {
    let submitted = "";
    const events: AuthFlowEvent[] = [];
    const runtime = createRuntime(async (interaction) => {
      submitted = await interaction.prompt({ type: "secret", message: "API key" });
    });
    const service = new AuthService(() => runtime, (event) => events.push(event), async () => undefined);
    const operation = service.login("demo", "api_key");
    await vi.waitFor(() => expect(events.at(-1)?.state?.request?.type).toBe("secret"));
    const requestId = events.at(-1)?.state?.request?.id;
    expect(requestId).toBeTruthy();
    service.respond({ requestId: requestId ?? "", value: "super-secret" });
    await operation;
    expect(submitted).toBe("super-secret");
    expect(JSON.stringify(events)).not.toContain("super-secret");
    expect(events.at(-1)?.state?.status).toBe("completed");
  });

  it("cancels a pending authentication prompt", async () => {
    const events: AuthFlowEvent[] = [];
    const runtime = createRuntime(async (interaction) => {
      await interaction.prompt({ type: "text", message: "Code" });
    });
    const service = new AuthService(() => runtime, (event) => events.push(event), async () => undefined);
    const operation = service.login("demo", "api_key");
    await vi.waitFor(() => expect(events.at(-1)?.state?.request).not.toBeNull());
    service.cancel();
    await operation;
    expect(events.at(-1)?.state?.status).toBe("cancelled");
  });
});
