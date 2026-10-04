/**
 * A Claude record that cannot even be stat'ed is not reopenable: the inspection
 * answer keeps plain existence, whatever stops the stat. Its own file, because
 * the store directory has to be a regular file for the whole module.
 *   pnpm --filter @assistant/server test src/harnesses/storageStatError.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "harness-storage-stat-error-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(process.env.DATA_DIR, { recursive: true });
// Every stat under it fails with ENOTDIR rather than ENOENT.
writeFileSync(join(process.env.DATA_DIR, "claude-sdk"), "");

const { storedSessionState } = await import("./storage.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("a record path that cannot be stat'ed is reported missing", () => {
  assert.deepEqual(storedSessionState("claude-sdk", "claude-unstattable"), {
    stored: false,
    reason: "no Claude SDK state on disk",
  });
});
