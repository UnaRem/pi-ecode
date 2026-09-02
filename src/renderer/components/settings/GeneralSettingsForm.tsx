import { useEffect, useState } from "react";
import type { JsonObject, JsonValue } from "@shared/settings-contracts";
import { useI18n } from "../../i18n/i18n";
import type { MessageKey } from "../../i18n/messages";

interface FieldDefinition {
  path: string;
  kind: "string" | "number" | "boolean" | "select" | "lines" | "json";
  options?: string[];
  hint?: MessageKey;
}

interface FieldGroup {
  title: MessageKey;
  fields: FieldDefinition[];
}

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const GROUPS: FieldGroup[] = [
  { title: "settings.group.model", fields: [
    { path: "defaultProvider", kind: "string" }, { path: "defaultModel", kind: "string" },
    { path: "defaultThinkingLevel", kind: "select", options: THINKING },
    { path: "modelThinkingLevels", kind: "json" }, { path: "thinkingBudgets", kind: "json" },
    { path: "hideThinkingBlock", kind: "boolean" }, { path: "showCacheMissNotices", kind: "boolean" },
  ] },
  { title: "settings.group.context", fields: [
    { path: "compaction.enabled", kind: "boolean" }, { path: "compaction.reserveTokens", kind: "number" },
    { path: "compaction.keepRecentTokens", kind: "number" }, { path: "branchSummary.reserveTokens", kind: "number" },
    { path: "branchSummary.skipPrompt", kind: "boolean" }, { path: "retry.enabled", kind: "boolean" },
    { path: "retry.maxRetries", kind: "number" }, { path: "retry.baseDelayMs", kind: "number" },
    { path: "retry.provider.timeoutMs", kind: "number" }, { path: "retry.provider.maxRetries", kind: "number" },
    { path: "retry.provider.maxRetryDelayMs", kind: "number" },
  ] },
  { title: "settings.group.network", fields: [
    { path: "steeringMode", kind: "select", options: ["one-at-a-time", "all"] },
    { path: "followUpMode", kind: "select", options: ["one-at-a-time", "all"] },
    { path: "transport", kind: "select", options: ["auto", "sse", "websocket", "websocket-cached"] },
    { path: "httpProxy", kind: "string", hint: "settings.hint.global" },
    { path: "httpIdleTimeoutMs", kind: "number" }, { path: "websocketConnectTimeoutMs", kind: "number" },
  ] },
  { title: "settings.group.tools", fields: [
    { path: "shellPath", kind: "string" }, { path: "shellCommandPrefix", kind: "string" },
    { path: "npmCommand", kind: "json" }, { path: "defaultTools", kind: "lines", hint: "settings.hint.lines" },
    { path: "sessionDir", kind: "string" }, { path: "externalEditor", kind: "string" },
  ] },
  { title: "settings.group.resources", fields: [
    { path: "packages", kind: "json" }, { path: "extensions", kind: "lines" },
    { path: "skills", kind: "lines" }, { path: "prompts", kind: "lines" },
    { path: "themes", kind: "lines" }, { path: "enableSkillCommands", kind: "boolean" },
    { path: "enabledModels", kind: "lines", hint: "settings.hint.lines" },
  ] },
  { title: "settings.group.content", fields: [
    { path: "images.autoResize", kind: "boolean" }, { path: "images.blockImages", kind: "boolean" },
    { path: "markdown.codeBlockIndent", kind: "string" },
    { path: "markdown.mermaid", kind: "select", options: ["off", "final", "streaming"] },
  ] },
  { title: "settings.group.security", fields: [
    { path: "defaultProjectTrust", kind: "select", options: ["ask", "always", "never"], hint: "settings.hint.global" },
    { path: "warnings.anthropicExtraUsage", kind: "boolean" }, { path: "quietStartup", kind: "boolean" },
    { path: "collapseChangelog", kind: "boolean" }, { path: "enableInstallTelemetry", kind: "boolean" },
    { path: "enableAnalytics", kind: "boolean" }, { path: "trackingId", kind: "string" },
    { path: "lastChangelogVersion", kind: "string" },
  ] },
  { title: "settings.group.tui", fields: [
    { path: "theme", kind: "string", hint: "settings.hint.tui" },
    { path: "doubleEscapeAction", kind: "select", options: ["tree", "fork", "none"] },
    { path: "treeFilterMode", kind: "select", options: ["default", "no-tools", "user-only", "labeled-only", "all"] },
    { path: "editorPaddingX", kind: "number" }, { path: "outputPad", kind: "select", options: ["0", "1"] },
    { path: "autocompleteMaxVisible", kind: "number" }, { path: "showHardwareCursor", kind: "boolean" },
    { path: "tuiMode", kind: "select", options: ["regular", "fullscreen"] },
    { path: "fullscreenExitOutput", kind: "select", options: ["transcript", "resume-hint"] },
    { path: "fullscreenScrollbar", kind: "select", options: ["auto", "always", "hidden"] },
    { path: "fullscreenCopyOnSelect", kind: "boolean" }, { path: "terminal.showImages", kind: "boolean" },
    { path: "terminal.imageWidthCells", kind: "number" }, { path: "terminal.clearOnShrink", kind: "boolean" },
    { path: "terminal.showTerminalProgress", kind: "boolean" },
    { path: "terminal.hyperlinks", kind: "select", options: ["auto", "true", "false"] },
    { path: "terminal.images", kind: "select", options: ["auto", "kitty", "iterm2", "false"] },
    { path: "terminal.trueColor", kind: "select", options: ["auto", "true", "false"] },
  ] },
];

function getValue(root: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue = root;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[key] as JsonValue;
  }
  return current;
}

function setValue(root: JsonObject, path: string, value: JsonValue | undefined): JsonObject {
  const result = structuredClone(root);
  const keys = path.split(".");
  let current = result;
  keys.slice(0, -1).forEach((key) => {
    const existing = current[key];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) current[key] = {};
    current = current[key] as JsonObject;
  });
  const leaf = keys.at(-1);
  if (!leaf) return result;
  if (value === undefined) delete current[leaf];
  else current[leaf] = value;
  return result;
}

function selectValue(value: string): JsonValue | undefined {
  if (!value) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "0" || value === "1") return Number(value);
  return value;
}

function JsonField(props: { value: JsonValue | undefined; onChange: (value: JsonValue | undefined) => void }) {
  const serialized = props.value === undefined ? "" : JSON.stringify(props.value, null, 2);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState(false);
  useEffect(() => setText(serialized), [serialized]);
  const commit = (): void => {
    if (!text.trim()) {
      setError(false);
      props.onChange(undefined);
      return;
    }
    try {
      props.onChange(JSON.parse(text) as JsonValue);
      setError(false);
    } catch {
      setError(true);
    }
  };
  return <textarea className={error ? "invalid" : ""} value={text} onChange={(event) => setText(event.target.value)} onBlur={commit} rows={4} />;
}

function FieldEditor(props: { field: FieldDefinition; value: JsonValue | undefined; onChange: (value: JsonValue | undefined) => void }) {
  const { t } = useI18n();
  const { field, value, onChange } = props;
  if (field.kind === "boolean") {
    return (
      <select value={value === undefined ? "" : String(value)} onChange={(event) => onChange(selectValue(event.target.value))}>
        <option value="">{t("settings.inherit")}</option><option value="true">true</option><option value="false">false</option>
      </select>
    );
  }
  if (field.kind === "select") {
    return (
      <select value={value === undefined ? "" : String(value)} onChange={(event) => onChange(selectValue(event.target.value))}>
        <option value="">{t("settings.inherit")}</option>
        {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }
  if (field.kind === "json") return <JsonField value={value} onChange={onChange} />;
  if (field.kind === "lines") {
    const text = Array.isArray(value) ? value.filter((item) => typeof item === "string").join("\n") : "";
    return <textarea rows={3} value={text} onChange={(event) => onChange(event.target.value.trim() ? event.target.value.split("\n").map((line) => line.trim()).filter(Boolean) : undefined)} />;
  }
  return (
    <input
      type={field.kind === "number" ? "number" : "text"}
      value={typeof value === "string" || typeof value === "number" ? value : ""}
      onChange={(event) => onChange(event.target.value === "" ? undefined : field.kind === "number" ? Number(event.target.value) : event.target.value)}
    />
  );
}

export function GeneralSettingsForm(props: { value: JsonObject; disabled: boolean; readOnly: boolean; onChange: (value: JsonObject) => void }) {
  const { t } = useI18n();
  return (
    <>
      <fieldset className="settings-groups" disabled={props.disabled}>
        {GROUPS.map((group) => (
        <section className="settings-group" key={group.title}>
          <h3>{t(group.title)}</h3>
          <div className="settings-fields">
            {group.fields.map((field) => (
              <label className={`settings-field ${field.kind === "json" || field.kind === "lines" ? "wide" : ""}`} key={field.path}>
                <span><code>{field.path}</code>{field.hint && <small>{t(field.hint)}</small>}</span>
                <FieldEditor field={field} value={getValue(props.value, field.path)} onChange={(value) => props.onChange(setValue(props.value, field.path, value))} />
              </label>
            ))}
          </div>
        </section>
        ))}
      </fieldset>
      {props.readOnly && <div className="settings-readonly">{t("settings.readonly")}</div>}
    </>
  );
}
