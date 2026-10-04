/**
 * Plumbing smoke test for the Phase-2 `claude-sdk` wiring.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/claudeSdk/claudeSdkPlumbing.test.ts
 *
 * It exercises ONLY the plumbing that does NOT require a real Claude turn — it
 * never calls `prompt()` (that path is covered by ClaudeSdkSession.test.ts via a
 * fake seam). It asserts:
 *   1. `claudeSdkStore.acquire` returns a session that exposes an empty snapshot()
 *      and a state() with kind "claude-sdk", and the SAME id is idempotent.
 *   2. The empty runtime does not show in `hub.listSessions()` until prompted.
 *   3. `hub.removeClaudeSdk` tombstones the id: it disappears from listSessions
 *      and a later acquire does NOT resurrect the old record.
 *
 * The session is created with a model/thinking level to confirm those flow
 * through to state(). No SDK seam is built because no turn runs.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { claudeSdkStore } from "./claudeSdkStore.ts";
import { removeClaudeSdkRecord } from "./claudeSdkRecords.ts";
import { hub } from "../hub.ts";

const ID = `plumbing-test-${Date.now()}`;
const ORPHAN_ID = `plumbing-orphan-${Date.now()}`;

function cleanup(): void {
  for (const id of [ID, ORPHAN_ID]) {
    try {
      removeClaudeSdkRecord(join(DATA_DIR, "claude-sdk"), id);
    } catch {
      // ignore
    }
  }
}

async function main(): Promise<void> {
  cleanup();

  // 1 + 2. Create through the store and inspect it.
  const session = claudeSdkStore.acquire(ID, {
    modelId: "opus",
    thinkingLevel: "high",
  });
  assert.equal(session.harness, "claude-sdk", "harness is claude-sdk");
  assert.equal(session.kind, "workshop", "kind is the workshop persona");
  assert.equal(session.sessionId, ID, "sessionId matches the requested id");
  assert.deepEqual(session.snapshot(), [], "fresh session snapshot is empty");

  const state = session.state();
  assert.equal(state.harness, "claude-sdk", "state.harness is claude-sdk");
  assert.equal(state.agentType, "workshop", "state.agentType is workshop");
  assert.equal(state.sessionId, ID, "state.sessionId matches");
  assert.equal(
    "isStreaming" in state,
    false,
    "SessionState shell omits run-state",
  );
  assert.equal(
    state.model?.id,
    "opus",
    "selected model alias flows into state",
  );
  assert.equal(
    state.thinkingLevel,
    "high",
    "selected thinking level flows into state",
  );

  // Idempotent: acquiring the same id returns the same instance.
  assert.equal(
    claudeSdkStore.acquire(ID),
    session,
    "acquire is idempotent for a live id",
  );

  // 2. Acquiring the runtime alone is not a conversation. Prompt acceptance is
  // covered in ClaudeSdkSession.test.ts; until then the merged list hides it.
  const sessions = await hub.listSessions();
  const listed = sessions.find(
    (s) => s.harness === "claude-sdk" && s.id === ID,
  );
  assert.equal(
    listed,
    undefined,
    "empty runtime is absent from the merged list",
  );

  // Orphaned persisted records from before registry-backed routing (or after a
  // lost best-effort registry write) must still be loadable/deletable by id.
  const orphanDir = join(DATA_DIR, "claude-sdk");
  mkdirSync(orphanDir, { recursive: true });
  const orphanRecord = {
    id: ORPHAN_ID,
    title: "Orphan SDK",
    providerSessionId: "provider-orphan",
    entries: [
      {
        id: "m1",
        seq: 0,
        createdAt: new Date().toISOString(),
        type: "message",
        role: "user",
        origin: { kind: "human" },
        content: [{ type: "text", text: "hello" }],
      },
    ],
    modelId: "haiku",
    thinkingLevel: "low",
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
  };
  writeFileSync(
    join(orphanDir, `${ORPHAN_ID}.json`),
    `${JSON.stringify(orphanRecord, null, 2)}\n`,
    "utf8",
  );
  assert.equal(
    claudeSdkStore.exists(ORPHAN_ID),
    true,
    "persisted orphan SDK record is discoverable",
  );
  const orphan = await hub.acquireById(ORPHAN_ID);
  assert.ok(
    orphan,
    "hub.acquireById can acquire an orphan persisted SDK record",
  );
  assert.equal(
    orphan.harness,
    "claude-sdk",
    "orphan resolves to the claude-sdk harness",
  );
  assert.equal(orphan.snapshot().length, 1, "orphan history is loaded");
  hub.removeClaudeSdk(ORPHAN_ID);
  assert.equal(
    claudeSdkStore.exists(ORPHAN_ID),
    false,
    "orphan removal tombstones and deletes the record",
  );

  // 3. Remove → tombstone. It must disappear and stay gone.
  hub.removeClaudeSdk(ID);
  assert.equal(
    claudeSdkStore.get(ID),
    undefined,
    "live session is dropped after remove",
  );
  const afterSessions = await hub.listSessions();
  assert.ok(
    !afterSessions.find((s) => s.harness === "claude-sdk" && s.id === ID),
    "removed session is gone from hub.listSessions()",
  );

  // A re-acquire of the tombstoned id starts CLEAN (the old record is not resurrected).
  const reacquired = claudeSdkStore.acquire(ID);
  assert.deepEqual(
    reacquired.snapshot(),
    [],
    "re-acquired tombstoned id has no resurrected history",
  );
  // Note: the tombstone forbids reading the old record; the fresh session is
  // tracked again, so clean up after ourselves.
  hub.removeClaudeSdk(ID);
  cleanup();

  console.log("claude-sdk plumbing test: PASS");
}

test("wires Claude SDK hub/store plumbing", async () => {
  try {
    await main();
  } finally {
    cleanup();
  }
});
