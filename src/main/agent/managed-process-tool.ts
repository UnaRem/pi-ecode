import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ManagedProcess, StartManagedProcessRequest } from "../../shared/process-contracts.js";

interface ManagedProcessToolOptions {
  isCurrent: (cwd: string, sessionId: string) => boolean;
  start: (request: StartManagedProcessRequest) => Promise<ManagedProcess>;
  stop: (id: string) => Promise<void>;
}

export class ManagedProcessToolService {
  constructor(private readonly options: ManagedProcessToolOptions) {}

  asExtension(): InlineExtension {
    return { name: "pi-ecode-managed-process-tool", factory: (pi) => this.register(pi) };
  }

  private register(pi: ExtensionAPI): void {
    pi.registerTool({
      name: "start_process",
      label: "启动托管进程",
      description: "启动用户已授权的常驻命令，由宿主管理项目归属、输出和停止。Windows 使用 cmd.exe /d /s /c 命令环境；其他系统使用 /bin/sh -c。",
      promptGuidelines: [
        "Use start_process only when the user has authorized a persistent service, for example bun run dev.",
        "Do not background commands yourself with &, start, or nohup. Do not use this tool for fixed validation or automatic previews.",
        "Successful spawn does not mean the service is ready; inspect its actual output before claiming readiness.",
      ],
      executionMode: "sequential",
      parameters: Type.Object({ command: Type.String({ minLength: 1, maxLength: 16_000, pattern: "^[^\\u0000]+$" }) }, { additionalProperties: false }),
      execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
        signal?.throwIfAborted();
        const cwd = ctx.cwd;
        const sessionId = ctx.sessionManager.getSessionId();
        if (!this.options.isCurrent(cwd, sessionId)) throw new Error("Process context is not the active project session.");
        if (!params.command.trim() || params.command.length > 16_000 || params.command.includes("\0")) {
          throw new Error("Invalid managed process command.");
        }
        const started = await this.options.start({ command: params.command, projectPath: cwd, sessionId, originToolCallId: toolCallId });
        // 启动等待期间可能取消或切换项目；刚登记的进程不能遗留在旧任务中。
        if (signal?.aborted || !this.options.isCurrent(cwd, sessionId)) {
          await this.options.stop(started.id);
          signal?.throwIfAborted();
          throw new Error("Process context changed during startup.");
        }
        const output = started.output ? `\n已有输出（最多末尾 8,000 字符）：\n${started.output.slice(-8_000)}` : "";
        return { content: [{ type: "text", text: `托管进程已启动。\nID：${started.id}\nPID：${started.pid ?? "尚未提供"}\n命令：${started.command}\n启动成功不代表服务已就绪。${output}` }], details: started };
      },
    });
  }
}
