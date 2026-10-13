export const LARGE_SESSION_BYTES = 10 * 1024 * 1024;

export function formatSessionSize(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`;
  if (byteSize < 1024 * 1024) return `${(byteSize / 1024).toFixed(1)} KiB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MiB`;
}
