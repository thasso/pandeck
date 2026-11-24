/**
 * The engine-binding write-through (`docs/session-runtime-switching.md`
 * "Engine bindings"): `session_index`'s six binding columns are the active
 * binding's projection, written only by `sessionStore.upsert` and
 * `switchCredentialProfile`, each writing the binding in the same transaction.
 * After every writer the row equals the active binding.
 *
 *   pnpm --filter @assistant/server test src/db/sessionEngineBinding.test.ts
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test, vi } from "vitest";

const { sessionStore } = await import("./sessionStore.ts");
const { getDb } = await import("./index.ts");
const { activeEngine, activeNativeRef } =
  await import("../harnesses/activeEngine.ts");
const { harnessRegistry } = await import("../harnesses/registry.ts");
const { piSessionFile } = await import("../piSessionFile.ts");
const { canonicalPiSessionPath, piNativeFile } =
  await import("../sessionStorage.ts");
const { DATA_DIR } = await import("../config.ts");

let counter = 0;
const freshId = (prefix: string) => `${prefix}-${Date.now()}-${counter++}`;

/** The row's projection and the active binding, in the same vocabulary. */
function rowAndBinding(id: string) {
  const row = sessionStore.getIncludingDeleted(id);
  const binding = sessionStore.activeBinding(id);
  assert.ok(row, `${id} has a row`);
  assert.ok(binding, `${id} has an active binding`);
  return {
    row: {
      harness: row.harness,
      provider: row.provider,
      model: row.model,
      thinkingLevel: row.thinkingLevel,
      credentialProfileId: row.credentialProfileId,
      nativeSessionId: activeNativeRef(row).nativeSessionId,
    },
    binding: {
      harness: binding.harness,
      provider: binding.provider,
      model: binding.model,
      thinkingLevel: binding.thinkingLevel,
      credentialProfileId: binding.credentialProfileId,
      nativeSessionId: binding.nativeSessionId,
    },
  };
}

function assertRowIsActiveBinding(id: string): void {
  const { row, binding } = rowAndBinding(id);
  assert.deepEqual(binding, row);
  assert.equal(
    sessionStore.bindings(id).filter((b) => b.endedAt === undefined).length,
    1,
    "exactly one active binding",
  );
}

test("a new pi row gets its first binding, its native id its app id", () => {
  const id = freshId("pi-new");
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "assistant",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinkingLevel: "medium",
      credentialProfileId: "acct-a",
      createdAt: 1_000,
    }),
  );
  const [binding, ...rest] = sessionStore.bindings(id);
  assert.deepEqual(rest, []);
  assert.deepEqual(binding, {
    sessionId: id,
    seq: 1,
    harness: "pi",
    credentialProfileId: "acct-a",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinkingLevel: "medium",
    nativeSessionId: id,
    startedSeq: 0,
    createdAt: 1_000,
  });
  assertRowIsActiveBinding(id);
});

test("a Claude row's native id arrives with its first query and writes through", () => {
  const id = freshId("claude-new");
  sessionStore.upsert({ id, harness: "claude-sdk", agentType: "workshop" });
  assert.equal(sessionStore.activeBinding(id)?.nativeSessionId, undefined);
  sessionStore.upsert({
    id,
    harness: "claude-sdk",
    agentType: "workshop",
    providerSessionId: "sdk-session-1",
    model: "sonnet",
  });
  assert.equal(
    sessionStore.activeBinding(id)?.nativeSessionId,
    "sdk-session-1",
  );
  assert.equal(sessionStore.bindings(id).length, 1);
  assertRowIsActiveBinding(id);
});

test("updates write through and omissions preserve, without a second binding", () => {
  const id = freshId("pi-update");
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    credentialProfileId: "acct-a",
  });
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    model: "gpt-5.6-terra",
    thinkingLevel: "high",
  });
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: "t",
  });
  const binding = sessionStore.activeBinding(id);
  assert.equal(binding?.model, "gpt-5.6-terra");
  assert.equal(binding?.thinkingLevel, "high");
  assert.equal(binding?.provider, "openai-codex");
  assert.equal(sessionStore.bindings(id).length, 1);
  assertRowIsActiveBinding(id);
});

test("an ordinary upsert cannot move the account; failover's CAS moves row and binding together", () => {
  const id = freshId("pi-failover");
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    credentialProfileId: "acct-a",
  });
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    credentialProfileId: "acct-b",
  });
  assert.equal(sessionStore.activeBinding(id)?.credentialProfileId, "acct-a");
  sessionStore.switchCredentialProfile(id, "acct-a", "acct-b");
  assert.equal(sessionStore.activeBinding(id)?.credentialProfileId, "acct-b");
  assertRowIsActiveBinding(id);
  // A stale CAS changes neither.
  assert.throws(() =>
    sessionStore.switchCredentialProfile(id, "acct-a", "acct-c"),
  );
  assert.equal(sessionStore.activeBinding(id)?.credentialProfileId, "acct-b");
  assertRowIsActiveBinding(id);
});

test("a failed binding write rolls the row back with it", () => {
  const id = freshId("pi-rollback");
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    model: "gpt-5.6-sol",
    credentialProfileId: "acct-a",
  });
  const db = getDb();
  db.exec(`CREATE TEMP TRIGGER binding_write_fails
             BEFORE UPDATE ON session_engine_binding
             WHEN NEW.session_id = '${id}'
             BEGIN SELECT RAISE(ABORT, 'binding write failed'); END`);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    assert.equal(
      sessionStore.upsert({
        id,
        harness: "pi",
        agentType: "assistant",
        model: "gpt-5.6-terra",
      }),
      false,
    );
    assert.throws(
      () => sessionStore.switchCredentialProfile(id, "acct-a", "acct-b"),
      /account changed|binding write failed/,
    );
  } finally {
    db.exec("DROP TRIGGER binding_write_fails");
    warn.mockRestore();
  }
  assert.equal(sessionStore.get(id)?.model, "gpt-5.6-sol");
  assert.equal(sessionStore.get(id)?.credentialProfileId, "acct-a");
  assertRowIsActiveBinding(id);
});

test("a tombstoned row keeps its binding and no upsert resurrects or rewrites it", () => {
  const id = freshId("pi-deleted");
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    model: "gpt-5.6-sol",
  });
  assert.equal(sessionStore.markDeleted(id), "deleted");
  assert.equal(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "assistant",
      model: "gpt-5.6-terra",
    }),
    false,
  );
  assert.equal(sessionStore.get(id), undefined);
  assert.equal(sessionStore.activeBinding(id)?.model, "gpt-5.6-sol");
  assert.equal(sessionStore.bindings(id).length, 1);
});

test("scope claims and internal usage rows are bound like any other row", () => {
  const claimed = freshId("internal-claim");
  sessionStore.claimScope({
    id: claimed,
    harness: "claude-sdk",
    agentType: "assistant",
    scope: "internal",
  });
  assertRowIsActiveBinding(claimed);
  const usage = sessionStore.createInternalUsageSession({
    purpose: "naming",
    title: "Naming",
    harness: "claude-sdk",
    provider: "claude",
    providerSessionId: "sdk-naming",
    model: "haiku",
  });
  assert.equal(
    sessionStore.activeBinding(usage)?.nativeSessionId,
    "sdk-naming",
  );
  assertRowIsActiveBinding(usage);
});

test("the binding table refuses a second active binding and an unknown harness", () => {
  const id = freshId("pi-constraints");
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  const insert = (harness: string, ended: number | null) =>
    getDb()
      .prepare(
        `INSERT INTO session_engine_binding
           (session_id, seq, harness, created_at_ms, ended_at_ms)
         VALUES (?, 2, ?, 1, ?)`,
      )
      .run(id, harness, ended);
  assert.throws(() => insert("pi", null), /UNIQUE/);
  assert.throws(() => insert("other", 5), /CHECK/);
});

test("activeEngine projects a row or driver without reading anything", () => {
  assert.deepEqual(
    activeEngine({
      harness: "claude-sdk",
      provider: "claude",
      model: "sonnet",
      credentialProfileId: "",
    }),
    { harness: "claude-sdk", provider: "claude", model: "sonnet" },
  );
  assert.deepEqual(
    activeNativeRef({ id: "pi-x", harness: "pi", providerSessionId: "odd" }),
    { harness: "pi", sessionId: "pi-x", nativeSessionId: "pi-x" },
  );
  assert.deepEqual(activeNativeRef({ id: "c-x", harness: "claude-sdk" }), {
    harness: "claude-sdk",
    sessionId: "c-x",
  });
});

test("a pi session's transcript resolves through its binding, and rowless through its id", () => {
  const id = freshId("pi-file");
  assert.equal(piSessionFile(id), canonicalPiSessionPath(id), "no row yet");
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  assert.equal(
    piSessionFile(id),
    join(DATA_DIR, "sessions", id, "native.jsonl"),
  );
  assert.throws(() => piNativeFile(id, "another"), /its own native id/);
});

test("engineOf names the bound engine first, else the engine holding it on disk", () => {
  const id = freshId("claude-engine");
  sessionStore.upsert({ id, harness: "claude-sdk", agentType: "assistant" });
  assert.equal(harnessRegistry.engineOf(id), "claude-sdk");
  assert.equal(harnessRegistry.engineOf(freshId("nowhere")), undefined);
});

test("an engine that does not hold the active binding never rewrites the projection or its own figures", () => {
  const id = freshId("foreign-writer");
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "developer",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinkingLevel: "medium",
      credentialProfileId: "acct-a",
      title: "Before",
      updatedAt: 1_000,
      messageCount: 40,
    }),
  );
  const before = sessionStore.bindings(id);
  // A late persist from the other engine (the one a switch closed, or a fresh
  // target before its switch commits): its figures cover only its own native
  // stretch, so neither they nor its binding land.
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "claude-sdk",
      agentType: "developer",
      provider: "claude",
      providerSessionId: "native-claude",
      model: "claude-opus-5-5",
      thinkingLevel: "high",
      title: "After",
      updatedAt: 2_000,
      messageCount: 0,
    }),
  );
  const row = sessionStore.get(id);
  assert.equal(row?.title, "Before");
  assert.equal(row?.updatedAt, 1_000);
  assert.equal(row?.messageCount, 40);
  assert.equal(row?.harness, "pi");
  assert.equal(row?.model, "gpt-5.6-sol");
  assert.equal(row?.provider, "openai-codex");
  assert.equal(row?.thinkingLevel, "medium");
  assert.equal(row?.providerSessionId, undefined);
  assert.deepEqual(sessionStore.bindings(id), before);
  assertRowIsActiveBinding(id);
});

test("after a switch the active engine raises the message count but never lowers it", () => {
  const id = freshId("switched-count");
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "developer",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      credentialProfileId: "acct-a",
      messageCount: 40,
    }),
  );
  // A first binding counts freely, down as well as up.
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "developer",
      messageCount: 38,
    }),
  );
  assert.equal(sessionStore.get(id)?.messageCount, 38);
  // Seed a second binding (no production writer starts one yet).
  const db = getDb();
  db.prepare(
    "UPDATE session_engine_binding SET ended_at_ms = 1 WHERE session_id = ? AND ended_at_ms IS NULL",
  ).run(id);
  db.prepare(
    `INSERT INTO session_engine_binding (
       session_id, seq, harness, credential_profile_id, provider, model,
       thinking_level, native_session_id, started_seq, started_run_id,
       created_at_ms, ended_at_ms
     ) VALUES (?, 2, 'claude-sdk', 'acct-c', 'claude', 'claude-opus-5-5', NULL, NULL, 90, NULL, 2, NULL)`,
  ).run(id);
  db.prepare(
    "UPDATE session_index SET harness = 'claude-sdk', provider = 'claude', model = 'claude-opus-5-5', credential_profile_id = 'acct-c' WHERE id = ?",
  ).run(id);
  // The fresh engine counts only its own two messages: the row keeps 38.
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "claude-sdk",
      agentType: "developer",
      messageCount: 2,
    }),
  );
  assert.equal(sessionStore.get(id)?.messageCount, 38);
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "claude-sdk",
      agentType: "developer",
      messageCount: 39,
    }),
  );
  assert.equal(sessionStore.get(id)?.messageCount, 39);
});
