import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectGitAvailability, ProjectGitStatus } from "../shared/contracts.js";

const execFileAsync = promisify(execFile);
const STATUS_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 120_000;

type GitRunner = (cwd: string, args: readonly string[], timeoutMs: number) => Promise<string>;

function emptyStatus(availability: ProjectGitAvailability, message: string | null = null): ProjectGitStatus {
  return { availability, branch: null, upstream: null, ahead: 0, behind: 0, message };
}

function commandErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const candidate = error as { message?: unknown; stderr?: unknown };
  const stderr = typeof candidate.stderr === "string" ? candidate.stderr.trim() : "";
  if (stderr) return stderr;
  return typeof candidate.message === "string" ? candidate.message : String(error);
}

const runGit: GitRunner = async (cwd, args, timeoutMs) => {
  const result = await execFileAsync("git", [...args], {
    cwd,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
};

export class ProjectGitService {
  constructor(
    private readonly getProjectPath: () => string | null,
    private readonly execute: GitRunner = runGit,
  ) {}

  async getStatus(): Promise<ProjectGitStatus> {
    const cwd = this.getProjectPath();
    return cwd ? this.getStatusFor(cwd) : emptyStatus("not-repository");
  }

  async push(): Promise<ProjectGitStatus> {
    const cwd = this.getProjectPath();
    if (!cwd) throw new Error("No project is open.");
    const status = await this.getStatusFor(cwd);
    if (status.availability !== "ready") throw new Error("The current project branch is not ready to push.");
    if (status.behind > 0) throw new Error("The current branch is behind its upstream. Reconcile it before pushing.");
    if (status.ahead === 0) throw new Error("There are no local commits to push.");
    await this.execute(cwd, ["push", "--porcelain"], PUSH_TIMEOUT_MS);
    return this.getStatusFor(cwd);
  }

  private async getStatusFor(cwd: string): Promise<ProjectGitStatus> {
    try {
      if (await this.execute(cwd, ["rev-parse", "--is-inside-work-tree"], STATUS_TIMEOUT_MS) !== "true") {
        return emptyStatus("not-repository");
      }
    } catch (error) {
      const message = commandErrorMessage(error);
      return /not a git repository/iu.test(message)
        ? emptyStatus("not-repository")
        : emptyStatus("error", message);
    }

    let branch: string;
    try {
      branch = await this.execute(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], STATUS_TIMEOUT_MS);
    } catch {
      return emptyStatus("detached");
    }

    let upstream: string;
    try {
      upstream = await this.execute(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], STATUS_TIMEOUT_MS);
    } catch {
      return { ...emptyStatus("no-upstream"), branch };
    }

    try {
      const counts = await this.execute(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], STATUS_TIMEOUT_MS);
      const [behindText, aheadText] = counts.split(/\s+/u);
      const behind = Number(behindText);
      const ahead = Number(aheadText);
      if (!Number.isInteger(behind) || !Number.isInteger(ahead)) throw new Error("Git returned invalid ahead/behind counts.");
      return { availability: "ready", branch, upstream, ahead, behind, message: null };
    } catch (error) {
      return { ...emptyStatus("error", commandErrorMessage(error)), branch, upstream };
    }
  }
}
