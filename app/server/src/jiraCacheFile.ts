import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { createPrivateJsonFile } from "./privateJsonFile.ts";

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
  createPrivateJsonFile(path, "Jira cache").write(value);
}
