/**
 * Where each engine keeps a session on disk, answered from paths alone.
 *   pnpm --filter @assistant/server test src/harnesses/storage.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "harness-storage-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { engineTranscript, sessionRefFile, storedSessionState } =
  await import("./storage.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function onDisk(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
}

test("a pi session carries its transcript; a Claude session its id", () => {
  assert.equal(sessionRefFile("pi", "pi-1"), canonicalPiSessionPath("pi-1"));
  assert.equal(sessionRefFile("claude-sdk", "claude-1"), "claude-1");
});

test("only a pi transcript on disk is named as the engine's own", () => {
  assert.equal(engineTranscript("pi", "pi-absent"), undefined);
  onDisk(canonicalPiSessionPath("pi-present"));
  assert.equal(
    engineTranscript("pi", "pi-present"),
    canonicalPiSessionPath("pi-present"),
  );
  onDisk(join(process.env.DATA_DIR!, "claude-sdk", "claude-present.json"));
  assert.equal(engineTranscript("claude-sdk", "claude-present"), undefined);
});

test("a session is reopenable from what its engine stored, else says what is missing", () => {
  onDisk(canonicalPiSessionPath("pi-stored"));
  onDisk(join(process.env.DATA_DIR!, "claude-sdk", "claude-stored.json"));
  assert.deepEqual(storedSessionState("pi", "pi-stored"), { stored: true });
  assert.deepEqual(storedSessionState("claude-sdk", "claude-stored"), {
    stored: true,
  });
  assert.deepEqual(storedSessionState("pi", "pi-missing"), {
    stored: false,
    reason: "no pi transcript on disk",
  });
  assert.deepEqual(storedSessionState("claude-sdk", "claude-missing"), {
    stored: false,
    reason: "no Claude SDK state on disk",
  });
});
