import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";

/** Cache retention rules (plan § Privacy & retention): concrete, enforced. */
export const CACHE_TTL_MS = 14 * 24 * 3600 * 1000;
const CACHE_GLOBAL_CAP_BYTES = 1024 * 1024 * 1024; // 1 GB
const CACHE_PER_DAY_CAP_BYTES = 128 * 1024 * 1024; // 128 MB

/**
 * Non-Git short-lived cache for raw day-scan payloads (raw API responses,
 * fetched minutes text). Never committed to the KB; owner-only permissions;
 * TTL + size-cap cleanup on boot and on write.
 */
export class DayScanCache {
  constructor(readonly root: string = join(DATA_DIR, "day-scan-cache")) {}

  private dayDir(date: string): string {
    return join(this.root, date);
  }

  /** Write one JSON payload for a day+source; enforces per-day cap afterwards. */
  writeJson(date: string, name: string, payload: unknown): string {
    const dir = this.dayDir(date);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort on non-posix */
    }
    this.enforceDayCap(date);
    return file;
  }

  private dirSize(dir: string): number {
    let total = 0;
    for (const name of safeReaddir(dir)) {
      const p = join(dir, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      total += st.isDirectory() ? this.dirSize(p) : st.size;
    }
    return total;
  }

  private enforceDayCap(date: string): void {
    const dir = this.dayDir(date);
    if (this.dirSize(dir) <= CACHE_PER_DAY_CAP_BYTES) return;
    evictOldestFiles(dir, this.dirSize(dir) - CACHE_PER_DAY_CAP_BYTES);
  }

  /**
   * TTL enforcement first (whole day folders past TTL are removed), then the
   * global size cap with oldest-first eviction of day folders.
   */
  cleanup(now = Date.now()): void {
    if (!existsSync(this.root)) return;
    const days = safeReaddir(this.root)
      .map((name) => ({
        name,
        path: join(this.root, name),
        mtime:
          statSync(join(this.root, name), { throwIfNoEntry: false })?.mtimeMs ??
          0,
      }))
      .filter((d) => d.mtime > 0);
    for (const day of days) {
      if (now - day.mtime > CACHE_TTL_MS)
        rmSync(day.path, { recursive: true, force: true });
    }
    const remaining = safeReaddir(this.root)
      .map((name) => ({
        path: join(this.root, name),
        mtime:
          statSync(join(this.root, name), { throwIfNoEntry: false })?.mtimeMs ??
          0,
      }))
      .filter((d) => d.mtime > 0)
      .sort((a, b) => a.mtime - b.mtime);
    let total = remaining.reduce((sum, d) => sum + this.dirSize(d.path), 0);
    for (const day of remaining) {
      if (total <= CACHE_GLOBAL_CAP_BYTES) break;
      total -= this.dirSize(day.path);
      rmSync(day.path, { recursive: true, force: true });
    }
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Delete the oldest files in a directory tree until `bytesToFree` is freed. */
function evictOldestFiles(dir: string, bytesToFree: number): void {
  const files: Array<{ path: string; mtime: number; size: number }> = [];
  const walk = (d: string) => {
    for (const name of safeReaddir(d)) {
      const p = join(d, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else files.push({ path: p, mtime: st.mtimeMs, size: st.size });
    }
  };
  walk(dir);
  files.sort((a, b) => a.mtime - b.mtime);
  let freed = 0;
  for (const file of files) {
    if (freed >= bytesToFree) break;
    rmSync(file.path, { force: true });
    freed += file.size;
  }
}
