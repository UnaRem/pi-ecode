import { spawn } from "node:child_process";
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rcedit } from "rcedit";

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronModuleRoot = dirname(require.resolve("electron"));
const electronViteRoot = dirname(require.resolve("electron-vite/package.json"));
const electronViteCli = join(electronViteRoot, "bin", "electron-vite.js");
const commandArguments = process.argv.slice(2);

// Keep the executable named electron.exe so Electron still identifies this as an unpackaged runtime.
// Hard-link its immutable sibling files to avoid duplicating the full Electron distribution.
async function linkRuntimeFiles(sourceDirectory, targetDirectory, skippedName) {
  await mkdir(targetDirectory, { recursive: true });
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    if (entry.name === skippedName) continue;
    const sourcePath = join(sourceDirectory, entry.name);
    const targetPath = join(targetDirectory, entry.name);
    if (entry.isDirectory()) await linkRuntimeFiles(sourcePath, targetPath);
    else await link(sourcePath, targetPath);
  }
}

async function runtimeFingerprint(sourcePath, iconPath) {
  const [electronManifest, sourceInfo, iconInfo] = await Promise.all([
    readFile(join(electronModuleRoot, "package.json"), "utf8"),
    stat(sourcePath),
    stat(iconPath),
  ]);
  const electronVersion = JSON.parse(electronManifest).version;
  return JSON.stringify({
    electronVersion,
    sourceSize: sourceInfo.size,
    iconSize: iconInfo.size,
    iconModifiedAt: iconInfo.mtimeMs,
  });
}

async function prepareWindowsRuntime() {
  const executableName = (await readFile(join(electronModuleRoot, "path.txt"), "utf8")).trim();
  const sourceDirectory = join(electronModuleRoot, "dist");
  const sourcePath = join(sourceDirectory, executableName);
  const iconPath = join(projectRoot, "resources", "ecode-icon.ico");
  const runtimeDirectory = join(electronModuleRoot, "pi-ecode-runtime");
  const targetPath = join(runtimeDirectory, executableName);
  const markerPath = join(runtimeDirectory, ".pi-ecode-runtime");
  const fingerprint = await runtimeFingerprint(sourcePath, iconPath);

  try {
    if ((await readFile(markerPath, "utf8")) === fingerprint) return targetPath;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  const temporaryDirectory = `${runtimeDirectory}.${process.pid}.tmp`;
  try {
    await rm(temporaryDirectory, { recursive: true, force: true });
    await linkRuntimeFiles(sourceDirectory, temporaryDirectory, executableName);
    await copyFile(sourcePath, join(temporaryDirectory, executableName));
    await rcedit(join(temporaryDirectory, executableName), { icon: iconPath });
    await writeFile(join(temporaryDirectory, ".pi-ecode-runtime"), fingerprint, "utf8");
    await rm(runtimeDirectory, { recursive: true, force: true });
    await rename(temporaryDirectory, runtimeDirectory);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return targetPath;
}

const electronExecPath = process.platform === "win32" ? await prepareWindowsRuntime() : undefined;
if (commandArguments[0] === "prepare-runtime") {
  if (electronExecPath) console.log(electronExecPath);
} else {
  const child = spawn(process.execPath, [electronViteCli, ...commandArguments], {
    cwd: projectRoot,
    env: { ...process.env, ...(electronExecPath ? { ELECTRON_EXEC_PATH: electronExecPath } : {}) },
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
