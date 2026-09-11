import { Image, LoaderCircle, RotateCcw, Upload, X } from "lucide-react";
import type { AppThemeColors } from "@shared/app-config-contracts";
import { DEFAULT_THEME_COLORS } from "@shared/app-config-contracts";
import { useAppConfig } from "../../hooks/use-app-config";
import { useI18n } from "../../i18n/i18n";
import type { MessageKey } from "../../i18n/messages";

const THEME_FIELDS: Array<{ key: keyof Required<AppThemeColors>; labelKey: MessageKey }> = [
  { key: "accent", labelKey: "settings.app.theme.accent" },
  { key: "accentSoft", labelKey: "settings.app.theme.accentSoft" },
  { key: "danger", labelKey: "settings.app.theme.danger" },
  { key: "background", labelKey: "settings.app.theme.background" },
];

/**
 * 应用外观设置：自定义 UI 内 logo、主题主色与会话区背景图。
 * 状态来自 AppConfigService（应用级配置，持久化到 app-config.json），修改即时生效。
 */
export function AppearanceSettings() {
  const { t } = useI18n();
  const { snapshot, loading, error, chooseIcon, clearIcon, saveTheme, chooseBackgroundImage, clearBackgroundImage } = useAppConfig();
  const iconUrl = snapshot?.iconUrl ?? null;
  const backgroundImageUrl = snapshot?.backgroundImageUrl ?? null;
  const theme = snapshot?.theme ?? null;
  const hasCustomTheme = Boolean(theme?.accent || theme?.accentSoft || theme?.danger || theme?.background);

  const resetTheme = (): void => {
    void saveTheme({ accent: null, accentSoft: null, danger: null, background: null });
  };

  const updateColor = (key: keyof Required<AppThemeColors>, value: string): void => {
    const next: AppThemeColors = {
      accent: theme?.accent ?? null,
      accentSoft: theme?.accentSoft ?? null,
      danger: theme?.danger ?? null,
      background: theme?.background ?? null,
      [key]: value || null,
    };
    void saveTheme(next);
  };

  return (
    <>
      {error && <div className="settings-error">{error}</div>}
      {loading && <div className="settings-pending"><LoaderCircle className="spin" size={12} />{t("settings.loading")}</div>}
      <div className="appearance-settings">
        <section className="appearance-card">
          <h3>{t("settings.app.icon.title")}</h3>
          <div className="app-icon-settings">
            <div className="app-icon-preview">
              <img src={iconUrl ?? "./ecode-icon.png"} alt={t("settings.app.icon.current")} />
            </div>
            <div className="app-icon-actions">
              <p className="app-icon-hint">{t("settings.app.icon.hint")}</p>
              <div className="app-icon-buttons">
                <button className="primary" onClick={() => void chooseIcon()} disabled={loading}>
                  <Upload size={14} />{t("settings.app.icon.choose")}
                </button>
                <button onClick={() => void clearIcon()} disabled={loading || !iconUrl}>
                  <X size={14} />{t("settings.app.icon.clear")}
                </button>
              </div>
              {iconUrl
                ? <small className="app-icon-custom">{t("settings.app.icon.customActive")}</small>
                : <small className="app-icon-default"><Image size={11} />{t("settings.app.icon.usingDefault")}</small>}
            </div>
          </div>
        </section>

        <section className="appearance-card">
          <div className="appearance-card-header">
            <h3>{t("settings.app.theme.title")}</h3>
            <button className="theme-reset" onClick={resetTheme} disabled={!hasCustomTheme}>
              <RotateCcw size={12} />{t("settings.app.theme.reset")}
            </button>
          </div>
          <p className="appearance-hint">{t("settings.app.theme.hint")}</p>
          <div className="theme-color-grid">
            {THEME_FIELDS.map((field) => (
              <label className="theme-color-field" key={field.key}>
                <span>{t(field.labelKey)}</span>
                <span className="theme-color-input-wrap">
                  <input
                    type="color"
                    value={(theme?.[field.key] ?? DEFAULT_THEME_COLORS[field.key]) as string}
                    onChange={(event) => updateColor(field.key, event.target.value)}
                  />
                  <code>{theme?.[field.key] ?? DEFAULT_THEME_COLORS[field.key]}</code>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="appearance-card">
          <h3>{t("settings.app.background.title")}</h3>
          <div className="app-icon-settings">
            <div className={`app-background-preview ${backgroundImageUrl ? "has-image" : ""}`}>
              {backgroundImageUrl && <img src={backgroundImageUrl} alt="" />}
            </div>
            <div className="app-icon-actions">
              <p className="app-icon-hint">{t("settings.app.background.hint")}</p>
              <div className="app-icon-buttons">
                <button className="primary" onClick={() => void chooseBackgroundImage()} disabled={loading}>
                  <Upload size={14} />{t("settings.app.background.choose")}
                </button>
                <button onClick={() => void clearBackgroundImage()} disabled={loading || !backgroundImageUrl}>
                  <X size={14} />{t("settings.app.background.clear")}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
