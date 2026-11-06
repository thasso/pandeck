/**
 * The Claude CLI's OAuth refresh locks, taken the way CLI 2.1.316 takes them
 * (`docs/workers.md` "Renewal"), so the gateway and a CLI on the same config
 * directory ("One refresher") never refresh one login at once.
 *
 * Both are `mkdir` directories: first `<configDir>/.oauth_refresh.lock`, then
 * the legacy `${realpath(configDir)}.lock` beside the directory. A held legacy
 * lock releases the primary and the attempt fails. A lock whose mtime is more
 * than 60 s old is stale and taken over. One attempt and five retries, 1–2 s
 * apart, then `lock_busy`. While held, both mtimes advance every 5 s. Release
 * removes the legacy lock, then the primary. Nothing here creates the config
 * directory: a deleted profile stays deleted.
 */
import {
  mkdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  utimesSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const PRIMARY_LOCK = ".oauth_refresh.lock";
const STALE_MS = 60_000;
const HEARTBEAT_MS = 5_000;
const RETRIES = 5;

export interface RefreshLockOptions {
  /** Epoch milliseconds, compared with lock mtimes. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** In [0, 1): the retry sleep is 1 s plus this share of 1 s. */
  random?: () => number;
}

export type LockedResult<T> =
  | { ok: true; value: T }
  /**
   * `lock_busy` after the retries, `gone` when the config dir is missing, else
   * the errno code that stopped it.
   */
  | { ok: false; code: string };

function errnoOf(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Takes one lock directory: "taken", "busy", or throws on another error.
 * A stale one is removed and taken once more.
 */
function takeLock(path: string, now: () => number): "taken" | "busy" {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path);
      return "taken";
    } catch (err) {
      if (errnoOf(err) !== "EEXIST") throw err;
    }
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch (err) {
      if (errnoOf(err) === "ENOENT") continue;
      throw err;
    }
    if (mtimeMs >= now() - STALE_MS) return "busy";
    try {
      rmdirSync(path);
    } catch (err) {
      if (errnoOf(err) !== "ENOENT") throw err;
    }
  }
  return "busy";
}

function removeLock(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // ENOENT: a removed profile dir or a lock already taken over.
  }
}

/**
 * Runs `work` holding both of `configDir`'s refresh locks. A missing config
 * directory answers `gone`, contention past the retries `lock_busy`; a thrown
 * error of `work` propagates after release.
 */
export async function withClaudeRefreshLock<T>(
  configDir: string,
  work: () => Promise<T>,
  options: RefreshLockOptions = {},
): Promise<LockedResult<T>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const random = options.random ?? Math.random;
  const primary = `${configDir}/${PRIMARY_LOCK}`;
  let legacy: string | undefined;
  for (let attempt = 0; ; attempt++) {
    let primaryTaken = false;
    try {
      if (takeLock(primary, now) === "taken") {
        primaryTaken = true;
        legacy ??= `${realpathSync(configDir)}.lock`;
        if (takeLock(legacy, now) === "taken") break;
        removeLock(primary);
      }
    } catch (err) {
      if (primaryTaken) removeLock(primary);
      const code = errnoOf(err);
      return {
        ok: false,
        code: code === "ENOENT" ? "gone" : (code ?? "lock_error"),
      };
    }
    if (attempt >= RETRIES) return { ok: false, code: "lock_busy" };
    await sleep(1000 + Math.floor(random() * 1000));
  }
  const held = [legacy!, primary];
  const heartbeat = setInterval(() => {
    const at = new Date(now());
    for (const path of held)
      try {
        utimesSync(path, at, at);
      } catch {
        // A removed profile dir: release ignores it too.
      }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return { ok: true, value: await work() };
  } finally {
    clearInterval(heartbeat);
    for (const path of held) removeLock(path);
  }
}
