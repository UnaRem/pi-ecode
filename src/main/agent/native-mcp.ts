import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type ExtensionFactory,
  type McpExtensionOptions,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { McpToolSummary } from "../../shared/mcp-contracts.js";

const RESOURCE_TOOL_NAMES = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

function prepareFastctxGrepArguments(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const parameters: Record<string, unknown> = { ...input };
  // FastCtx treats even an empty encoding as supplied; empty placeholders mean auto-detect.
  for (const name of ["encoding", "fallback_encoding"]) {
    if (parameters[name] === "") delete parameters[name];
  }
  return parameters;
}

/** Tracks the definitions actually registered by this session's native MCP extension. */
export class NativeMcp {
  private readonly tools = new Map<string, McpToolSummary>();
  private pendingPublish = false;

  constructor(private readonly onChange: (tools: McpToolSummary[]) => void) {}

  get current(): McpToolSummary[] {
    return [...this.tools.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  extensions(options?: McpExtensionOptions): ExtensionFactory[] {
    const mcp = createMcpExtension(options);
    return [createCodemodeExtension(), createToolSearchExtension(), (pi) => {
      pi.on("session_shutdown", () => this.tools.clear());
      return mcp({ ...pi, registerTool: (tool) => {
        pi.registerTool(tool.name === "mcp__fastctx__grep" ? { ...tool, prepareArguments: (raw) => (
          // The SDK validates against the original schema after this preparation hook.
          prepareFastctxGrepArguments(tool.prepareArguments ? tool.prepareArguments(raw) : raw) as ReturnType<NonNullable<typeof tool.prepareArguments>>
        ) } : tool);
        this.updateTool(tool);
      } });
    }];
  }

  private updateTool(tool: Pick<ToolInfo, "name" | "description" | "namespace"> & { exposure?: ToolInfo["exposure"] }): void {
    const resourceTool = RESOURCE_TOOL_NAMES.has(tool.name);
    if (!resourceTool && !tool.name.startsWith("mcp__")) return;
    if (tool.exposure === "hidden") this.tools.delete(tool.name);
    else this.tools.set(tool.name, {
      name: tool.name,
      server: resourceTool ? "MCP resources" : tool.namespace?.name.replace(/^mcp__/u, "") ?? tool.name.split("__")[1]!,
      description: tool.description,
      exposure: tool.exposure ?? "direct",
    });
    if (this.pendingPublish) return;
    this.pendingPublish = true;
    // A server registers a batch synchronously; publish once after its complete tools/list update.
    queueMicrotask(() => {
      this.pendingPublish = false;
      this.onChange(this.current);
    });
  }
}
