import { spawn, type ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { delimiter, extname, join, resolve } from "node:path";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const CODEGRAPH_TOOL_NAME = "codegraph_explore";
const CODEGRAPH_INDEX_DIRECTORY = ".codegraph";
// 索引只有在 codegraph.db 这个实文件存在时才算可用；空目录不是索引。
const CODEGRAPH_INDEX_FILE_NAME = "codegraph.db";
const CLI_ENVIRONMENT_VARIABLE = "PI_ECODE_CODEGRAPH_CLI";
// 本机实测的安装形态：npm bin 里的 codegraph.cmd 最终执行
// node_modules/@colbymchenry/codegraph/npm-shim.js，而 npm-shim.js 自己再去
// require.resolve 嵌套安装的平台包。因此这里只需要解析到 bin 对应的 JS 入口。
const PACKAGE_DIRECTORIES = ["@colbymchenry/codegraph", "codegraph"];
const MAX_QUERY_LENGTH = 400;
const MAX_OUTPUT_LENGTH = 60_000;
const TIMEOUT_MS = 90_000;
// 这些包装脚本只能用 shell 启动（Node 出于安全考虑拒绝直接执行），因此一律拒绝。
const SHELL_WRAPPER_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);

export class CodegraphError extends Error {}

interface PackageManifest {
  bin?: string | Record<string, string>;
  main?: string;
}

export interface CodegraphInvocation {
  /** 始终是可执行程序本身，绝不拼接命令字符串。 */
  command: string;
  /** 查询与参数都是独立数组元素，shell:false 下不会被解释。 */
  args: string[];
  cwd: string;
  /** 传给 JS CLI 的补充环境变量。 */
  env: Record<string, string>;
}

export interface CodegraphRunResult {
  output: string;
  truncated: boolean;
  exitCode: number | null;
}

export interface CodegraphToolOptions {
  /** 当前主会话明确选中的项目目录；未选择项目时返回 undefined。 */
  getProjectPath: () => string | undefined;
}

export function assertExploreQuery(rawQuery: unknown): string {
  if (typeof rawQuery !== "string") throw new CodegraphError("CodeGraph 查询必须是字符串。");
  const query = rawQuery.trim();
  if (!query) throw new CodegraphError("CodeGraph 查询不能为空。");
  if (query.length > MAX_QUERY_LENGTH) throw new CodegraphError(`CodeGraph 查询不能超过 ${MAX_QUERY_LENGTH} 个字符。`);
  if (/[\u0000-\u001f\u007f]/u.test(query)) throw new CodegraphError("CodeGraph 查询不能包含控制字符或换行符。");
  return query;
}

/**
 * codegraph 参数固定为 `explore --max-files 3 -- <query>`，项目目录只通过 cwd 传递。
 * 因此 query 与项目路径都不参与命令串拼接，Windows 上也不存在 shell 元字符注入面。
 *
 * `--`：终止选项解析。否则形如 `--help` / `--project=...` 的查询会被 CLI 当成选项，
 * 相当于工具被动接受了调用方指定的开关。
 * `--max-files 3`：限制 CLI 自身产生的上下文量；属宿主固定的字面量，不受 query 影响。
 *
 * ELECTRON_RUN_AS_NODE：command 恒为 process.execPath，在打包运行时它是 Electron 可执行文件，
 * 必须靠这个变量才会以纯 Node 模式执行 JS 入口（与 candidate-service.ts 的监管进程一致）。
 * CODEGRAPH_NO_DOWNLOAD：npm-shim.js 在缺少平台包时会自动从 GitHub 下载，只读工具不能隐式联网下载。
 */
export function codegraphExploreInvocation(entry: string, projectPath: string, query: string): CodegraphInvocation {
  return codegraphInvocation(entry, projectPath, ["explore", "--max-files", "3", "--", query]);
}

/**
 * 宿主侧索引同步的参数固定为 `sync`：没有查询文本，也没有任何受调用方影响的 token。
 * 它只由主进程在验证通过后调用，不注册为模型工具，也不会代替用户执行 init。
 */
export function codegraphSyncInvocation(entry: string, projectPath: string): CodegraphInvocation {
  return codegraphInvocation(entry, projectPath, ["sync"]);
}

function codegraphInvocation(entry: string, projectPath: string, args: string[]): CodegraphInvocation {
  return {
    command: process.execPath,
    args: [entry, ...args],
    cwd: projectPath,
    env: { ELECTRON_RUN_AS_NODE: "1", CODEGRAPH_NO_DOWNLOAD: "1" },
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function binEntryOf(manifest: PackageManifest): string | undefined {
  const bin = manifest.bin;
  if (typeof bin === "string") return bin;
  if (bin) {
    const named = bin.codegraph ?? Object.values(bin)[0];
    if (named) return named;
  }
  return manifest.main;
}

/**
 * 读取真实存在的包并解析出可执行的 JS 入口。任何一步不满足都返回 undefined，
 * 绝不构造一个未经校验的路径去执行。
 */
async function resolvePackageEntry(packageRoot: string): Promise<string | undefined> {
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as PackageManifest;
  } catch {
    return undefined;
  }
  const relativeEntry = binEntryOf(manifest);
  if (!relativeEntry) return undefined;
  const entry = resolve(packageRoot, relativeEntry);
  // bin 指向 shell 包装脚本时不可用：启动它必须经过 shell，等于把命令注入面放回来。
  if (SHELL_WRAPPER_EXTENSIONS.has(extname(entry).toLowerCase())) return undefined;
  return await isFile(entry) ? entry : undefined;
}

async function resolveProjectLocalEntry(projectPath: string): Promise<string | undefined> {
  for (const directory of PACKAGE_DIRECTORIES) {
    const entry = await resolvePackageEntry(join(projectPath, "node_modules", directory));
    if (entry) return entry;
  }
  return undefined;
}

/**
 * npm 全局 bin 目录的候选前缀：显式配置的 npm 前缀、Windows 上 npm 的默认全局前缀
 * （%APPDATA%\npm，即 where codegraph 命中的位置），以及 PATH 中的每个目录。
 * 这些只是候选，包是否真的存在由 resolvePackageEntry 逐项校验。
 */
function npmPrefixCandidates(): string[] {
  const candidates = new Set<string>();
  const configured = process.env.npm_config_prefix?.trim();
  if (configured) candidates.add(configured);
  const appData = process.env.APPDATA;
  if (process.platform === "win32" && appData) candidates.add(join(appData, "npm"));
  for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
    const trimmed = pathEntry.trim();
    if (trimmed) candidates.add(trimmed);
  }
  return [...candidates];
}

async function resolveGlobalEntry(): Promise<string | undefined> {
  for (const prefix of npmPrefixCandidates()) {
    for (const directory of PACKAGE_DIRECTORIES) {
      const entry = await resolvePackageEntry(join(prefix, "node_modules", directory));
      if (entry) return entry;
    }
  }
  return undefined;
}

async function resolveCliEntry(projectPath: string): Promise<string> {
  const configured = process.env[CLI_ENVIRONMENT_VARIABLE]?.trim();
  if (configured) {
    const entry = resolve(configured);
    if (SHELL_WRAPPER_EXTENSIONS.has(extname(entry).toLowerCase())) {
      throw new CodegraphError(`${CLI_ENVIRONMENT_VARIABLE} 不能指向 .cmd/.bat/.ps1 包装脚本：启动它们必须经过 shell，会引入命令注入风险。请指向由 node 直接执行的 JS 入口。`);
    }
    if (!(await isFile(entry))) throw new CodegraphError(`${CLI_ENVIRONMENT_VARIABLE} 指向的文件不存在：${entry}`);
    return entry;
  }
  const projectEntry = await resolveProjectLocalEntry(projectPath);
  if (projectEntry) return projectEntry;
  const globalEntry = await resolveGlobalEntry();
  if (globalEntry) return globalEntry;
  throw new CodegraphError(`没有找到可用的 codegraph CLI。请全局或在本项目安装 @colbymchenry/codegraph，或把 ${CLI_ENVIRONMENT_VARIABLE} 指向它的 JS 入口。`);
}

function indexPathOf(projectPath: string): string {
  return join(projectPath, CODEGRAPH_INDEX_DIRECTORY, CODEGRAPH_INDEX_FILE_NAME);
}

async function assertIndexPresent(projectPath: string): Promise<void> {
  if (await isFile(indexPathOf(projectPath))) return;
  throw new CodegraphError(`当前项目没有可用的 CodeGraph 索引（缺少 ${CODEGRAPH_INDEX_DIRECTORY}/${CODEGRAPH_INDEX_FILE_NAME}）。请先手动运行 codegraph init -i；本工具不会自动初始化或同步索引。`);
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // 取消/超时承诺「进程已结束」就必须真实等到 close；否则调用方拿到拒绝时进程仍在运行。
  const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
  let fallbackAttempted = false;
  // taskkill 可能启动失败（error）或以非零退出（例如被安全软件拦截）。这两条事件都只会出现一次，
  // 因此用同一个 guard 兜底：确保我们主动尝试过终止 child，而不是直接去 await closed 造成永久挂起。
  // child 已经结束时不再补发信号，避免误伤已回收/复用的 pid。
  const onFallback = (): void => {
    if (fallbackAttempted) return;
    fallbackAttempted = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  if (process.platform === "win32" && child.pid) {
    // Windows 上没有可靠的进程组信号，沿用与固定验证相同的 taskkill 收尾方式。
    await new Promise<void>((resolveClose) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => { onFallback(); resolveClose(); });
      killer.once("close", (code) => {
        if (code !== 0) onFallback();
        resolveClose();
      });
    });
  } else {
    child.kill("SIGTERM");
  }
  await closed;
}

async function runCodegraphProcess(invocation: CodegraphInvocation, label: string, signal: AbortSignal | undefined): Promise<CodegraphRunResult> {
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: { ...process.env, NO_COLOR: "1", ...invocation.env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    // 显式关闭 shell：任何平台都不经过 cmd.exe / sh 解析，参数原样传递。
    shell: false,
  });
  let output = "";
  let truncated = false;
  const append = (chunk: Buffer): void => {
    if (truncated) return;
    output += chunk.toString("utf8");
    if (output.length > MAX_OUTPUT_LENGTH) {
      output = output.slice(0, MAX_OUTPUT_LENGTH);
      truncated = true;
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  return await new Promise<CodegraphRunResult>((resolveResult, rejectResult) => {
    let settled = false;
    let interruption: string | undefined;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    // close 是唯一的结果出口：取消与超时都先真正结束子进程，再按中断原因落定，避免遗留孤儿进程。
    const finish = (code: number | null): void => settle(() => {
      if (interruption) {
        rejectResult(new CodegraphError(interruption));
        return;
      }
      if (code === 0) {
        resolveResult({ output, truncated, exitCode: 0 });
        return;
      }
      const detail = output.trim();
      rejectResult(new CodegraphError(`${label} 以退出码 ${code ?? "未知"} 结束。${detail ? `\n${detail}` : ""}`));
    });
    const interrupt = (message: string): void => {
      if (settled || interruption) return;
      interruption = message;
      void terminate(child).finally(() => finish(null));
    };
    const timer = setTimeout(() => interrupt(`${label} 超过 ${TIMEOUT_MS / 1000} 秒未结束，进程已终止。`), TIMEOUT_MS);
    const onAbort = (): void => interrupt(`${label} 已取消。`);
    child.once("error", (error) => settle(() => rejectResult(new CodegraphError(`无法启动 codegraph CLI：${error.message}`))));
    child.once("close", (code) => finish(code));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function codegraphResultText(result: CodegraphRunResult): string {
  const body = result.output.trim() || "codegraph explore 未返回任何内容。";
  return result.truncated ? `${body}\n\n…输出超过 ${MAX_OUTPUT_LENGTH} 个字符，已截断。` : body;
}

export class CodegraphToolService {
  constructor(private readonly options: CodegraphToolOptions) {}

  /**
   * 宿主侧刷新已有索引：由主进程在验证通过后调用，不是模型工具，也不会被模型触发。
   * 约定：没有 .codegraph/codegraph.db 时返回 false 且完全不启动 CLI（绝不自动创建索引）。
   */
  async syncIndex(projectPath: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (!(await isFile(indexPathOf(projectPath)))) return false;
    signal?.throwIfAborted();
    const entry = await resolveCliEntry(projectPath);
    signal?.throwIfAborted();
    await runCodegraphProcess(codegraphSyncInvocation(entry, projectPath), "codegraph sync", signal);
    return true;
  }

  asExtension(): InlineExtension {
    return { name: "pi-ecode-codegraph", factory: (pi) => this.register(pi) };
  }

  private register(pi: ExtensionAPI): void {
    pi.registerTool({
      name: CODEGRAPH_TOOL_NAME,
      label: "查询 CodeGraph 索引",
      description: "对当前项目已建立的 .codegraph/codegraph.db 索引执行固定的 codegraph explore 只读查询。codegraph_explore 不接受任意命令或参数；索引缺失时直接报错，绝不自动初始化、同步或下载。",
      promptSnippet: "对当前项目已建立的 CodeGraph 索引执行只读探索",
      promptGuidelines: [
        "只在当前项目已有 .codegraph/codegraph.db 时调用 codegraph_explore；缺少索引时向用户报告缺什么，不要尝试 init 或 sync。",
        "codegraph_explore 一次只传一个自然语言查询或符号名，参数由宿主固定为 codegraph explore --max-files 3 --；不要尝试在查询里追加命令行开关。",
        "codegraph_explore 是只读工具，不会修改项目文件，也不会接受任何命令行开关。",
      ],
      executionMode: "sequential",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH, description: "要在 CodeGraph 索引中检索的问题或符号名。" }),
      }),
      execute: async (_toolCallId, params, signal) => this.explore(params.query, signal),
    });
  }

  private async explore(rawQuery: unknown, signal: AbortSignal | undefined): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
    signal?.throwIfAborted();
    const query = assertExploreQuery(rawQuery);
    const projectPath = this.options.getProjectPath();
    if (!projectPath) throw new CodegraphError("尚未选择项目，无法使用 CodeGraph。");
    await assertIndexPresent(projectPath);
    signal?.throwIfAborted();
    const entry = await resolveCliEntry(projectPath);
    // 两次 await 期间都可能已被取消；真正 spawn 前再检查一次，否则取消仍会启动进程。
    signal?.throwIfAborted();
    const result = await runCodegraphProcess(codegraphExploreInvocation(entry, projectPath, query), "codegraph explore", signal);
    return {
      content: [{ type: "text", text: codegraphResultText(result) }],
      details: { kind: "pi-ecode.codegraph-explore", version: 1, query, truncated: result.truncated },
    };
  }
}
