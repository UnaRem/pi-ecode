import { ArrowDown, ArrowUp, RotateCcw, Upload, X } from "lucide-react";
import { useEffect, useState } from "react";
import { presetFrames, WORK_ANIMATOR_DEFAULT_DISPLAY, type WorkAnimatorDisplay, type WorkAnimatorFrame, type WorkAnimatorPreset, type WorkAnimatorSettings as AnimatorSettings, type WorkAnimatorStatus, type WorkAnimatorUpdate } from "../../../shared/work-animator";
import { useI18n } from "../../i18n/i18n";

interface Props {
  settings: AnimatorSettings;
  loading: boolean;
  onSave: (status: WorkAnimatorStatus, update: WorkAnimatorUpdate) => Promise<void>;
  onSaveDisplay: (display: WorkAnimatorDisplay) => Promise<void>;
  onAdd: (status: WorkAnimatorStatus) => Promise<void>;
}

function WorkAnimatorDisplayEditor(props: Pick<Props, "loading" | "onSaveDisplay"> & { settings: AnimatorSettings }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(props.settings.display);
  useEffect(() => setDraft(props.settings.display), [props.settings.display]);
  const dirty = Object.keys(draft).some((key) => draft[key as keyof WorkAnimatorDisplay] !== props.settings.display[key as keyof WorkAnimatorDisplay]);
  const setValue = (key: keyof WorkAnimatorDisplay, value: number): void => setDraft((current) => ({ ...current, [key]: value }));
  const controls = [
    ["scalePercent", "settings.app.animator.scale", 50, 250, "%"],
    ["offsetX", "settings.app.animator.horizontal", -120, 120, "px"],
    ["offsetY", "settings.app.animator.vertical", -120, 120, "px"],
  ] as const;
  return <div className="work-animator-display">
    <div className="work-animator-preview" aria-label={t("settings.app.animator.preview")}>
      <img src={props.settings.idle.frames[0]?.url} alt="" style={{ transform: `translate(${draft.offsetX}px, ${draft.offsetY}px) scale(${draft.scalePercent / 100})` }} />
    </div>
    <div className="work-animator-display-controls">
      {controls.map(([key, label, min, max, unit]) => <label key={key}>
        <span>{t(label)}</span>
        <input type="range" min={min} max={max} value={draft[key]} disabled={props.loading} onChange={(event) => setValue(key, Number(event.currentTarget.value))} />
        <input type="number" min={min} max={max} value={draft[key]} disabled={props.loading} onChange={(event) => {
          const value = Number(event.currentTarget.value);
          if (Number.isInteger(value) && value >= min && value <= max) setValue(key, value);
        }} />
        <span>{unit}</span>
      </label>)}
      <div className="work-animator-display-actions">
        <button disabled={props.loading || !dirty} onClick={() => void props.onSaveDisplay(draft)}>{t("settings.app.animator.apply")}</button>
        <button disabled={props.loading} onClick={() => setDraft({ ...WORK_ANIMATOR_DEFAULT_DISPLAY })}><RotateCcw size={13} />{t("settings.app.animator.reset")}</button>
      </div>
    </div>
  </div>;
}

export function WorkAnimatorSettings({ settings, loading, onSave, onSaveDisplay, onAdd }: Props) {
  const { t } = useI18n();
  const saveFrames = (status: WorkAnimatorStatus, frames: WorkAnimatorFrame[], preset: WorkAnimatorPreset = "custom"): void => {
    void onSave(status, { preset, frames: frames.map(({ id, durationMs }) => ({ id, durationMs })) });
  };
  const choosePreset = (status: WorkAnimatorStatus, preset: "shiro" | "silence_wang"): void => {
    const current = settings[status];
    if (current.preset === "custom" && !window.confirm(t("settings.app.animator.replace"))) return;
    saveFrames(status, presetFrames(status, preset), preset);
  };
  const moveFrame = (status: WorkAnimatorStatus, from: number, to: number): void => {
    const frames = [...settings[status].frames];
    const [selected] = frames.splice(from, 1);
    if (!selected) return;
    frames.splice(to, 0, selected);
    saveFrames(status, frames);
  };

  return (
    <section className="appearance-card">
      <h3>{t("settings.app.animator.title")}</h3>
      <p className="app-icon-hint">{t("settings.app.animator.hint")}</p>
      <WorkAnimatorDisplayEditor settings={settings} loading={loading} onSaveDisplay={onSaveDisplay} />
      <div className="work-animator-states">
        {(["idle", "working"] as const).map((status) => {
          const state = settings[status];
          return (
            <div className="work-animator-state" key={status}>
              <div className="work-animator-heading">
                <label htmlFor={`work-animator-${status}`}>{t(`settings.app.animator.${status}`)}</label>
                <select id={`work-animator-${status}`} value={state.preset} disabled={loading}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    if (next === "shiro" || next === "silence_wang") choosePreset(status, next);
                  }}>
                  <option value="shiro">shiro</option>
                  <option value="silence_wang">silence_wang</option>
                  {state.preset === "custom" && <option value="custom">{t("settings.app.animator.custom")}</option>}
                </select>
              </div>
              <ol className="work-animator-frames">
                {state.frames.map((frame, index) => (
                  <li key={frame.id}>
                    <img src={frame.url} alt="" />
                    <span className="work-animator-frame-label" title={frame.id}>{index + 1}. {frame.id.split("/").at(-1)}</span>
                    <label className="work-animator-duration">
                      <span>{t("settings.app.animator.duration")}</span>
                      <input type="number" min={50} max={10000} step={1} key={`${frame.id}-${frame.durationMs}`}
                        defaultValue={frame.durationMs} disabled={loading}
                        onBlur={(event) => {
                          const input = event.currentTarget;
                          if (!input.reportValidity()) return;
                          const durationMs = Number(input.value);
                          if (!Number.isInteger(durationMs) || durationMs === frame.durationMs) return;
                          saveFrames(status, state.frames.map((item, position) => position === index ? { ...item, durationMs } : item), state.preset);
                        }} />
                      <span>ms</span>
                    </label>
                    <div className="work-animator-frame-actions">
                      <button className="icon-button" aria-label={t("settings.app.animator.up")} title={t("settings.app.animator.up")}
                        disabled={loading || index === 0} onClick={() => moveFrame(status, index, index - 1)}><ArrowUp size={14} /></button>
                      <button className="icon-button" aria-label={t("settings.app.animator.down")} title={t("settings.app.animator.down")}
                        disabled={loading || index === state.frames.length - 1} onClick={() => moveFrame(status, index, index + 1)}><ArrowDown size={14} /></button>
                      <button className="icon-button" aria-label={t("settings.app.animator.remove")} title={t("settings.app.animator.remove")}
                        disabled={loading || state.frames.length === 1}
                        onClick={() => saveFrames(status, state.frames.filter((_, position) => position !== index))}><X size={14} /></button>
                    </div>
                  </li>
                ))}
              </ol>
              <button className="work-animator-add" disabled={loading || state.frames.length >= 100} onClick={() => void onAdd(status)}>
                <Upload size={14} />{t("settings.app.animator.add")}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
