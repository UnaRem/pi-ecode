export type ManagedProcessStatus = "starting" | "running" | "stopping" | "stopped" | "exited" | "error";

export interface ManagedProcess {
  status: ManagedProcessStatus;
  id: string;
  projectPath: string;
  sessionId: string;
  originToolCallId: string;
  command: string;
  pid: number | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  output: string;
  outputTruncated: boolean;
  errorMessage: string | null;
}

export interface StartManagedProcessRequest {
  command: string;
  sessionId: string;
  originToolCallId: string;
  projectPath: string;
}
