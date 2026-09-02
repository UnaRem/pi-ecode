import { CircleAlert, CircleCheck } from "lucide-react";
import type { JsonObject, JsonValue } from "@shared/settings-contracts";
import { useI18n } from "../../i18n/i18n";

function updateField(value: JsonObject, key: string, next: JsonValue | undefined): JsonObject {
  const result = { ...value };
  if (next === undefined || next === "") delete result[key];
  else result[key] = next;
  return result;
}

function booleanValue(value: JsonValue | undefined): string {
  return typeof value === "boolean" ? String(value) : "";
}

export function FffSettingsForm(props: { value: JsonObject; loaded: boolean; disabled: boolean; onChange: (value: JsonObject) => void }) {
  const { t } = useI18n();
  const set = (key: string, value: JsonValue | undefined): void => props.onChange(updateField(props.value, key, value));
  return (
    <fieldset className="fff-settings" disabled={props.disabled}>
      <div className={`fff-status ${props.loaded ? "loaded" : "missing"}`}>
        {props.loaded ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
        <div><strong>{props.loaded ? t("settings.fffLoaded") : t("settings.fffMissing")}</strong><span>{t("settings.fffInstallNote")}</span></div>
      </div>
      <section className="settings-group">
        <h3>{t("settings.fffBehavior")}</h3>
        <div className="settings-fields">
          <label className="settings-field">
            <span><code>mode</code><small>{t("settings.fffModeHint")}</small></span>
            <select value={typeof props.value.mode === "string" ? props.value.mode : ""} onChange={(event) => set("mode", event.target.value || undefined)}>
              <option value="">tools-and-ui ({t("settings.default")})</option>
              <option value="tools-and-ui">tools-and-ui</option><option value="tools-only">tools-only</option><option value="override">override</option>
            </select>
          </label>
          <label className="settings-field">
            <span><code>followSymlinks</code><small>{t("settings.fffSymlinkHint")}</small></span>
            <select value={booleanValue(props.value.followSymlinks)} onChange={(event) => set("followSymlinks", event.target.value ? event.target.value === "true" : undefined)}>
              <option value="">true ({t("settings.default")})</option><option value="true">true</option><option value="false">false</option>
            </select>
          </label>
          <label className="settings-field wide">
            <span><code>frecencyDbPath</code></span>
            <input value={typeof props.value.frecencyDbPath === "string" ? props.value.frecencyDbPath : ""} onChange={(event) => set("frecencyDbPath", event.target.value)} placeholder={t("settings.fffAutoPath")} />
          </label>
          <label className="settings-field wide">
            <span><code>historyDbPath</code></span>
            <input value={typeof props.value.historyDbPath === "string" ? props.value.historyDbPath : ""} onChange={(event) => set("historyDbPath", event.target.value)} placeholder={t("settings.fffAutoPath")} />
          </label>
        </div>
      </section>
      <section className="settings-group">
        <h3>{t("settings.fffScanning")}</h3>
        <div className="settings-fields">
          {([
            ["enableFsRootScanning", false, "settings.fffRootHint"],
            ["enableHomeDirScanning", true, "settings.fffHomeHint"],
            ["warnOnHomeDirScan", true, "settings.fffWarnHint"],
          ] as const).map(([key, defaultValue, hint]) => (
            <label className="settings-field" key={key}>
              <span><code>{key}</code><small>{t(hint)}</small></span>
              <select value={booleanValue(props.value[key])} onChange={(event) => set(key, event.target.value ? event.target.value === "true" : undefined)}>
                <option value="">{String(defaultValue)} ({t("settings.default")})</option><option value="true">true</option><option value="false">false</option>
              </select>
            </label>
          ))}
        </div>
      </section>
      <label className="settings-field fff-schema">
        <span><code>$schema</code></span>
        <input value={typeof props.value.$schema === "string" ? props.value.$schema : ""} onChange={(event) => set("$schema", event.target.value)} />
      </label>
    </fieldset>
  );
}
