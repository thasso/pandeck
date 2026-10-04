/**
 * Deleting a session is one flow whichever engine holds it: the engine
 * disposes it and deletes what it stored, and every harness-neutral cleanup
 * runs for both.
 *   pnpm --filter @assistant/server test src/sessionDeleteHarness.test.ts
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "session-delete-harness-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { Connection } = await import("./connection.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { canonicalPiSessionPath } = await import("./sessionStorage.ts");
const questions = await import("./tools/core/questionTool.ts");
const promptQueue = await import("./promptQueue.ts");
const toolGroups = await import("./mcp/toolGroups/registry.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

function connection() {
  return new (
    Connection as unknown as new (ws: unknown) => {
      onDeleteSession(id: string): Promise<void>;
    }
  )({ OPEN: 1, readyState: 1, send: () => {} });
}

/** The harness-neutral cleanups a delete runs, as they were called. */
function cleanups() {
  return [
    vi.spyOn(questions, "clearPendingQuestion"),
    vi.spyOn(promptQueue, "deleteSessionPromptQueue"),
    vi.spyOn(toolGroups, "deleteToolGroupSessionData"),
  ];
}

test("a Claude session's delete runs the same cleanup a pi session's does", async () => {
  const id = "delete-claude-session";
  sessionStore.upsert({ id, harness: "claude-sdk", agentType: "assistant" });
  const remove = vi.spyOn(claudeSdkStore, "remove");
  const ran = cleanups();

  await connection().onDeleteSession(id);

  assert.deepEqual(remove.mock.calls, [[id]]);
  for (const cleanup of ran) assert.deepEqual(cleanup.mock.calls, [[id]]);
});

test("a pi session's delete evicts it and removes its transcript", async () => {
  const id = "delete-pi-session";
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  const file = canonicalPiSessionPath(id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
  const evict = vi.spyOn(piStore, "evict");
  const ran = cleanups();

  await connection().onDeleteSession(id);

  assert.deepEqual(evict.mock.calls, [[id]]);
  assert.equal(existsSync(file), false);
  for (const cleanup of ran) assert.deepEqual(cleanup.mock.calls, [[id]]);
});
