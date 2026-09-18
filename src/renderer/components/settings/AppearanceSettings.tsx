import { Image, LoaderCircle, Upload, X } from "lucide-react";
import { useAppConfig } from "../../hooks/use-app-config";
import { useI18n } from "../../i18n/i18n";

/**
 * 应用外观设置：自定义 UI 内 logo 与会话区背景图。
 * 状态来自 AppConfigService（应用级配置，持久化到 app-config.json），修改即时生效。
 */
export function AppearanceSettings() {
  const { t } = useI18n();
  const { snapshot, loading, error, chooseIcon, clearIcon, chooseBackgroundImage, clearBackgroundImage } = useAppConfig();
  const iconUrl = snapshot?.iconUrl ?? null;
  const backgroundImageUrl = snapshot?.backgroundImageUrl ?? null;

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
