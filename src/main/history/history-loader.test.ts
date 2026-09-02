import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { WorkspaceHistory } from "./workspace-history.js";

const temporaryPaths: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryPaths.map((path) => rm(path, { recursive: true, force: true })));
});

describe("workspace history resource loading", () => {
  it("loads the built-in extension while filtering the external package", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-ecode-loader-"));
    const storage = await mkdtemp(join(tmpdir(), "pi-ecode-loader-history-"));
    temporaryPaths.push(cwd, storage);
    await writeFile(join(cwd, "package.json"), "{}", "utf8");
    const history = new WorkspaceHistory(storage);
    const services = await createAgentSessionServices({
      cwd,
      agentDir: getAgentDir(),
      resourceLoaderOptions: {
        extensionFactories: [history.asExtension()],
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter((extension) => (
            !extension.path.replaceAll("\\", "/").includes("/node_modules/pi-workspace-history/")
          )),
        }),
      },
    });
    const loaded = services.resourceLoader.getExtensions();
    const paths = loaded.extensions.map((extension) => extension.path.replaceAll("\\", "/"));

    expect(paths.some((path) => path.includes("inline:pi-ecode-workspace-history"))).toBe(true);
    expect(paths.some((path) => path.includes("/node_modules/pi-workspace-history/"))).toBe(false);
    expect(loaded.errors).toEqual([]);
  });
});
