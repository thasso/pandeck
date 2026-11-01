/**
 * The write-side half of the session-scope substrate (Task-492): a live
 * registry may not observe a session before its scope is persisted.
 *   pnpm --filter @assistant/server test src/sessionScopeRegistration.test.ts
 *
 * The default projections are only sound because of this ordering — they treat
 * a live session with no metadata row as the user's — so it is enforced at the
 * registration choke points rather than documented, and pinned here.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { claudeSdkStore } from "./claudeSdk/claudeSdkStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { listSessions } from "./sessions.ts";
import { installClaudeStateBuilder } from "./test/claudeSdkSession.ts";

installClaudeStateBuilder(claudeSdkStore);

const created: string[] = [];

afterEach(() => {
  for (const id of created.splice(0)) {
    claudeSdkStore.remove(id);
    sessionStore.remove(id);
  }
});

test("an internal SDK session is persisted before it enters the live map", () => {
  const id = `scope-reg-internal-${Date.now()}`;
  created.push(id);

  // The claim happens inside `acquire`, so by the time ANY caller can see the
  // session in the live registry the row that hides it already exists.
  const session = claudeSdkStore.acquire(id, {
    agentType: "workshop",
    scope: "internal",
  });
  assert.equal(session.id, id);
  assert.equal(sessionStore.get(id)?.scope, "internal");
  assert.equal(sessionStore.liveDefaultScopeGate([id])(id), false);
});

test("registering a persisted internal session as the user's is refused, and it never reaches the live map", () => {
  const id = `scope-reg-mismatch-${Date.now()}`;
  created.push(id);
  sessionStore.claimScope({
    id,
    harness: "claude-sdk",
    agentType: "workshop",
    scope: "internal",
  });

  // A spawn path that forgets to declare the scope fails HERE — loudly, at the
  // registration — instead of leaking an internal run into the sidebar.
  assert.throws(
    () => claudeSdkStore.acquire(id, { agentType: "workshop" }),
    /persisted as internal and cannot be registered as user/,
  );
  assert.equal(
    claudeSdkStore.list().some((s) => s.id === id),
    false,
    "the refused session is not in the live registry",
  );
  assert.equal(claudeSdkStore.get(id), undefined);
});

test("an ordinary session keeps registering without a claim of its own", () => {
  const id = `scope-reg-user-${Date.now()}`;
  created.push(id);
  const session = claudeSdkStore.acquire(id, { agentType: "workshop" });
  assert.equal(session.id, id);
  assert.equal(sessionStore.get(id)?.scope, "user");
  assert.equal(
    claudeSdkStore.list().some((s) => s.id === id),
    true,
  );
});

test("a live pi row is listed only while the store does not classify it otherwise", async () => {
  const id = `scope-reg-live-${Date.now()}`;
  created.push(id);
  const liveRow = {
    kind: "assistant" as const,
    sessionId: id,
    file: `/tmp/${id}.jsonl`,
    title: "First prompt in flight",
    messageCount: 1,
    isStreaming: true,
    awaitingInput: false,
    updatedAt: Date.now(),
  };

  // Before anything is persisted the row is the user's by construction …
  const before = listSessions([liveRow], () => 0);
  assert.ok(before.some((s) => s.id === id));

  // … and the moment a claim classifies it otherwise, the same live row is out.
  sessionStore.claimScope({
    id,
    harness: "pi",
    agentType: "assistant",
    scope: "internal",
  });
  const after = listSessions([liveRow], () => 0);
  assert.ok(!after.some((s) => s.id === id));
});
