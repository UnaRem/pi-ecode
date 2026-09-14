import { describe, expect, it } from "vitest";
import { validateConfig } from "./settings-validation.js";

describe("validateConfig", () => {
  it("accepts documented pi and pi-fff settings", () => {
    expect(() => validateConfig("global-settings", {
      defaultThinkingLevel: "high",
      transport: "websocket",
      compaction: { enabled: true, reserveTokens: 16_384 },
      retry: { enabled: true, maxRetries: 3 },
    })).not.toThrow();
    expect(() => validateConfig("pi-fff", {
      mode: "override",
      enableHomeDirScanning: false,
      followSymlinks: true,
    })).not.toThrow();
    expect(() => validateConfig("sol-pi", {
      version: 1,
      actionFusion: true,
      observationPack: true,
      evidencePreservingReducer: false,
      onlineContextCompact: false,
      cacheWriteReadRatio: 12.5,
    })).not.toThrow();
  });

  it("rejects invalid documented values and unknown pi-fff fields", () => {
    expect(() => validateConfig("global-settings", { defaultThinkingLevel: "huge" })).toThrow("defaultThinkingLevel");
    expect(() => validateConfig("pi-fff", { mode: "fast", extra: true })).toThrow("Unknown pi-fff setting");
    expect(() => validateConfig("sol-pi", { version: 2, actionFusion: "yes" })).toThrow("version must be 1");
    expect(() => validateConfig("sol-pi", { version: 1, extra: true })).toThrow("Unknown SoL-Pi setting");
    expect(() => validateConfig("sol-pi", { version: 1, evidencePreservingReducerModel: "" })).toThrow("non-empty string");
  });

  it("requires ids for configured custom models", () => {
    expect(() => validateConfig("models", {
      providers: { local: { models: [{ name: "Missing id" }] } },
    })).toThrow("models[0].id");
  });
});
