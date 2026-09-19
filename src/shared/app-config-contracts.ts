// pi-ecode 应用级配置契约（与 pi agent 的 settings.json 解耦）。
// 承载应用图标、会话身份与背景图；文件路径均为相对 userData 的路径，null 表示使用默认。

export interface AppThemeColors {
  /** 主强调色（默认 #3f6f62）。 */
  accent: string | null;
  /** 强调色浅色背景（默认 #e5eeea）。 */
  accentSoft: string | null;
  /** 危险色（默认 #b64d42）。 */
  danger: string | null;
  /** 会话区底色（默认 #f7f7f5）。 */
  background: string | null;
}

export type ConversationIdentityRole = "assistant" | "user";

export interface ConversationIdentityProfile {
  nickname: string;
  avatarPath: string | null;
  avatarUrl: string | null;
}

export interface ConversationIdentity {
  assistant: ConversationIdentityProfile;
  user: ConversationIdentityProfile;
}

export interface ConversationNicknameUpdate {
  assistant: string;
  user: string;
}

export const DEFAULT_CONVERSATION_NICKNAMES: ConversationNicknameUpdate = {
  assistant: "PiECode",
  user: "你",
};

export interface AppConfigSnapshot {
  iconPath: string | null;
  /** 渲染层可用的图标 URL（file:// 协议，已带缓存破坏参数）；null 表示使用默认 ./ecode-icon.png。 */
  iconUrl: string | null;
  /** 主题色，null 表示使用默认。 */
  theme: AppThemeColors;
  /** 会话区背景图（相对 userData 路径）；null 表示无背景图。 */
  backgroundImagePath: string | null;
  /** 会话区背景图 URL（file:// 协议，已带缓存破坏参数）；null 表示无背景图。 */
  backgroundImageUrl: string | null;
  /** 会话中模型与用户的全局身份设置。 */
  conversationIdentity: ConversationIdentity;
}

export interface AppConfigChangedEvent {
  type: "app-config-changed";
  snapshot: AppConfigSnapshot;
}

export const DEFAULT_THEME_COLORS: Required<AppThemeColors> = {
  accent: "#3f6f62",
  accentSoft: "#e5eeea",
  danger: "#b64d42",
  background: "#f7f7f5",
};
