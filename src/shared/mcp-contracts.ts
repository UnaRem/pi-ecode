export interface McpToolSummary {
  name: string;
  server: string;
  description: string;
  exposure: "direct" | "model-only" | "codemode" | "deferred";
}
