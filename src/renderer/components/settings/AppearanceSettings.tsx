import { Image, LoaderCircle, Upload, X } from "lucide-react";
import { useAppConfig } from "../../hooks/use-app-config";
import { useI18n } from "../../i18n/i18n";
import { WorkAnimatorSettings } from "./WorkAnimatorSettings";

/**
 * 应用外观设置：自定义 UI 内 logo 与会话区背景图。
 * 状态来自 AppConfigService（应用级配置，持久化到 app-config.json），修改即时生效。
 */
export function AppearanceSettings() {
  const { t } = useI18n();
  const {
    snapshot,
    loading,
    error,
    chooseIcon,
    clearIcon,
    chooseConversationAvatar,
    clearConversationAvatar,
    saveConversationNicknames,
    chooseBackgroundImage,
    clearBackgroundImage,
    saveWorkAnimator,
    addWorkAnimatorImages,
  } = useAppConfig();
  const iconUrl = snapshot?.iconUrl ?? null;
  const backgroundImageUrl = snapshot?.backgroundImageUrl ?? null;
  const identity = snapshot?.conversationIdentity;

  return (
    <>
      {error && <div className="settings-error">{error}</div>}
      {loading && <div className="settings-pending"><LoaderCircle className="spin" size={12} />{t("settings.loading")}</div>}
      <div className="appearance-settings">
        {snapshot?.workAnimator && <WorkAnimatorSettings settings={snapshot.workAnimator} loading={loading}
          onSave={saveWorkAnimator} onAdd={addWorkAnimatorImages} />}
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
          <h3>会话身份</h3>
          <div className="conversation-identity-settings">
            {(["assistant", "user"] as const).map((role) => {
              const profile = identity?.[role];
              const label = role === "assistant" ? "模型" : "用户";
              return (
                <div className="identity-setting" key={role}>
                  <div className="identity-avatar-preview">
                    {profile?.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : <span>{role === "assistant" ? "P" : "你"}</span>}
                  </div>
                  <div className="app-icon-actions">
                    <label>
                      <span>{label}昵称</span>
                      <input
                        defaultValue={profile?.nickname ?? (role === "assistant" ? "PiECode" : "你")}
                        maxLength={40}
                        onBlur={(event) => {
                          const current = identity ?? {
                            assistant: { nickname: "PiECode" },
                            user: { nickname: "你" },
                          };
                          void saveConversationNicknames({
                            assistant: role === "assistant" ? event.currentTarget.value : current.assistant.nickname,
                            user: role === "user" ? event.currentTarget.value : current.user.nickname,
                          });
                        }}
                      />
                    </label>
                    <div className="app-icon-buttons">
                      <button className="primary" onClick={() => void chooseConversationAvatar(role)} disabled={loading}><Upload size={14} />上传头像</button>
                      <button onClick={() => void clearConversationAvatar(role)} disabled={loading || !profile?.avatarUrl}><X size={14} />恢复默认</button>
                    </div>
                  </div>
                </div>
              );
            })}
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
