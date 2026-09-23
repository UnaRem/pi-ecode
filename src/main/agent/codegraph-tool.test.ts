import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  assertExploreQuery,
  codegraphExploreInvocation,
  CODEGRAPH_TOOL_NAME,
  CodegraphError,
  CodegraphToolService,
} from "./codegraph-tool.js";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface RegisteredTool {
  name: string;
  executionMode?: string;
  parameters?: { required?: string[]; properties?: Record<string, unknown> };
  execute: (toolCallId: string, params: { query: string }, signal: AbortSignal | undefined) => Promise<ToolResult>;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  // 被 taskkill 结束的进程可能仍短时占用 fixture 文件，清理失败不影响断言结果。
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }));
});

async function projectDirectory(withIndex: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-ecode-codegraph-"));
  temporaryDirectories.push(root);
  if (withIndex) {
    await mkdir(join(root, ".codegraph"), { recursive: true });
    await writeFile(join(root, ".codegraph", "codegraph.db"), "SQLite format 3", "utf8");
  }
  return root;
}

/** 写入一个真实的 node fixture，用来观察 host 实际传下去的 argv 与 env。 */
async function fixtureScript(source: string): Promise<string> {
  const root = await projectDirectory(false);
  const script = join(root, "fake-codegraph.mjs");
  await writeFile(script, source, "utf8");
  return script;
}

const REPORT_ENVIRONMENT = "process.stdout.write(JSON.stringify({"
  + " argv: process.argv.slice(2),"
  + " electronAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,"
  + " noDownload: process.env.CODEGRAPH_NO_DOWNLOAD ?? null"
  + " }));";

/**
 * 复刻本机实测的全局安装形态：npm bin 目录里有一个 codegraph.cmd，真正的 JS 入口在
 * <prefix>/node_modules/@colbymchenry/codegraph/npm-shim.js。
 */
async function npmPrefixFixture(shimSource: string): Promise<string> {
  const prefix = join(await projectDirectory(false), "npm");
  const packageRoot = join(prefix, "node_modules", "@colbymchenry", "codegraph");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@colbymchenry/codegraph", version: "1.6.0", bin: { codegraph: "npm-shim.js" } }),
    "utf8",
  );
  await writeFile(join(packageRoot, "npm-shim.js"), shimSource, "utf8");
  // 真实的 npm 包装脚本只作为发现线索；若被本工具执行就会留下标记文件。
  await writeFile(join(prefix, "codegraph.cmd"), "@echo off\r\necho pwned > \"%~dp0pwned-marker.txt\"\r\n", "utf8");
  return prefix;
}

async function localPackageFixture(projectPath: string, shimSource: string): Promise<void> {
  const packageRoot = join(projectPath, "node_modules", "@colbymchenry", "codegraph");
  await mkdir(packageRoot, { recursive: true });
  // 字符串形式的 bin，覆盖 package.json 的另一种合法写法。
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@colbymchenry/codegraph", bin: "npm-shim.js" }), "utf8");
  await writeFile(join(packageRoot, "npm-shim.js"), shimSource, "utf8");
}

/** 隔离本机真实安装：PATH 与 npm 前缀都指向受控目录。 */
async function isolateInstall(options: { npmPrefix?: string; pathDirectory?: string } = {}): Promise<void> {
  const empty = await projectDirectory(false);
  vi.stubEnv("npm_config_prefix", options.npmPrefix ?? "");
  if (process.platform === "win32") vi.stubEnv("APPDATA", empty);
  vi.stubEnv("PATH", options.pathDirectory ?? empty);
}

function harness(projectPath: string | undefined) {
  const service = new CodegraphToolService({ getProjectPath: () => projectPath });
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool: (definition: RegisteredTool) => { tools.set(definition.name, definition); },
  } as unknown as ExtensionAPI;
  const extension = service.asExtension();
  void (typeof extension === "function" ? extension(pi) : extension.factory(pi));
  const tool = tools.get(CODEGRAPH_TOOL_NAME);
  if (!tool) throw new Error("codegraph_explore 工具未注册。");
  return {
    tool,
    explore: async (query: unknown, signal?: AbortSignal): Promise<ToolResult> =>
      await tool.execute("codegraph-call", { query: query as string }, signal),
  };
}

describe("codegraph 工具注册与参数边界", () => {
  it("registers a single read-only tool with a query-only parameter object", () => {
    const test = harness(undefined);

    expect(test.tool.name).toBe("codegraph_explore");
    expect(test.tool.executionMode).toBe("sequential");
    expect(test.tool.parameters?.required).toEqual(["query"]);
    expect(Object.keys(test.tool.parameters?.properties ?? {})).toEqual(["query"]);
  });

  it("rejects empty, oversized and control-character queries", () => {
    expect(() => assertExploreQuery("   ")).toThrow(CodegraphError);
    expect(() => assertExploreQuery("查询\nrm -rf /")).toThrow("控制字符");
    expect(() => assertExploreQuery("x".repeat(401))).toThrow("400");
    expect(() => assertExploreQuery(42)).toThrow("必须是字符串");
    expect(assertExploreQuery("  符号名  ")).toBe("符号名");
  });
});

describe("codegraph 索引前置条件", () => {
  it("refuses to run before a project is selected", async () => {
    const test = harness(undefined);
    await expect(test.explore("查询符号")).rejects.toThrow("尚未选择项目");
  });

  it("requires the codegraph.db file rather than the index directory alone", async () => {
    const projectPath = await projectDirectory(false);
    await mkdir(join(projectPath, ".codegraph"), { recursive: true });
    const test = harness(projectPath);

    await expect(test.explore("查询符号")).rejects.toThrow("codegraph.db");
  });

  it("reports a missing index without resolving or spawning the CLI", async () => {
    const test = harness(await projectDirectory(false));
    // 指向不存在的 CLI：若实现先解析 CLI 再检查索引，这里就会报 CLI 错误。
    vi.stubEnv("PI_ECODE_CODEGRAPH_CLI", join(tmpdir(), "pi-ecode-absent-codegraph.mjs"));

    await expect(test.explore("查询符号")).rejects.toThrow("没有可用的 CodeGraph 索引");
    await expect(test.explore("查询符号")).rejects.toThrow("init -i");
  });
});

describe("codegraph CLI 发现", () => {
  it("discovers the global @colbymchenry/codegraph bin entry from the npm prefix", async () => {
    const test = harness(await projectDirectory(true));
    await isolateInstall({ npmPrefix: await npmPrefixFixture(REPORT_ENVIRONMENT) });

    const result = await test.explore("符号名");

    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      argv: ["explore", "--max-files", "3", "--", "符号名"],
      electronAsNode: "1",
      noDownload: "1",
    });
  });

  it("discovers the package through the npm bin directory on PATH without running its .cmd shim", async () => {
    const test = harness(await projectDirectory(true));
    const prefix = await npmPrefixFixture(REPORT_ENVIRONMENT);
    await isolateInstall({ pathDirectory: prefix });

    const result = await test.explore("符号名");

    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      argv: ["explore", "--max-files", "3", "--", "符号名"],
      electronAsNode: "1",
      noDownload: "1",
    });
    await expect(readFile(join(prefix, "pwned-marker.txt"), "utf8")).rejects.toThrow();
  });

  it("prefers a project-local install over the global one", async () => {
    const projectPath = await projectDirectory(true);
    await localPackageFixture(projectPath, "process.stdout.write('local');");
    const test = harness(projectPath);
    const prefix = await npmPrefixFixture("process.stdout.write('global');");
    await isolateInstall({ npmPrefix: prefix, pathDirectory: prefix });

    await expect(test.explore("符号名")).resolves.toMatchObject({ content: [{ type: "text", text: "local" }] });
  });

  it("ignores a node_modules/codegraph directory that has no package manifest", async () => {
    const projectPath = await projectDirectory(true);
    await mkdir(join(projectPath, "node_modules", "codegraph"), { recursive: true });
    const test = harness(projectPath);
    await isolateInstall();

    await expect(test.explore("符号名")).rejects.toThrow("PI_ECODE_CODEGRAPH_CLI");
  });

  it("reports a missing CLI when neither the project nor a global npm prefix provides one", async () => {
    const test = harness(await projectDirectory(true));
    await isolateInstall();

    await expect(test.explore("符号名")).rejects.toThrow("没有找到可用的 codegraph CLI");
  });

  it("refuses .cmd wrappers passed through the environment variable", async () => {
    const test = harness(await projectDirectory(true));
    const wrapper = await fixtureScript("");
    const cmdPath = `${wrapper}.cmd`;
    await writeFile(cmdPath, "@echo off\r\n", "utf8");
    vi.stubEnv("PI_ECODE_CODEGRAPH_CLI", cmdPath);

    await expect(test.explore("查询符号")).rejects.toThrow("不能指向 .cmd/.bat/.ps1");
  });
});

describe("codegraph 进程边界", () => {
  it("passes the query as one untouched argv element instead of a shell command", async () => {
    const test = harness(await projectDirectory(true));
    vi.stubEnv("PI_ECODE_CODEGRAPH_CLI", await fixtureScript("process.stdout.write(JSON.stringify(process.argv.slice(2)));"));
    const hostile = "a & b | c > d \"e\" %PATH% $(whoami) `id` ; rm -rf /";

    const result = await test.explore(hostile);

    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(["explore", "--max-files", "3", "--", hostile]);
    expect(result.details).toMatchObject({ kind: "pi-ecode.codegraph-explore", query: hostile, truncated: false });
  });

  it("keeps option-like queries behind the -- terminator instead of parsing them as CLI flags", async () => {
    const test = harness(await projectDirectory(true));
    vi.stubEnv("PI_ECODE_CODEGRAPH_CLI", await fixtureScript("process.stdout.write(JSON.stringify(process.argv.slice(2)));"));

    for (const query of ["--help", "--project=C:/other", "-v"]) {
      const argv = JSON.parse((await test.explore(query)).content[0]?.text ?? "") as string[];

      // 固定部分不含 query，且 `--` 必须紧邻 query：CLI 因此不会把查询当成选项。
      expect(argv).toEqual(["explore", "--max-files", "3", "--", query]);
      expect(argv.indexOf("--")).toBe(argv.length - 2);
      expect(argv[argv.length - 1]).toBe(query);
      // query 出现在 `--` 之后，不可能被解释为需要取值的选项。
      expect(argv.slice(0, argv.length - 1)).not.toContain(query);
    }
  });

  it("keeps the executable, working directory and child environment fixed", async () => {
    const projectPath = await projectDirectory(true);
    const invocation = codegraphExploreInvocation("C:/tools/codegraph/cli.js", projectPath, "查询\"带引号\"的符号");

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual(["C:/tools/codegraph/cli.js", "explore", "--max-files", "3", "--", "查询\"带引号\"的符号"]);
    expect(invocation.cwd).toBe(projectPath);
    expect(invocation.args.join(" ")).not.toContain(projectPath);
    // Electron 打包运行时必须靠这个变量才会以纯 Node 模式执行 JS 入口。
    expect(invocation.env.ELECTRON_RUN_AS_NODE).toBe("1");
    // 只读工具不能触发 npm-shim 的隐式下载。
    expect(invocation.env.CODEGRAPH_NO_DOWNLOAD).toBe("1");
  });

  it("surfaces a non-zero exit code", async () => {
    const test = harness(await projectDirectory(true));
    vi.stubEnv("PI_ECODE_CODEGRAPH_CLI", await fixtureScript("process.stderr.write('索引损坏'); process.exit(3);"));

    await expect(test.explore("查询符号")).rejects.toThrow("退出码 3");
  });

  it("caps oversized output instead of buffering it without bound", async () => {
    const test = harness(await projectDirectory(true));
    vi.stubEnv("PI_ECODE_CODEGRAPH_CLI", await fixtureScript("process.stdout.write('x'.repeat(200000));"));

    const result = await test.explore("查询符号");

    expect(result.details.truncated).toBe(true);
    expect(result.content[0]?.text).toContain("已截断");
    expect(result.content[0]?.text.length).toBeLessThan(70_000);
  });

  it("terminates the child and reports cancellation", async () => {
    const test = harness(await projectDirectory(true));
    vi.stubEnv("PI_ECODE_CODEGRAPH_CLI", await fixtureScript("setInterval(() => {}, 1000);"));
    const controller = new AbortController();
    const pending = test.explore("查询符号", controller.signal);
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    controller.abort();

    await expect(pending).rejects.toThrow("已取消");
  });

  it("refuses to start when the signal is already aborted", async () => {
    const test = harness(await projectDirectory(true));
    vi.stubEnv("PI_ECODE_CODEGRAPH_CLI", await fixtureScript("process.stdout.write('不应执行');"));
    const controller = new AbortController();
    controller.abort();

    await expect(test.explore("查询符号", controller.signal)).rejects.toThrow();
  });

  it("does not spawn when the signal aborts during index and CLI discovery", async () => {
    const projectPath = await projectDirectory(true);
    const root = await projectDirectory(false);
    const marker = join(root, "spawned.txt");
    const script = join(root, "cli.mjs");
    await writeFile(
      script,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "spawned");\nprocess.stdout.write("ran");\n`,
      "utf8",
    );
    vi.stubEnv("PI_ECODE_CODEGRAPH_CLI", script);
    const test = harness(projectPath);
    const controller = new AbortController();

    const pending = test.explore("查询符号", controller.signal);
    // 同步取消：两次发现 await 都还没解决，因此新加的 throwIfAborted 必须先于 spawn 生效。
    controller.abort();

    await expect(pending).rejects.toThrow();
    // fixture 只有在真的被执行时才会写这个标记文件。
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });
});
