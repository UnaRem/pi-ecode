// pi-ecode 应用级配置契约（与 pi agent 的 settings.json 解耦）。
// 目前仅承载自定义应用图标路径；iconPath 为相对 userData 的路径，null 表示使用默认图标。

export interface AppConfigSnapshot {
  iconPath: string | null;
  /** 渲染层可用的图标 URL（file:// 协议，已带缓存破坏参数）；null 表示使用默认 ./ecode-icon.png。 */
  iconUrl: string | null;
}

export interface AppConfigChangedEvent {
  type: "app-config-changed";
  snapshot: AppConfigSnapshot;
}
