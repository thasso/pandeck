import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.ts";

const CACHE_DIR = join(DATA_DIR, "cache", "jira");

export function jiraCachePath(jiraHost: string, name: string): string {
  return join(CACHE_DIR, `${name}-${safeHost(jiraHost)}.json`);
}

function safeHost(jiraHost: string): string {
  return (
    jiraHost
      .replace(/^https?:\/\//, "")
      .replace(/[^a-zA-Z0-9.-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "jira"
  );
}

export function readJsonCacheFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonCacheFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, path);
}
