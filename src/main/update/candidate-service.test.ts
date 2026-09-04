import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({ appPath: "", isPackaged: false, quit: vi.fn() }));
vi.mock("electron", () => ({
  app: {
    get isPackaged() { return electronState.isPackaged; },
    getAppPath: () => electronState.appPath,
    quit: electronState.quit,
  },
}));

import type { CandidateState } from "../../shared/contracts.js";
import { CandidateService } from "./candidate-service.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  electronState.isPackaged = false;
  electronState.quit.mockClear();
  delete process.env.PI_ECODE_DEVELOPMENT_RUNTIME;
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runtimeRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pi-ecode-${label}-`));
  temporaryPaths.push(root);
  await mkdir(join(root, "out", "main"), { recursive: true });
  await mkdir(join(root, "out", "preload"), { recursive: true });
  await mkdir(join(root, "out", "renderer"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "out", "main", "index.js"), `// ${label} main\n`, "utf8");
  await writeFile(join(root, "out", "preload", "index.cjs"), `// ${label} preload\n`, "utf8");
  await writeFile(join(root, "out", "renderer", "index.html"), `<p>${label}</p>`, "utf8");
  return root;
}

describe("CandidateService", () => {
  it("discovers the self-hosting source root from a development app path", async () => {
    const source = await runtimeRoot("discover");
    await mkdir(join(source, "src", "main"), { recursive: true });
    await writeFile(join(source, "src", "main", "index.ts"), "export {};\n", "utf8");
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "pi-ecode" }), "utf8");
    const updates = await mkdtemp(join(tmpdir(), "pi-ecode-discover-updates-"));
    temporaryPaths.push(updates);
    electronState.appPath = source;
    const service = new CandidateService(updates, () => undefined);

    await service.initialize();
    expect(await service.discoverSourceRoot()).toBe(source);
  });

  it("preserves the running artifact and stages an isolated candidate", async () => {
    const current = await runtimeRoot("current");
    const source = await runtimeRoot("candidate");
    const updates = await mkdtemp(join(tmpdir(), "pi-ecode-updates-"));
    temporaryPaths.push(updates);
    electronState.appPath = current;
    const events: string[] = [];
    const service = new CandidateService(updates, (state) => events.push(state.status));

    await service.initialize();
    service.configure(source);
    const result = await service.prepare();

    expect(result.status).toBe("ready");
    expect(events).toEqual(expect.arrayContaining(["preparing", "ready"]));
    expect(await readFile(join(updates, "stable", "out", "main", "index.js"), "utf8")).toContain("current");
    expect(await readFile(join(result.candidatePath!, "out", "main", "index.js"), "utf8")).toContain("candidate");
    expect(JSON.parse(await readFile(join(result.candidatePath!, "package.json"), "utf8"))).toMatchObject({
      name: "pi-ecode",
      main: "out/main/index.js",
      type: "module",
      piEcodeSourceRoot: source,
    });
    expect(await realpath(join(result.candidatePath!, "node_modules"))).toBe(await realpath(join(source, "node_modules")));
    expect(service.getState().history[0]).toMatchObject({ id: result.candidateId, status: "prepared" });
    expect(JSON.parse(await readFile(join(updates, "ledger.json"), "utf8"))).toHaveLength(1);
  });

  it("allows candidate preparation from the branded development executable", async () => {
    const source = await runtimeRoot("branded");
    const updates = await mkdtemp(join(tmpdir(), "pi-ecode-branded-updates-"));
    temporaryPaths.push(updates);
    electronState.appPath = source;
    electronState.isPackaged = true;
    process.env.PI_ECODE_DEVELOPMENT_RUNTIME = "1";
    const service = new CandidateService(updates, () => undefined);

    await service.initialize();
    service.configure(source);

    await expect(service.prepare()).resolves.toMatchObject({ status: "ready" });
  });

  it("retains only the three newest candidate artifact directories", async () => {
    const source = await runtimeRoot("retention");
    const updates = await mkdtemp(join(tmpdir(), "pi-ecode-retention-"));
    temporaryPaths.push(updates);
    electronState.appPath = source;
    const service = new CandidateService(updates, () => undefined);
    await service.initialize();
    service.configure(source);
    const candidates: CandidateState[] = [];
    for (let index = 0; index < 4; index += 1) candidates.push(await service.prepare());

    await expect(access(candidates[0]!.candidatePath!)).rejects.toThrow();
    for (const candidate of candidates.slice(1)) await expect(access(candidate.candidatePath!)).resolves.toBeUndefined();
    expect(service.getState().history.find((record) => record.id === candidates[0]!.candidateId)?.status).toBe("discarded");
  });

  it("reconciles supervisor outcomes into the persistent ledger", async () => {
    const source = await runtimeRoot("reconcile");
    const updates = await mkdtemp(join(tmpdir(), "pi-ecode-reconcile-"));
    temporaryPaths.push(updates);
    electronState.appPath = source;
    const first = new CandidateService(updates, () => undefined);
    await first.initialize();
    first.configure(source);
    const candidate = await first.prepare();
    await writeFile(join(updates, `result-${candidate.candidateId}.json`), JSON.stringify({ status: "active", at: 42 }), "utf8");

    const restored = new CandidateService(updates, () => undefined);
    await restored.initialize();
    restored.configure(source);
    expect(restored.getState().history.find((record) => record.id === candidate.candidateId)).toMatchObject({
      status: "active",
      updatedAt: 42,
    });
  });

  it("invalidates a prepared candidate when source changes", async () => {
    const source = await runtimeRoot("source");
    const updates = await mkdtemp(join(tmpdir(), "pi-ecode-updates-"));
    temporaryPaths.push(updates);
    electronState.appPath = source;
    const service = new CandidateService(updates, () => undefined);
    await service.initialize();
    service.configure(source);
    await service.prepare();

    service.invalidate();
    expect(service.getState()).toMatchObject({ status: "idle", candidateId: null });
  });
});
