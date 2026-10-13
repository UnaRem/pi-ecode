import { open } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectProfile } from "../../shared/contracts.js";

const MAX_PROJECT_TEXT_BYTES = 16 * 1024;
const TECHNOLOGIES = ["electron", "react", "next", "vue", "typescript", "vite", "vitest"];
const FEATURE_RULES = [
  ["sessions", /\bsessions?\b|会话/iu],
  ["mcp", /\bmcp\b/iu],
  ["history", /\b(?:undo|redo|checkpoints?)\b|撤销|检查点/iu],
] as const;

async function projectText(cwd: string, name: string): Promise<string> {
  // Optional documents must not block opening a project; bound reads before decoding large files.
  const handle = await open(join(cwd, name), "r").catch(() => null);
  if (!handle) return "";
  try {
    const buffer = Buffer.alloc(MAX_PROJECT_TEXT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch { return ""; }
  finally { await handle.close(); }
}

function packageManifest(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

export async function readProjectProfile(cwd: string): Promise<ProjectProfile> {
  const [readme, instructions, packageText] = await Promise.all(
    ["README.md", "AGENTS.md", "package.json"].map((name) => projectText(cwd, name)),
  );
  const manifest = packageManifest(packageText ?? "");
  const dependencyNames = new Set([manifest.dependencies, manifest.devDependencies].flatMap((group) =>
    group && typeof group === "object" && !Array.isArray(group) ? Object.keys(group) : []));
  const scripts = manifest.scripts;
  const hasTests = Boolean(scripts && typeof scripts === "object" && "test" in scripts && typeof scripts.test === "string");
  const description = typeof manifest.description === "string" ? manifest.description.slice(0, 240) : null;
  const descriptionText = [readme, instructions, description].join("\n");
  return {
    description,
    technologies: TECHNOLOGIES.filter((name) => dependencyNames.has(name)),
    features: FEATURE_RULES.filter(([, pattern]) => pattern.test(descriptionText)).map(([feature]) => feature),
    hasTests,
  };
}
