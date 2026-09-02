import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPERVISOR_SOURCE } from "./candidate-service.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  await vi.waitFor(async () => {
    await expect(access(path)).resolves.toBeUndefined();
  }, { timeout: timeoutMs, interval: 50 });
}

describe("candidate supervisor", () => {
  it("accepts a candidate only after its health file appears", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-ecode-supervisor-"));
    temporaryPaths.push(root);
    const supervisor = join(root, "supervisor.cjs");
    const candidate = join(root, "candidate.cjs");
    const fallback = join(root, "fallback.cjs");
    const health = join(root, "health.json");
    const result = join(root, "result.json");
    await writeFile(supervisor, SUPERVISOR_SOURCE, "utf8");
    await writeFile(candidate, `require("node:fs").writeFileSync(process.env.PI_ECODE_HEALTH_FILE, "healthy"); setTimeout(() => {}, 4000);`, "utf8");
    await writeFile(fallback, "process.exit(99);", "utf8");

    const child = spawn(process.execPath, [supervisor, candidate, fallback, process.execPath, health, result, "123"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    await waitForFile(result);
    const outcome = JSON.parse(await readFile(result, "utf8")) as { status: string };
    expect(outcome.status).toBe("active");
    await closed;
  }, 10_000);

  it("starts the fallback when a candidate exits before health", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-ecode-supervisor-fail-"));
    temporaryPaths.push(root);
    const supervisor = join(root, "supervisor.cjs");
    const candidate = join(root, "candidate.cjs");
    const fallback = join(root, "fallback.cjs");
    const fallbackMarker = join(root, "fallback.txt");
    const health = join(root, "health.json");
    const result = join(root, "result.json");
    await writeFile(supervisor, SUPERVISOR_SOURCE, "utf8");
    await writeFile(candidate, "process.exit(7);", "utf8");
    await writeFile(fallback, `require("node:fs").writeFileSync(${JSON.stringify(fallbackMarker)}, "started");`, "utf8");

    const child = spawn(process.execPath, [supervisor, candidate, fallback, process.execPath, health, result, "123"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    await waitForFile(result);
    await waitForFile(fallbackMarker);
    const outcome = JSON.parse(await readFile(result, "utf8")) as { status: string };
    expect(outcome.status).toBe("failed");
    expect(await readFile(fallbackMarker, "utf8")).toBe("started");
    await closed;
  }, 10_000);
});
