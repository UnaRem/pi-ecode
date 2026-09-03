import { describe, expect, it, vi } from "vitest";
import { ProjectGitService } from "./project-git-service.js";

function statusRunner(counts = "0 3") {
  return vi.fn(async (_cwd: string, args: readonly string[]): Promise<string> => {
    const command = args.join(" ");
    if (command === "rev-parse --is-inside-work-tree") return "true";
    if (command === "symbolic-ref --quiet --short HEAD") return "main";
    if (command === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") return "origin/main";
    if (command === "rev-list --left-right --count @{upstream}...HEAD") return counts;
    if (command === "push --porcelain") return "";
    throw new Error(`Unexpected command: ${command}`);
  });
}

describe("ProjectGitService", () => {
  it("reports the current branch, upstream, and ahead count", async () => {
    const service = new ProjectGitService(() => "C:/project", statusRunner("2 5"));
    await expect(service.getStatus()).resolves.toEqual({
      availability: "ready",
      branch: "main",
      upstream: "origin/main",
      ahead: 5,
      behind: 2,
      message: null,
    });
  });

  it("does not guess a remote when the branch has no upstream", async () => {
    const runner = statusRunner();
    runner.mockImplementation(async (_cwd, args) => {
      const command = args.join(" ");
      if (command === "rev-parse --is-inside-work-tree") return "true";
      if (command === "symbolic-ref --quiet --short HEAD") return "feature/icon";
      throw new Error("no upstream configured");
    });
    const service = new ProjectGitService(() => "C:/project", runner);
    await expect(service.getStatus()).resolves.toMatchObject({ availability: "no-upstream", branch: "feature/icon" });
    expect(runner).not.toHaveBeenCalledWith("C:/project", ["push", "--porcelain"], expect.any(Number));
  });

  it("pushes only the captured project with fixed arguments and refreshes status", async () => {
    let countsRequest = 0;
    const runner = statusRunner();
    runner.mockImplementation(async (_cwd, args) => {
      const command = args.join(" ");
      if (command === "rev-parse --is-inside-work-tree") return "true";
      if (command === "symbolic-ref --quiet --short HEAD") return "main";
      if (command === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") return "origin/main";
      if (command === "rev-list --left-right --count @{upstream}...HEAD") return countsRequest++ === 0 ? "0 3" : "0 0";
      if (command === "push --porcelain") return "";
      throw new Error(`Unexpected command: ${command}`);
    });
    const getProjectPath = vi.fn()
      .mockReturnValueOnce("C:/first-project")
      .mockReturnValue("C:/second-project");
    const service = new ProjectGitService(getProjectPath, runner);

    await expect(service.push()).resolves.toMatchObject({ availability: "ready", ahead: 0 });
    expect(getProjectPath).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith("C:/first-project", ["push", "--porcelain"], 120_000);
    expect(runner.mock.calls.every(([cwd]) => cwd === "C:/first-project")).toBe(true);
  });

  it("refuses to push a branch that is behind its upstream", async () => {
    const runner = statusRunner("1 2");
    const service = new ProjectGitService(() => "C:/project", runner);
    await expect(service.push()).rejects.toThrow("behind its upstream");
    expect(runner.mock.calls.some(([, args]) => args.join(" ") === "push --porcelain")).toBe(false);
  });
});
