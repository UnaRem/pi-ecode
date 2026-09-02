import type { ConfigTarget, JsonObject, JsonValue } from "../../shared/settings-contracts.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TRANSPORTS = new Set(["auto", "sse", "websocket", "websocket-cached"]);
const FFF_MODES = new Set(["tools-and-ui", "tools-only", "override"]);
const MODEL_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);

function isObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: JsonValue | undefined, path: string, errors: string[]): void {
  if (value !== undefined && typeof value !== "string") errors.push(`${path} must be a string.`);
}

function optionalBoolean(value: JsonValue | undefined, path: string, errors: string[]): void {
  if (value !== undefined && typeof value !== "boolean") errors.push(`${path} must be a boolean.`);
}

function optionalNonNegativeNumber(value: JsonValue | undefined, path: string, errors: string[]): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    errors.push(`${path} must be a non-negative number.`);
  }
}

function optionalStringArray(value: JsonValue | undefined, path: string, errors: string[]): void {
  if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
    errors.push(`${path} must be an array of strings.`);
  }
}

function validateSettings(value: JsonObject): string[] {
  const errors: string[] = [];
  optionalString(value.defaultProvider, "defaultProvider", errors);
  optionalString(value.defaultModel, "defaultModel", errors);
  if (value.defaultThinkingLevel !== undefined && (typeof value.defaultThinkingLevel !== "string" || !THINKING_LEVELS.has(value.defaultThinkingLevel))) {
    errors.push("defaultThinkingLevel is invalid.");
  }
  if (value.transport !== undefined && (typeof value.transport !== "string" || !TRANSPORTS.has(value.transport))) errors.push("transport is invalid.");
  optionalBoolean(value.hideThinkingBlock, "hideThinkingBlock", errors);
  optionalBoolean(value.showCacheMissNotices, "showCacheMissNotices", errors);
  optionalBoolean(value.quietStartup, "quietStartup", errors);
  optionalBoolean(value.enableInstallTelemetry, "enableInstallTelemetry", errors);
  optionalBoolean(value.enableAnalytics, "enableAnalytics", errors);
  optionalStringArray(value.extensions, "extensions", errors);
  optionalStringArray(value.skills, "skills", errors);
  optionalStringArray(value.prompts, "prompts", errors);
  optionalStringArray(value.themes, "themes", errors);
  optionalStringArray(value.enabledModels, "enabledModels", errors);
  optionalStringArray(value.defaultTools, "defaultTools", errors);
  for (const sectionName of ["compaction", "branchSummary", "retry", "terminal", "images", "markdown", "warnings"] as const) {
    const section = value[sectionName];
    if (section !== undefined && !isObject(section)) errors.push(`${sectionName} must be an object.`);
  }
  if (isObject(value.compaction)) {
    optionalBoolean(value.compaction.enabled, "compaction.enabled", errors);
    optionalNonNegativeNumber(value.compaction.reserveTokens, "compaction.reserveTokens", errors);
    optionalNonNegativeNumber(value.compaction.keepRecentTokens, "compaction.keepRecentTokens", errors);
  }
  if (isObject(value.retry)) {
    optionalBoolean(value.retry.enabled, "retry.enabled", errors);
    optionalNonNegativeNumber(value.retry.maxRetries, "retry.maxRetries", errors);
    optionalNonNegativeNumber(value.retry.baseDelayMs, "retry.baseDelayMs", errors);
  }
  return errors;
}

function validateModels(value: JsonObject): string[] {
  const errors: string[] = [];
  if (!isObject(value.providers)) return value.providers === undefined ? [] : ["providers must be an object."];
  for (const [providerId, providerValue] of Object.entries(value.providers)) {
    if (!isObject(providerValue)) {
      errors.push(`providers.${providerId} must be an object.`);
      continue;
    }
    optionalString(providerValue.baseUrl, `providers.${providerId}.baseUrl`, errors);
    if (providerValue.api !== undefined && (typeof providerValue.api !== "string" || !MODEL_APIS.has(providerValue.api))) {
      errors.push(`providers.${providerId}.api is invalid.`);
    }
    if (providerValue.models !== undefined && !Array.isArray(providerValue.models)) errors.push(`providers.${providerId}.models must be an array.`);
    if (Array.isArray(providerValue.models)) {
      providerValue.models.forEach((model, index) => {
        if (!isObject(model) || typeof model.id !== "string" || !model.id.trim()) errors.push(`providers.${providerId}.models[${index}].id is required.`);
      });
    }
  }
  return errors;
}

function validateFff(value: JsonObject): string[] {
  const errors: string[] = [];
  const allowed = new Set(["$schema", "mode", "frecencyDbPath", "historyDbPath", "enableFsRootScanning", "enableHomeDirScanning", "warnOnHomeDirScan", "followSymlinks"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`Unknown pi-fff setting: ${key}.`);
  optionalString(value.$schema, "$schema", errors);
  if (value.mode !== undefined && (typeof value.mode !== "string" || !FFF_MODES.has(value.mode))) errors.push("mode is invalid.");
  optionalString(value.frecencyDbPath, "frecencyDbPath", errors);
  optionalString(value.historyDbPath, "historyDbPath", errors);
  optionalBoolean(value.enableFsRootScanning, "enableFsRootScanning", errors);
  optionalBoolean(value.enableHomeDirScanning, "enableHomeDirScanning", errors);
  optionalBoolean(value.warnOnHomeDirScan, "warnOnHomeDirScan", errors);
  optionalBoolean(value.followSymlinks, "followSymlinks", errors);
  return errors;
}

export function validateConfig(target: ConfigTarget, value: JsonObject): void {
  const errors = target === "models"
    ? validateModels(value)
    : target === "pi-fff" ? validateFff(value) : validateSettings(value);
  if (errors.length > 0) throw new Error(errors.join("\n"));
}
