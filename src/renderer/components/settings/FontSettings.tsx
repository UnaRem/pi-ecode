import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  APP_ZOOM_PRESETS, CODE_FONT_PRESETS, DEFAULT_FONT_SETTINGS, UI_FONT_PRESETS, fontFamilyCss,
  isFontFamily, isFontSize, type AppFontSettings,
} from "@shared/font-settings";
import { useI18n } from "../../i18n/i18n";

interface FamilyFieldProps {
  label: string;
  value: string | null;
  presets: readonly string[];
  pending: boolean;
  onPreview: (family: string | null) => void;
  onSave: (family: string | null) => Promise<void>;
}

function FontFamilyField({ label, value, presets, pending, onPreview, onSave }: FamilyFieldProps) {
  const { t } = useI18n();
  const [selection, setSelection] = useState(value === null ? "" : presets.includes(value) ? value : "custom");
  const [name, setName] = useState(value ?? "");
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    // Keep the custom input mounted after saving a name that also appears in presets.
    setSelection((current) => current === "custom" && value !== null
      ? "custom" : value === null ? "" : presets.includes(value) ? value : "custom");
    setName(value ?? "");
    setInvalid(false);
  }, [value, presets]);
  const commit = async () => {
    if (pending || selection !== "custom") return;
    const family = name.trim();
    if (!isFontFamily(family)) { setInvalid(true); return; }
    setInvalid(false);
    await onSave(family);
  };
  return <div className="font-setting-field">
    <label><span>{label}</span>
      <select value={selection} aria-disabled={pending} onBlur={() => {
        if (!pending && selection !== "custom") void onSave(selection || null);
      }} onChange={(event) => {
        if (pending) return;
        const selected = event.currentTarget.value;
        setSelection(selected);
        setInvalid(false);
        if (selected !== "custom") {
          const family = selected || null;
          onPreview(family);
          void onSave(family);
        }
      }}>
        <option value="">{t("settings.font.default")}</option>
        {presets.map((family) => <option value={family} key={family}>{family}</option>)}
        <option value="custom">{t("settings.font.custom")}</option>
      </select>
    </label>
    {selection === "custom" && <label>
      <span>{t("settings.font.installedName")}</span>
      <input value={name} maxLength={100} readOnly={pending} aria-invalid={invalid}
        placeholder={t("settings.font.namePlaceholder")} onChange={(event) => {
          setName(event.currentTarget.value);
          if (isFontFamily(event.currentTarget.value.trim())) onPreview(event.currentTarget.value.trim());
        }} onBlur={() => void commit()} onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); void commit(); }
        }} />
    </label>}
    {invalid && <small role="alert">{t("settings.font.invalidName")}</small>}
  </div>;
}

interface SizeFieldProps {
  label: string;
  value: number | null;
  bounds: { min: number; max: number };
  pending: boolean;
  onPreview: (size: number | null) => void;
  onSave: (size: number | null) => Promise<void>;
}

function FontSizeField({ label, value, bounds, pending, onPreview, onSave }: SizeFieldProps) {
  const { t } = useI18n();
  const [text, setText] = useState(value === null ? "" : String(value));
  const [badInput, setBadInput] = useState(false);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setText(value === null ? "" : String(value)); setBadInput(false); setInvalid(false); }, [value]);
  const parseSize = (input: string) => input.trim() ? Number(input) : null;
  const commit = async () => {
    if (pending) return;
    const size = parseSize(text);
    if (badInput || !isFontSize(size, bounds.min, bounds.max)) { setInvalid(true); return; }
    setInvalid(false);
    await onSave(size);
  };
  return <div className="font-setting-field">
    <label><span>{label} (px)</span>
      <input type="number" min={bounds.min} max={bounds.max} step={0.5} value={text}
        placeholder={t("settings.font.default")} readOnly={pending} aria-invalid={invalid}
        onChange={(event) => {
          const input = event.currentTarget.value;
          setText(input);
          // Chromium reports unfinished numeric input as an empty value with badInput.
          const incomplete = event.currentTarget.validity.badInput;
          setBadInput(incomplete);
          const size = parseSize(input);
          if (!incomplete && isFontSize(size, bounds.min, bounds.max)) onPreview(size);
        }} onBlur={() => void commit()} onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); void commit(); }
        }} />
    </label>
    <small className={invalid ? "invalid" : ""} role={invalid ? "alert" : undefined}>
      {t("settings.font.range", { min: bounds.min, max: bounds.max })}
    </small>
  </div>;
}

export function FontSettings({ settings, onSave }: {
  settings: AppFontSettings;
  onSave: (settings: AppFontSettings) => Promise<void>;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState(settings);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetVersion, setResetVersion] = useState(0);
  const latest = useRef(settings);
  const saving = useRef(false);
  useEffect(() => { latest.current = settings; }, [settings]);
  const stage = (patch: Partial<AppFontSettings>) => setPreview((current) => ({ ...current, ...patch }));
  const save = async (patch: Partial<AppFontSettings>, reset = false) => {
    // Enter followed by blur must not issue a second concurrent config write.
    if (saving.current) return;
    const next = { ...latest.current, ...patch };
    if (!reset && Object.entries(patch).every(([key, value]) => latest.current[key as keyof AppFontSettings] === value)) return;
    saving.current = true;
    setPending(true);
    setError(null);
    try {
      await onSave(next);
      latest.current = next;
      if (reset) { setPreview(next); setResetVersion((version) => version + 1); }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally { saving.current = false; setPending(false); }
  };
  const previewStyle: CSSProperties = {
    fontFamily: fontFamilyCss(preview.uiFamily), fontSize: preview.conversationSize ?? 13.5,
  };
  return <section className="appearance-card font-settings" aria-busy={pending}>
    <div className="appearance-card-header">
      <h3>{t("settings.font.title")}</h3>
      <button type="button" className="theme-reset" disabled={pending}
        // Avoid a blur-triggered draft save taking precedence over this reset.
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          void save({ ...DEFAULT_FONT_SETTINGS }, true);
          event.currentTarget.focus();
        }}>{t("settings.font.reset")}</button>
    </div>
    <p className="appearance-hint">{t("settings.font.hint")}</p>
    <div className="font-setting-field">
      <label><span>{t("settings.font.zoom")}</span>
        <select value={preview.zoomPercent} aria-disabled={pending} onChange={(event) => {
          if (pending) return;
          const zoomPercent = Number(event.currentTarget.value);
          stage({ zoomPercent });
          void save({ zoomPercent });
        }} onBlur={() => {
          if (!pending) void save({ zoomPercent: preview.zoomPercent });
        }}>
          {APP_ZOOM_PRESETS.map((percent) => <option value={percent} key={percent}>{percent}%</option>)}
        </select>
      </label>
      <small>{t("settings.font.zoomHint")}</small>
    </div>
    <div className="font-settings-grid" key={resetVersion}>
      <FontFamilyField label={t("settings.font.uiFamily")} value={settings.uiFamily} presets={UI_FONT_PRESETS}
        pending={pending} onPreview={(uiFamily) => stage({ uiFamily })} onSave={(uiFamily) => save({ uiFamily })} />
      <FontSizeField label={t("settings.font.bodySize")} value={settings.conversationSize} bounds={{ min: 12, max: 24 }}
        pending={pending} onPreview={(conversationSize) => stage({ conversationSize })} onSave={(conversationSize) => save({ conversationSize })} />
      <FontFamilyField label={t("settings.font.codeFamily")} value={settings.codeFamily} presets={CODE_FONT_PRESETS}
        pending={pending} onPreview={(codeFamily) => stage({ codeFamily })} onSave={(codeFamily) => save({ codeFamily })} />
      <FontSizeField label={t("settings.font.codeSize")} value={settings.codeSize} bounds={{ min: 10, max: 22 }}
        pending={pending} onPreview={(codeSize) => stage({ codeSize })} onSave={(codeSize) => save({ codeSize })} />
    </div>
    <div className="font-preview">
      <span>{t("settings.font.preview")}</span>
      <p style={previewStyle}>清晰阅读，专注创作。<br />The quick brown fox jumps over the lazy dog. 0123456789</p>
      <pre style={{ fontFamily: fontFamilyCss(preview.codeFamily, true), fontSize: preview.codeSize ?? 11 }}>
        {'const greeting = "你好, world!";\nconsole.log(greeting); // 0123456789'}
      </pre>
    </div>
    <p className="font-save-status" role="status">{pending ? t("settings.font.saving") : t("settings.font.autoSave")}</p>
    {error && <div className="settings-error" role="alert">{t("settings.font.saveFailed")} {error}</div>}
  </section>;
}
