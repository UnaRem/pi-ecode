export type ToolCapability = "file-read" | "file-search" | "file-edit" | "web-search" | "browser" | "git" | "shell" | "other";
export type ToolAdjustment = "collect" | "inspect-input" | "compare-latency";

export interface ToolStatistic {
  name: string;
  capability: ToolCapability;
  nested: boolean;
  successes: number;
  failures: number;
  cancelled: number;
  blocked: number;
  medianMs: number | null;
  p95Ms: number | null;
  adjustment: ToolAdjustment;
}
