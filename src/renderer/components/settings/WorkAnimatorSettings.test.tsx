import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultWorkAnimator, presetFrames } from "../../../shared/work-animator";
import { I18nProvider } from "../../i18n/i18n";
import { WorkAnimatorSettings } from "./WorkAnimatorSettings";

describe("WorkAnimatorSettings", () => {
  it("renders independent presets with controls for every frame", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const settings = defaultWorkAnimator();
    settings.working = { preset: "silence_wang", frames: presetFrames("working", "silence_wang") };
    const markup = renderToStaticMarkup(<I18nProvider>
      <WorkAnimatorSettings settings={settings} loading={false} onSave={async () => undefined} onSaveDisplay={async () => undefined} onAdd={async () => undefined} />
    </I18nProvider>);
    expect(markup).toContain('id="work-animator-idle"');
    expect(markup).toContain('id="work-animator-working"');
    expect(markup).toContain('value="220"');
    expect(markup).toContain('value="650"');
    expect(markup).toContain('working_12.png');
    expect(markup.match(/aria-label="Move up"/gu)).toHaveLength(18);
    expect(markup).toContain('aria-label="Character positioning preview"');
    expect(markup).toContain('value="100"');
  });
});
