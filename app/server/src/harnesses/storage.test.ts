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
  assert.equal(
    sessionRefFile({ harness: "pi", sessionId: "pi-1" }),
    canonicalPiSessionPath("pi-1"),
  );
  assert.equal(
    sessionRefFile({ harness: "claude-sdk", sessionId: "claude-1" }),
    "claude-1",
  );
});

test("a pi binding names its transcript by native id; another native id is refused for now", () => {
  assert.equal(
    sessionRefFile({
      harness: "pi",
      sessionId: "pi-2",
      nativeSessionId: "pi-2",
    }),
    canonicalPiSessionPath("pi-2"),
  );
  assert.throws(
    () =>
      sessionRefFile({
        harness: "pi",
        sessionId: "pi-3",
        nativeSessionId: "pi-native",
      }),
    /its own native id/,
  );
});

test("only a pi transcript on disk is named as the engine's own", () => {
  assert.equal(
    engineTranscript({ harness: "pi", sessionId: "pi-absent" }),
    undefined,
  );
  onDisk(canonicalPiSessionPath("pi-present"));
  assert.equal(
    engineTranscript({ harness: "pi", sessionId: "pi-present" }),
    canonicalPiSessionPath("pi-present"),
  );
  onDisk(join(process.env.DATA_DIR!, "claude-sdk", "claude-present.json"));
  assert.equal(
    engineTranscript({ harness: "claude-sdk", sessionId: "claude-present" }),
    undefined,
  );
});

test("a session is reopenable from what its engine stored, else says what is missing", () => {
  onDisk(canonicalPiSessionPath("pi-stored"));
  onDisk(join(process.env.DATA_DIR!, "claude-sdk", "claude-stored.json"));
  assert.deepEqual(
    storedSessionState({ harness: "pi", sessionId: "pi-stored" }),
    { stored: true },
  );
  assert.deepEqual(
    storedSessionState({ harness: "claude-sdk", sessionId: "claude-stored" }),
    {
      stored: true,
    },
  );
  assert.deepEqual(
    storedSessionState({ harness: "pi", sessionId: "pi-missing" }),
    {
      stored: false,
      reason: "no pi transcript on disk",
    },
  );
  assert.deepEqual(
    storedSessionState({ harness: "claude-sdk", sessionId: "claude-missing" }),
    {
      stored: false,
      reason: "no Claude SDK state on disk",
    },
  );
});
