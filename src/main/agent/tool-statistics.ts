import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolCapability, ToolStatistic } from "../../shared/tool-statistics.js";

type Outcome = "successes" | "failures" | "cancelled" | "blocked";
interface StoredStatistic extends Omit<ToolStatistic, "medianMs" | "p95Ms" | "adjustment"> { durations: number[] }
const stores = new Map<string, ToolStatisticsStore>();
const CAPABILITIES: ToolCapability[] = ["file-read", "file-search", "file-edit", "web-search", "browser", "git", "shell", "other"];

export function toolStatisticsStore(path: string): ToolStatisticsStore {
  let store = stores.get(path);
  if (!store) { store = new ToolStatisticsStore(path); stores.set(path, store); }
  return store;
}

function validRecord(record: unknown): record is StoredStatistic {
  if (!record || typeof record !== "object") return false;
  const candidate = record as Record<string, unknown>;
  return typeof candidate.name === "string" && typeof candidate.nested === "boolean"
    && CAPABILITIES.includes(candidate.capability as ToolCapability)
    && [candidate.successes, candidate.failures, candidate.cancelled, candidate.blocked].every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
    && Array.isArray(candidate.durations) && candidate.durations.length <= 128
    && candidate.durations.every((duration: unknown) => typeof duration === "number" && Number.isFinite(duration) && duration >= 0);
}

export class ToolStatisticsStore {
  private readonly records = new Map<string, StoredStatistic>();
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private writing = false;
  private revision = 0;

  constructor(private readonly path: string) {}

  initialize(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid tool statistics file.");
    const document = parsed as { version?: unknown; records?: unknown };
    if (document.version !== 1 || !Array.isArray(document.records) || !document.records.every(validRecord)) throw new Error("Invalid tool statistics file.");
    for (const record of document.records) this.records.set(this.key(record.name, record.nested), record);
  }

  get current(): ToolStatistic[] {
    return [...this.records.values()].map(({ durations, ...record }) => {
      const sorted = durations.toSorted((left, right) => left - right);
      const completed = record.successes + record.failures;
      return { ...record, medianMs: sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2 : null,
        p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1]! : null,
        adjustment: completed < 5 ? "collect" as const : record.failures / completed >= .2 ? "inspect-input" as const : "compare-latency" as const };
    }).sort((left, right) => left.name.localeCompare(right.name) || Number(left.nested) - Number(right.nested));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(input: { name: string; capability: ToolCapability; nested: boolean; outcome: Outcome; durationMs?: number }): Promise<void> {
    const key = this.key(input.name, input.nested);
    const record = this.records.get(key) ?? { name: input.name, capability: input.capability, nested: input.nested,
      successes: 0, failures: 0, cancelled: 0, blocked: 0, durations: [] };
    record[input.outcome]++;
    record.capability = input.capability;
    if (input.durationMs !== undefined && (input.outcome === "successes" || input.outcome === "failures")) record.durations = [...record.durations, input.durationMs].slice(-128);
    this.records.set(key, record);
    this.revision++;
    for (const listener of this.listeners) listener();
    // Share one writer across sessions and coalesce results arriving during the same write.
    if (!this.writing) {
      this.writing = true;
      this.saving = this.save().finally(() => { this.writing = false; });
    }
    return this.saving;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    let revision: number;
    do {
      revision = this.revision;
      await writeFile(`${this.path}.tmp`, JSON.stringify({ version: 1, records: [...this.records.values()] }), "utf8");
      await rename(`${this.path}.tmp`, this.path);
    } while (revision !== this.revision);
  }

  flush(): Promise<void> { return this.saving; }
  private key(name: string, nested: boolean): string { return JSON.stringify([name, nested]); }
}
