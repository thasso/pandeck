import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { CACHE_TTL_MS, DayScanCache } from "./cache.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "day-scan-cache-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("writes are owner-only JSON files under the day folder", () => {
  const cache = new DayScanCache(root);
  const file = cache.writeJson("2026-07-13", "jira-raw", { hello: 1 });
  assert.ok(existsSync(file));
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, "2026-07-13")).mode & 0o777, 0o700);
  }
});

test("cleanup removes day folders past the TTL and keeps fresh ones", () => {
  const cache = new DayScanCache(root);
  cache.writeJson("2026-07-01", "old", {});
  cache.writeJson("2026-07-13", "fresh", {});
  const oldDir = join(root, "2026-07-01");
  const past = (Date.now() - CACHE_TTL_MS - 1000) / 1000;
  utimesSync(oldDir, past, past);
  cache.cleanup();
  assert.equal(existsSync(oldDir), false, "expired day evicted");
  assert.equal(existsSync(join(root, "2026-07-13")), true, "fresh day kept");
});

test("the per-day cap evicts oldest files first", () => {
  const cache = new DayScanCache(root);
  const dir = join(root, "2026-07-13");
  mkdirSync(dir, { recursive: true });
  // Two big pre-existing files, oldest first.
  const big = "x".repeat(70 * 1024 * 1024);
  writeFileSync(join(dir, "a.json"), big);
  utimesSync(join(dir, "a.json"), 1000, 1000);
  writeFileSync(join(dir, "b.json"), big);
  utimesSync(join(dir, "b.json"), 2000, 2000);
  // The write pushes the folder over 128 MB → "a.json" (oldest) is evicted.
  cache.writeJson("2026-07-13", "c", { fresh: true });
  const remaining = readdirSync(dir).sort();
  assert.equal(remaining.includes("a.json"), false, "oldest file evicted");
  assert.equal(remaining.includes("b.json"), true);
  assert.equal(remaining.includes("c.json"), true);
});
