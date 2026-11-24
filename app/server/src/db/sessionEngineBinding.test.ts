/**
 * The engine-binding write-through (`docs/session-runtime-switching.md`
 * "Engine bindings"): `session_index`'s six binding columns are the active
 * binding's projection, written only by `sessionStore.upsert`,
 * `switchCredentialProfile` and `switchEngineBinding`, each writing the binding
 * in the same transaction. After every writer the row equals the active
 * binding.
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

type BindingFields = import("./sessionEngineBinding.ts").ActiveBindingFields;
type UsageCounters = import("./sessionEngineBinding.ts").UsageCounters;
type Pending = import("@assistant/shared").SessionPendingRuntime;

const PENDING: Pending = {
  model: { provider: "claude", id: "opus" },
  thinkingLevel: "high",
  account: { kind: "automatic" },
  setBy: "user",
};

/** Commit a switch from the active binding to `fields`. */
function switchTo(
  id: string,
  fields: BindingFields,
  options: {
    pending?: Pending;
    nativeSessionId?: string | null;
    startedSeq?: number;
    nativeUsage?: UsageCounters | null;
  } = {},
): void {
  sessionStore.switchEngineBinding(id, {
    nativeUsage: options.nativeUsage ?? null,
    expectSeq: sessionStore.activeBinding(id)!.seq,
    fields,
    nativeSessionId:
      options.nativeSessionId !== undefined
        ? options.nativeSessionId
        : fields.harness === "pi"
          ? id
          : fields.providerSessionId,
    startedSeq: options.startedSeq ?? 0,
    pending: options.pending ?? PENDING,
  });
}

const CLAUDE: BindingFields = {
  harness: "claude-sdk",
  credentialProfileId: "acct-c",
  provider: "claude",
  model: "opus",
  thinkingLevel: "high",
  providerSessionId: null,
};

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

test("a null native id, model or effort clears the binding and row; an omission keeps them", () => {
  const id = freshId("claude-clear");
  sessionStore.upsert({
    id,
    harness: "claude-sdk",
    agentType: "workshop",
    providerSessionId: "sdk-session-1",
    model: "sonnet",
    thinkingLevel: "high",
  });
  sessionStore.upsert({ id, harness: "claude-sdk", agentType: "workshop" });
  assert.equal(
    sessionStore.activeBinding(id)?.nativeSessionId,
    "sdk-session-1",
  );
  sessionStore.upsert({
    id,
    harness: "claude-sdk",
    agentType: "workshop",
    providerSessionId: null,
    model: null,
    thinkingLevel: null,
  });
  const binding = sessionStore.activeBinding(id);
  assert.equal(binding?.nativeSessionId, undefined);
  assert.equal(binding?.model, undefined);
  assert.equal(binding?.thinkingLevel, undefined);
  assert.equal(sessionStore.get(id)?.providerSessionId, undefined);
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

test("on one harness, only the instance of the active binding writes it: never the next one before its commit, never the one it left after (F023, F025)", () => {
  const id = freshId("same-harness-writer");
  const codex = {
    id,
    harness: "pi" as const,
    agentType: "developer" as const,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinkingLevel: "high",
    credentialProfileId: "acct-codex",
    bindingSeq: 1,
  };
  assert.ok(sessionStore.upsert({ ...codex, title: "Codex", messageCount: 4 }));
  const endpoint = {
    id,
    harness: "pi" as const,
    agentType: "developer" as const,
    provider: "openai-compatible-endpoint",
    model: "llama3",
    thinkingLevel: "off",
  };
  const before = sessionStore.bindings(id);
  // The switch's target, opened for seq 2, before the commit.
  assert.ok(
    sessionStore.upsert({
      ...endpoint,
      bindingSeq: 2,
      title: "Endpoint",
      messageCount: 6,
    }),
  );
  assert.deepEqual(sessionStore.bindings(id), before);
  assert.equal(sessionStore.get(id)?.title, "Codex");
  assert.equal(sessionStore.get(id)?.messageCount, 4);

  switchTo(id, {
    harness: "pi",
    credentialProfileId: "acct-endpoint",
    provider: endpoint.provider,
    model: endpoint.model,
    thinkingLevel: "off",
    providerSessionId: null,
  });
  const committed = sessionStore.bindings(id);
  // A late write from the instance of the binding it left: same harness, but
  // not the active binding's.
  assert.ok(
    sessionStore.upsert({ ...codex, title: "Late codex", messageCount: 9 }),
  );
  assert.deepEqual(sessionStore.bindings(id), committed);
  const row = sessionStore.get(id);
  assert.equal(row?.provider, endpoint.provider);
  assert.equal(row?.model, "llama3");
  assert.equal(row?.credentialProfileId, "acct-endpoint");
  assert.equal(row?.title, "Codex", "a stale title does not land either");
  assertRowIsActiveBinding(id);

  // The committed target writes as the active binding.
  assert.ok(
    sessionStore.upsert({ ...endpoint, bindingSeq: 2, title: "Endpoint" }),
  );
  assert.equal(sessionStore.get(id)?.title, "Endpoint");
  assertRowIsActiveBinding(id);
});

/** A native counter holding `input` tokens and `cost` micros over `turns` runs. */
function counted(input: number, cost: number, turns = 1): UsageCounters {
  return {
    inputTokens: input,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: input,
    costMicros: cost,
    usageTurns: turns,
    assistantTurns: turns,
  };
}

/** An engine's running native total as it reports it. */
function reported(input: number, cost: number, turns = 1) {
  return {
    ...counted(input, cost, turns),
    currency: "USD",
    usageSource: "provider_reported" as const,
    updatedAt: Date.now(),
  };
}

test("a session's usage is the sum over its bindings: a native total counts on top of a base, a return's record once, a stale instance never (F027)", () => {
  const id = freshId("usage-sum");
  const pi: BindingFields = {
    harness: "pi",
    credentialProfileId: "acct-codex",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinkingLevel: "high",
    providerSessionId: null,
  };
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "developer",
      credentialProfileId: "acct-codex",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinkingLevel: "high",
      title: "Sum",
    }),
  );
  const totals = () => {
    const t = sessionStore.getUsageTotals(id);
    return [t?.inputTokens, t?.costMicros, t?.usageTurns];
  };
  // pi counts run by run.
  sessionStore.recordUsageTurn(id, { inputTokens: 100, costUSD: 0.5 });
  assert.deepEqual(totals(), [100, 500_000, 1]);

  // To a fresh Claude record: the binding counts on top of all of it.
  switchTo(id, CLAUDE, { nativeUsage: counted(0, 0, 0) });
  assert.deepEqual(
    sessionStore.activeBinding(id)?.usageBase,
    counted(100, 500_000),
  );
  sessionStore.replaceEngineUsage(id, 2, reported(10, 10_000));
  assert.deepEqual(totals(), [110, 510_000, 2]);
  // The binding it left, or one not yet committed, writes nothing.
  sessionStore.replaceEngineUsage(id, 1, reported(1, 1));
  sessionStore.replaceEngineUsage(id, 3, reported(1, 1));
  assert.deepEqual(totals(), [110, 510_000, 2]);

  // Back to pi: no base, its runs add; Claude's late report lands nowhere.
  switchTo(id, pi);
  assert.equal(sessionStore.activeBinding(id)?.usageBase, undefined);
  sessionStore.recordUsageTurn(id, { inputTokens: 1_000, costUSD: 1 });
  sessionStore.replaceEngineUsage(id, 2, reported(20, 20_000, 2));
  assert.deepEqual(totals(), [1_110, 1_510_000, 3]);

  // A return reopens the record that holds its first stretch: that stretch is
  // already in the session's totals, so the base leaves it out.
  switchTo(id, CLAUDE, { nativeUsage: counted(10, 10_000) });
  assert.deepEqual(
    sessionStore.activeBinding(id)?.usageBase,
    counted(1_100, 1_500_000, 2),
  );
  sessionStore.replaceEngineUsage(id, 4, reported(25, 25_000, 2));
  assert.deepEqual(totals(), [1_125, 1_525_000, 4]);
});

test("a native counter holding more than the session counted leaves a zero base, never a negative one (F027)", () => {
  const id = freshId("usage-clamp");
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "developer",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
    }),
  );
  switchTo(id, CLAUDE, { nativeUsage: counted(50, 50_000) });
  assert.deepEqual(sessionStore.activeBinding(id)?.usageBase, counted(0, 0, 0));
  sessionStore.replaceEngineUsage(id, 2, reported(60, 60_000));
  assert.equal(sessionStore.getUsageTotals(id)?.inputTokens, 60);
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
  switchTo(id, {
    harness: "claude-sdk",
    credentialProfileId: "acct-c",
    provider: "claude",
    model: "claude-opus-5-5",
    thinkingLevel: null,
    providerSessionId: null,
  });
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

test("a switch ends the active binding, starts the next and projects it, clearing the selection it applied", () => {
  const id = freshId("switch-commit");
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "developer",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinkingLevel: "medium",
      credentialProfileId: "acct-a",
    }),
  );
  sessionStore.setPendingRuntime(id, PENDING);
  switchTo(id, CLAUDE, { startedSeq: 17 });
  const [first, second] = sessionStore.bindings(id);
  assert.equal(first?.harness, "pi");
  assert.ok(first?.endedAt, "the first binding ended");
  assert.equal(second?.seq, 2);
  assert.equal(second?.harness, "claude-sdk");
  assert.equal(
    second?.nativeSessionId,
    undefined,
    "fresh: learned on its first query",
  );
  assert.equal(second?.startedSeq, 17);
  assert.equal(second?.startedRunId, undefined);
  assert.equal(sessionStore.get(id)?.pendingRuntime, undefined);
  assertRowIsActiveBinding(id);

  // Its first query names the native session; the active engine writes through.
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "claude-sdk",
      agentType: "developer",
      providerSessionId: "native-1",
    }),
  );
  assert.equal(sessionStore.activeBinding(id)?.nativeSessionId, "native-1");
  assertRowIsActiveBinding(id);

  // A return to pi is a new binding with pi's own id, the app id.
  switchTo(id, {
    harness: "pi",
    credentialProfileId: "acct-a",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinkingLevel: "medium",
    providerSessionId: null,
  });
  assert.deepEqual(
    sessionStore.bindings(id).map((b) => [b.seq, b.harness, b.nativeSessionId]),
    [
      [1, "pi", id],
      [2, "claude-sdk", "native-1"],
      [3, "pi", id],
    ],
  );
  assertRowIsActiveBinding(id);
});

test("a switch keeps a selection set after the one it applied", () => {
  const id = freshId("switch-newer-pending");
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "developer",
      credentialProfileId: "acct-a",
    }),
  );
  const newer: Pending = { ...PENDING, thinkingLevel: "low" };
  sessionStore.setPendingRuntime(id, newer);
  switchTo(id, CLAUDE);
  assert.deepEqual(sessionStore.get(id)?.pendingRuntime, newer);
});

test("a switch from a binding that is no longer active, or of a deleted session, changes nothing", () => {
  const id = freshId("switch-stale");
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "developer",
      credentialProfileId: "acct-a",
    }),
  );
  sessionStore.setPendingRuntime(id, PENDING);
  const before = sessionStore.bindings(id);
  assert.throws(
    () =>
      sessionStore.switchEngineBinding(id, {
        nativeUsage: null,
        expectSeq: 2,
        fields: CLAUDE,
        nativeSessionId: null,
        startedSeq: 0,
        pending: PENDING,
      }),
    /engine changed while it switched/,
  );
  assert.deepEqual(sessionStore.bindings(id), before);
  assert.equal(sessionStore.get(id)?.harness, "pi");
  assert.deepEqual(sessionStore.get(id)?.pendingRuntime, PENDING);

  sessionStore.markDeleted(id);
  assert.throws(() => switchTo(id, CLAUDE), /not found or has been deleted/);
  assert.deepEqual(sessionStore.bindings(id), before);
});

test("the first run of a switched-to binding names it, once; a first binding is never stamped", () => {
  const id = freshId("switch-run-stamp");
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "developer",
      credentialProfileId: "acct-a",
    }),
  );
  sessionStore.stampBindingRun(id, "run-before");
  assert.equal(sessionStore.activeBinding(id)?.startedRunId, undefined);
  switchTo(id, CLAUDE);
  sessionStore.stampBindingRun(id, "run-1");
  sessionStore.stampBindingRun(id, "run-2");
  assert.equal(sessionStore.activeBinding(id)?.startedRunId, "run-1");
  assert.equal(sessionStore.bindings(id)[0]?.startedRunId, undefined);
});
