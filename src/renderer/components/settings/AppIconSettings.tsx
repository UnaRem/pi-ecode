import { Image, LoaderCircle, Upload, X } from "lucide-react";
import { useAppConfig } from "../../hooks/use-app-config";
import { useI18n } from "../../i18n/i18n";

/**
 * 应用图标设置面板：选择本地 .ico/.png 文件复制到应用数据目录并热更新窗口/UI logo。
 * 与 pi agent 的 settings.json 解耦，状态来自 AppConfigService（应用级配置）。
 */
export function AppIconSettings() {
  const { t } = useI18n();
  const { snapshot, loading, error, chooseIcon, clearIcon } = useAppConfig();
  const iconUrl = snapshot?.iconUrl ?? null;
  // 未自定义时回退默认打包图标，使预览与实际窗口图标一致。
  const previewSrc = iconUrl ?? "./ecode-icon.png";

  return (
    <section className="settings-content">
      <div className="settings-content-title">
        <div><h2>{t("settings.app")}</h2><code>app-config.json</code></div>
        {loading && <span className="settings-pending"><LoaderCircle className="spin" size={12} />{t("settings.loading")}</span>}
      </div>
      {error && <div className="settings-error">{error}</div>}
      <div className="app-icon-settings">
        <div className="app-icon-preview">
          <img src={previewSrc} alt={t("settings.app.icon.current")} />
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
          {iconUrl && (
            <small className="app-icon-custom">{t("settings.app.icon.customActive")}</small>
          )}
          {!iconUrl && (
            <small className="app-icon-default"><Image size={11} />{t("settings.app.icon.usingDefault")}</small>
          )}
        </div>
      </div>
    </section>
  );
}
