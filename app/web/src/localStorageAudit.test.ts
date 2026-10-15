import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * `localStorage` audit.
 *
 * WebKit (macOS/iOS 26, so the Tauri shell and Safari) keeps `localStorage` in
 * SQLite in WAL mode, and overwriting a value over 1 KB leaves a read statement
 * open that blocks every checkpoint: the WAL then grows by every byte written
 * until the networking process exits (41 GB in one week of the shell). So
 * browser-local state goes through `lib/persistentStore.ts` (IndexedDB), and
 * `localStorage` is reached only through `lib/localStore.ts`, whose values stay
 * under 512 chars.
 *
 * `lib/pendingCommentStore.ts` is the one other user: it depends on the
 * cross-tab `storage` event and the Web Locks it pairs with, and its records
 * are written once per comment rather than continuously.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);
const ALLOWED = new Set(["lib/localStore.ts", "lib/pendingCommentStore.ts"]);

const PATTERN =
  /\b(?:window|globalThis|self)\s*\.\s*localStorage\b|(?<![.\w$])localStorage\s*\.\s*(?:getItem|setItem|removeItem|key|clear|length)\b/g;

function hits(source: string): string[] {
  return source.match(new RegExp(PATTERN.source, "g")) ?? [];
}

function shouldScan(path: string): boolean {
  if (path.endsWith(".d.ts")) return false;
  // Tests seed and inspect storage directly on purpose.
  if (/\.test\.[tj]sx?$/.test(path)) return false;
  if (ALLOWED.has(relative(HERE, path))) return false;
  const dot = path.lastIndexOf(".");
  return dot >= 0 && SCAN_EXTENSIONS.has(path.slice(dot));
}

function collectFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(HERE, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    if (shouldScan(full)) files.push(full);
  }
  return files.sort();
}

describe("localStorage audit", () => {
  test("only the storage gateways touch localStorage", () => {
    const offenders: string[] = [];
    for (const file of collectFiles())
      for (const hit of hits(readFileSync(file, "utf8")))
        offenders.push(`${relative(HERE, file)}: ${hit.replace(/\s+/g, " ")}`);
    expect(
      offenders,
      `Use persistentStore() for browser-local state, or localStore for a tiny value that must stay in localStorage:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("catches every spelling it claims to", () => {
    for (const sample of [
      'window.localStorage.getItem("k");',
      "const storage = window.localStorage;",
      'localStorage.setItem("k", v);',
      "globalThis\n  .localStorage",
      "for (let i = 0; i < localStorage.length; i += 1) {}",
    ])
      expect(hits(sample).length, `missed: ${sample}`).toBeGreaterThan(0);
    for (const clean of [
      'localStore.getItem("k");',
      "persistentStore().setItem(key, value);",
      "// kept in `localStorage` for the pre-paint script",
    ])
      expect(hits(clean), `false positive: ${clean}`).toEqual([]);
  });
});
