import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { cleanupSubagentHistory } from "../src/main/history/subagent-history-cleanup.ts";

if (!process.env.APPDATA) throw new Error("APPDATA is required to locate pi-ecode's owned catalog directory.");
const excludedSessionFiles = process.argv.slice(2).map((argument) => {
  const prefix = "--exclude-session=";
  if (!argument.startsWith(prefix) || !isAbsolute(argument.slice(prefix.length))) {
    throw new Error("Use --exclude-session=<absolute-path> for every session still open in a running runtime.");
  }
  return argument.slice(prefix.length);
});
const result = await cleanupSubagentHistory({
  agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  catalogDirectory: join(process.env.APPDATA, "pi-ecode", "agents"),
  excludedSessionFiles,
});
console.log(JSON.stringify(result, null, 2));
if (result.failures.length) process.exitCode = 1;
