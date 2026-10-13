/**
 * A `SessionStore` rooted at ONE credential profile's Claude config directory.
 *
 * Interactive queries reach a profile's transcripts through the environment:
 * `claudeProfileEnvironment` sets `CLAUDE_CONFIG_DIR` on the subprocess, so a
 * named profile's sessions live under
 * `DATA_DIR/credential-profiles/<id>/claude/projects/<projectKey>/`. The SDK's
 * session MUTATION helpers (`forkSession`, `deleteSession`) take no env: they
 * run in this process and resolve the local root from OUR environment, which is
 * the default profile's. Their `dir` option only picks the project key WITHIN a
 * root, so it cannot reach another profile's transcripts.
 *
 * Mutating `process.env.CLAUDE_CONFIG_DIR` around each call would be the obvious
 * shortcut and is not safe here: sessions on different profiles run
 * concurrently, so a global flip races every other in-flight call. Instead we
 * hand the SDK an explicit store bound to one profile's root, which is the
 * supported override and stays correct under concurrency.
 *
 * The on-disk layout mirrors the CLI's exactly — `<root>/projects/<projectKey>/
 * <sessionId>.jsonl`, one JSON object per line — because the CLI itself reads
 * and writes these files whenever the session next runs.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  claudeConfigDir,
  DEFAULT_CLAUDE_PROFILE_ID,
} from "../credentialProfiles.ts";

/** The SDK's `SessionKey`, minimally typed (we only key on these fields). */
interface SessionKeyLike {
  projectKey: string;
  sessionId: string;
  /** Set for subagent transcripts; undefined is the main one. */
  subpath?: string;
}

type StoreEntry = Record<string, unknown>;

function transcriptPath(root: string, key: SessionKeyLike): string {
  const base = join(root, "projects", key.projectKey);
  return key.subpath
    ? join(base, key.sessionId, `${key.subpath}.jsonl`)
    : join(base, `${key.sessionId}.jsonl`);
}

function readEntries(path: string): StoreEntry[] | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const out: StoreEntry[] = [];
  // Tolerate a torn final line: the CLI may be mid-append.
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as StoreEntry);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * The store for `profileId`'s transcripts. Only the operations the session
 * mutations actually use are implemented: `load` + `append` (fork) and `delete`.
 * The listing operations stay unimplemented on purpose — PA never lists native
 * sessions, and the SDK treats a missing optional member as "unsupported"
 * rather than as an empty result, which is the honest answer here.
 *
 * ASYMMETRY worth knowing: without `listSubkeys` the SDK materializes only the
 * MAIN transcript, so a fork copies the conversation but not the session's
 * subagent/sidechain transcripts, while `delete` DOES remove the whole subagent
 * directory. Deleting more than we copy is the safe direction — a child never
 * inherits subagent history it cannot resume, and a deleted session leaves
 * nothing behind — but implement `listSubkeys` here if forks ever need it.
 */
export function claudeProfileSessionStore(profileId: string | undefined) {
  const root = claudeConfigDir(profileId ?? DEFAULT_CLAUDE_PROFILE_ID);
  return {
    root,
    async load(key: SessionKeyLike): Promise<StoreEntry[] | null> {
      return readEntries(transcriptPath(root, key));
    },
    async append(key: SessionKeyLike, entries: StoreEntry[]): Promise<void> {
      const path = transcriptPath(root, key);
      mkdirSync(dirname(path), { recursive: true });
      const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
      if (!body) return;
      const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
      const needsNewline = existing.length > 0 && !existing.endsWith("\n");
      writeFileSync(path, `${needsNewline ? "\n" : ""}${body}\n`, {
        flag: existing ? "a" : "w",
      });
    },
    async delete(key: SessionKeyLike): Promise<void> {
      // The main transcript AND the session's subagent directory, matching what
      // the SDK's own local deletion removes.
      rmSync(transcriptPath(root, key), { force: true });
      rmSync(join(root, "projects", key.projectKey, key.sessionId), {
        recursive: true,
        force: true,
      });
    },
  };
}

/**
 * The last `cost-state` entry `providerSessionId`'s transcript saved, if any.
 * A resumed or forked CLI continues its running totals from it, so the first
 * `result` of that query already carries what the entry holds. The entry is
 * the CLI's own record and its shape is not part of the SDK's types; callers
 * treat it as a hint to verify, never as billing truth. The project key is
 * found by looking, not by re-deriving the CLI's path sanitizing.
 */
export async function lastSavedCostState(
  profileId: string | undefined,
  providerSessionId: string,
): Promise<StoreEntry | undefined> {
  const projects = join(
    claudeConfigDir(profileId ?? DEFAULT_CLAUDE_PROFILE_ID),
    "projects",
  );
  let keys: string[];
  try {
    keys = await readdir(projects);
  } catch {
    return undefined;
  }
  const name = `${providerSessionId}.jsonl`;
  for (const projectKey of keys) {
    const path = join(projects, projectKey, name);
    let lines: AsyncIterable<string>;
    try {
      lines = createInterface({
        input: (await open(path)).createReadStream({ encoding: "utf8" }),
        crlfDelay: Infinity,
      });
    } catch {
      continue;
    }
    let last: StoreEntry | undefined;
    for await (const line of lines) {
      if (!line.includes('"cost-state"')) continue;
      try {
        const entry = JSON.parse(line) as StoreEntry;
        if (entry.type === "cost-state") last = entry;
      } catch {
        continue;
      }
    }
    return last;
  }
  return undefined;
}
