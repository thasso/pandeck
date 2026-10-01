/**
 * The live scope gate must fail CLOSED (Task-492): when the store cannot answer
 * "is this id the user's?", the live sources show nothing rather than
 * everything. Its own test file because it mocks the database handle.
 *   pnpm --filter @assistant/server test src/db/sessionScopeGateFailure.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const state = vi.hoisted(() => ({ broken: false }));

vi.mock("./index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./index.ts")>();
  return {
    ...actual,
    getDb: () => {
      if (state.broken) throw new Error("database is unavailable");
      return actual.getDb();
    },
  };
});

const { sessionStore } = await import("./sessionStore.ts");

afterEach(() => {
  state.broken = false;
});

test("a store read failure excludes every live candidate instead of admitting them", () => {
  const id = `gate-failure-${Date.now()}`;
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  assert.equal(sessionStore.liveDefaultScopeGate([id])(id), true);

  state.broken = true;
  const gate = sessionStore.liveDefaultScopeGate([id, "another-live-id"]);
  assert.equal(gate(id), false);
  assert.equal(gate("another-live-id"), false);
  assert.equal(
    gate("an-id-nobody-asked-about"),
    false,
    "a broken gate answers no to everything, not just to what it was asked",
  );
});
