import { describe, expect, it } from "vitest";
import { translate } from "./i18n";

describe("translate", () => {
  it("uses Chinese as the selected language", () => {
    expect(translate("zh-CN", "sidebar.newThread")).toBe("新建对话");
  });

  it("interpolates values without changing unknown dynamic content", () => {
    expect(translate("en", "task.current", { current: 2, total: 4 })).toBe("Step 2/4");
    expect(translate("zh-CN", "conversation.welcomeBody", { project: "demo" })).toContain("demo");
  });
});
