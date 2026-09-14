import { SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";

export const SOL_PI_PACKAGE_SOURCE = "git:github.com/NVlabs/SoL-Pi@d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0";

function sourceOf(value: PackageSource): string {
  return typeof value === "string" ? value : value.source;
}

function isSolPiPackage(value: PackageSource): boolean {
  const source = sourceOf(value).trim().toLowerCase().replace(/^git:/u, "");
  return /^(?:(?:https?|ssh|git):\/\/(?:git@)?|git@)?github\.com[/:]nvlabs\/sol-pi(?:\.git)?(?:@|$)/u.test(source);
}

export async function ensureSolPiPackage(cwd: string, agentDir: string): Promise<void> {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loadErrors = settingsManager.drainErrors();
  if (loadErrors.length > 0) throw loadErrors[0]!.error;
  const packages = settingsManager.getGlobalSettings().packages ?? [];
  if (packages.some(isSolPiPackage)) return;
  settingsManager.setPackages([...packages, SOL_PI_PACKAGE_SOURCE]);
  await settingsManager.flush();
  const writeErrors = settingsManager.drainErrors();
  if (writeErrors.length > 0) throw writeErrors[0]!.error;
}
