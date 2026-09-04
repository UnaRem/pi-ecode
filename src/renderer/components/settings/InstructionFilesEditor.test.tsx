import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n";
import { InstructionFilesEditor } from "./InstructionFilesEditor";

describe("InstructionFilesEditor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows only the fixed project and global instruction file targets", () => {
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <InstructionFilesEditor
          documents={{
            "project-agents": {
              path: "C:/project/AGENTS.md",
              exists: true,
              revision: "project-revision",
              content: "# Project rules",
              error: null,
            },
            "global-append-system": {
              path: "C:/agent/APPEND_SYSTEM.md",
              exists: false,
              revision: null,
              content: "",
              error: null,
            },
          }}
          loading={false}
          onDirtyChange={vi.fn()}
          onSave={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("Project AGENTS.md");
    expect(markup).toContain("Global APPEND_SYSTEM.md");
    expect(markup).toContain("C:/project/AGENTS.md");
    expect(markup).toContain("# Project rules");
    expect(markup).not.toContain("AGENTS.override.md");
  });
});
