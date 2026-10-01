/**
 * Task 93: memory persistence — the 0011 migration, the card/observation/load/
 * processor stores, restart reconstruction, revision/optimistic-concurrency
 * primitives, and future `personal-assistant` scope round-trip. Uses an isolated
 * temp data dir and explicit timestamps (fake clock).
 *   pnpm --filter @assistant/server test src/db/memoryStore.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "memory-store-test-"));
process.env.ASSISTANT_CWD = tmp;

const { memoryStore } = await import("./memoryStore.ts");
const { memoryObservationStore } = await import("./memoryObservationStore.ts");
const { memoryLoadStore } = await import("./memoryLoadStore.ts");
const { memoryProcessorStore } = await import("./memoryProcessorStore.ts");
const { closeDb } = await import("./index.ts");

const T0 = 1_700_000_000_000; // fixed base clock

test("memory persistence: cards, revisions, observations, loads, processor ledger, restart", () => {
  /* ------------------------------ cards ---------------------------------- */
  const card = memoryStore.insert({
    id: "mem_a",
    text: "Prefers concise answers",
    kind: "preference",
    scope: { persona: "personal-assistant", projectId: "acme" },
    temporal: { mode: "persistent" },
    observedAtMs: T0,
    createdAt: T0,
    updatedAt: T0,
    sourceKind: "manual",
    sourceSessionId: "sess-1",
    idempotencyKey: "k1",
    reason: "user asked",
  });
  assert.equal(card.revision, 1);
  assert.equal(
    card.scope.persona,
    "personal-assistant",
    "future personal-assistant scope round-trips",
  );
  assert.equal(card.scope.projectId, "acme");
  assert.equal(card.provenance.sourceKind, "manual");

  // Idempotency lookup.
  assert.equal(memoryStore.findByIdempotencyKey("k1")!.id, "mem_a");
  // Unique idempotency: a second insert with the same key throws.
  assert.throws(() =>
    memoryStore.insert({
      id: "mem_dup",
      text: "dup",
      kind: "fact",
      scope: {},
      temporal: { mode: "persistent" },
      observedAtMs: T0,
      createdAt: T0,
      updatedAt: T0,
      sourceKind: "manual",
      idempotencyKey: "k1",
    }),
  );

  /* --------------------- revision / optimistic concurrency --------------- */
  const updated = memoryStore.updateChecked(
    "mem_a",
    1,
    { text: "Prefers very concise answers", pinned: true },
    T0 + 1_000,
  );
  assert.ok(
    updated && updated.revision === 2 && updated.pinned === true,
    "revision bumped on checked update",
  );
  // Stale revision makes no change and returns undefined.
  const stale = memoryStore.updateChecked(
    "mem_a",
    1,
    { text: "should not apply" },
    T0 + 2_000,
  );
  assert.equal(stale, undefined, "stale revision rejected");
  assert.equal(
    memoryStore.get("mem_a")!.text,
    "Prefers very concise answers",
    "stale update did not mutate",
  );

  // Correction/supersession lineage: superseded old + active replacement.
  memoryStore.updateChecked("mem_a", 2, { state: "superseded" }, T0 + 3_000);
  memoryStore.insert({
    id: "mem_a2",
    text: "Prefers concise, bulleted answers",
    kind: "preference",
    scope: { persona: "personal-assistant", projectId: "acme" },
    temporal: { mode: "persistent" },
    observedAtMs: T0 + 3_000,
    createdAt: T0 + 3_000,
    updatedAt: T0 + 3_000,
    sourceKind: "agent",
    supersedesId: "mem_a",
  });
  assert.deepEqual(
    memoryStore.supersededBy("mem_a").map((c) => c.id),
    ["mem_a2"],
    "supersession chain inspectable",
  );
  assert.deepEqual(
    memoryStore.activeCards().map((c) => c.id),
    ["mem_a2"],
    "only active card selected",
  );

  // markLoaded does not bump revision.
  memoryStore.markLoaded(["mem_a2"], T0 + 4_000);
  assert.equal(
    memoryStore.get("mem_a2")!.revision,
    1,
    "loading is not a mutation",
  );
  assert.equal(memoryStore.get("mem_a2")!.lastLoadedAt, T0 + 4_000);

  /* --------------------------- observations ------------------------------ */
  const obs = memoryObservationStore.enqueue({
    sessionId: "sess-1",
    userTurnId: "turn-1",
    persona: "personal-assistant",
    humanText: "Remember I am in Tokyo next week",
    sourceTimestampMs: T0,
    timezone: "Europe/Berlin",
    highSignal: true,
    createdAt: T0,
  });
  assert.equal(obs.timezone, "Europe/Berlin");
  // Idempotent per (session, turn).
  const again = memoryObservationStore.enqueue({
    sessionId: "sess-1",
    userTurnId: "turn-1",
    humanText: "changed",
    sourceTimestampMs: T0 + 9,
    timezone: "UTC",
    createdAt: T0 + 9,
  });
  assert.equal(again.id, obs.id, "same turn does not double-enqueue");
  assert.equal(
    again.sourceTimestampMs,
    T0,
    "original source timestamp/timezone preserved",
  );
  const claimed = memoryObservationStore.claim([obs.id], T0 + 100);
  assert.equal(claimed.length, 1);
  assert.equal(memoryObservationStore.get(obs.id)!.state, "processing");

  /* ------------------------- load audit + snapshot ----------------------- */
  const effectiveItems = [
    {
      id: "mem_a2",
      revision: 1,
      kind: "preference" as const,
      scope: {},
      text: "Prefers concise, bulleted answers",
      rank: 1,
      reasonCode: "baseline-preference" as const,
      reason: "stable preference",
      renderedChars: 42,
      provenance: { sourceKind: "manual" as const },
    },
  ];
  const batch = memoryLoadStore.recordBatch({
    sessionId: "sess-1",
    userTurnId: "turn-1",
    fingerprint: "fp1",
    deliveryState: "injected",
    renderedChars: 42,
    injectedChars: 42,
    cumulativeInjectedChars: 42,
    createdAt: T0 + 200,
    items: effectiveItems,
  });
  assert.equal(batch.items.length, 1);
  // Reused re-delivery of the same turn replaces the batch (idempotent).
  const reused = memoryLoadStore.recordBatch({
    sessionId: "sess-1",
    userTurnId: "turn-1",
    fingerprint: "fp1",
    deliveryState: "reused",
    renderedChars: 42,
    injectedChars: 0,
    cumulativeInjectedChars: 42,
    createdAt: T0 + 300,
    items: effectiveItems,
  });
  assert.equal(
    memoryLoadStore.recentForSession("sess-1").length,
    1,
    "same turn does not duplicate audit rows",
  );
  assert.equal(
    reused.injectedChars,
    0,
    "reused batch adds zero injected chars while recording the effective set",
  );

  memoryLoadStore.putSnapshot({
    sessionId: "sess-1",
    fingerprint: "fp1",
    effective: [{ id: "mem_a2", revision: 1 }],
    renderedText: "…",
    renderedChars: 42,
    lastDeliveryState: "injected",
    lastDeliveryTurnId: "turn-1",
    cumulativeInjectedChars: 42,
    updatedAt: T0 + 300,
  });

  /* --------------------------- processor ledger -------------------------- */
  const runId = memoryProcessorStore.reserve(T0 + 400, "high-signal");
  assert.equal(
    memoryProcessorStore.callsSince(T0),
    1,
    "reservation counts toward the calls window",
  );
  memoryProcessorStore.reconcile(runId, "success", T0 + 500, {
    operationsApplied: 2,
    costMicrosUsd: 25_000,
  });
  assert.equal(memoryProcessorStore.costMicrosSince(T0), 25_000);
  // A skipped reservation does not count as a call.
  const skipped = memoryProcessorStore.reserve(T0 + 600, "batch");
  memoryProcessorStore.reconcile(skipped, "skipped", T0 + 600);
  assert.equal(
    memoryProcessorStore.callsSince(T0),
    1,
    "skipped runs excluded from the call count",
  );
  // Window boundaries: a run one hour+ before `since` is excluded.
  assert.equal(
    memoryProcessorStore.callsSince(T0 + 450),
    0,
    "older reservation outside the window is excluded",
  );

  /* ------------------------------ restart -------------------------------- */
  closeDb();
  const persisted = memoryLoadStore.getSnapshot("sess-1");
  assert.ok(persisted, "snapshot reconstructs after restart");
  assert.equal(
    persisted!.cumulativeInjectedChars,
    42,
    "cumulative injection diagnostic survives restart",
  );
  assert.deepEqual(
    persisted!.effective,
    [{ id: "mem_a2", revision: 1 }],
    "exact effective id/revision survives restart",
  );
  assert.equal(
    memoryObservationStore.get(obs.id)!.state,
    "processing",
    "observation survives restart",
  );
  assert.equal(
    memoryProcessorStore.costMicrosSince(T0),
    25_000,
    "processor ledger survives restart",
  );
  // Stale-claim recovery after a crash.
  assert.equal(
    memoryObservationStore.recoverStale(T0 + 10_000),
    1,
    "stale processing claim recovered to pending",
  );
  assert.equal(memoryObservationStore.get(obs.id)!.state, "pending");

  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});
