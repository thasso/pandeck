import assert from "node:assert/strict";
import { test } from "vitest";

const { sessionStore } = await import("./sessionStore.ts");
const { getDb } = await import("./index.ts");

test("SQLite session store persists developer persona sessions", () => {
  const id = `developer-session-${Date.now()}`;
  const storedOk = sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    title: "Developer coding session",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 2,
    provider: "openai-codex",
    providerSessionId: id,
    model: "gpt-5.5",
    thinkingLevel: "medium",
  });

  assert.equal(storedOk, true);
  const stored = sessionStore.get(id);
  assert.ok(stored, "developer session was stored");
  assert.equal(stored.agentType, "developer");
  assert.equal(stored.harness, "pi");
  assert.equal(stored.model, "gpt-5.5");
  assert.equal(stored.mode, "build");
});

test("SQLite session store preserves an established credential profile", () => {
  const id = `profile-bound-session-${Date.now()}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    credentialProfileId: "openai-one",
  });
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    credentialProfileId: "openai-two",
  });
  assert.equal(sessionStore.get(id)?.credentialProfileId, "openai-one");
});

test("SQLite session store persists mutable Build/Plan mode", () => {
  const id = `mode-session-${Date.now()}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    mode: "plan",
  });
  assert.equal(sessionStore.get(id)?.mode, "plan");

  // Omitted metadata preserves the stored policy; an explicit live flip moves it.
  sessionStore.upsert({ id, harness: "pi", agentType: "developer" });
  assert.equal(sessionStore.get(id)?.mode, "plan");
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    mode: "build",
  });
  assert.equal(sessionStore.get(id)?.mode, "build");
});

test("SQLite session store freezes skill names insert-only", () => {
  const id = `skills-session-${Date.now()}`;
  assert.equal(sessionStore.getSkills(id), undefined);
  assert.equal(sessionStore.freezeSkills(id, '["alpha"]', 1), '["alpha"]');
  assert.equal(sessionStore.freezeSkills(id, '["beta"]', 2), '["alpha"]');
  assert.equal(sessionStore.getSkills(id), '["alpha"]');
});

test("SQLite session store persists and batch-reads one spawned parent per child", () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  const parent = `spawn-parent-${suffix}`;
  const otherParent = `spawn-other-parent-${suffix}`;
  const child = `spawn-child-${suffix}`;
  for (const id of [parent, otherParent, child])
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "assistant",
      title: id,
    });

  sessionStore.linkSpawned(parent, child, 10);
  sessionStore.linkSpawned(parent, child, 20);

  assert.deepEqual(
    sessionStore.spawnedParentsByChildIds([child, "not-a-session", child]),
    new Map([[child, { parentSessionId: parent, ownership: "coordinator" }]]),
  );
  assert.throws(
    () => sessionStore.linkSpawned(otherParent, child),
    /already spawned by/,
  );
  const count = getDb()
    .prepare(
      "SELECT COUNT(*) AS count FROM session_links WHERE child_session_id = ? AND relation_type = 'spawned'",
    )
    .get(child) as { count: number };
  assert.equal(count.count, 1, "the idempotent insert kept exactly one edge");

  const plan = getDb()
    .prepare(
      "EXPLAIN QUERY PLAN SELECT parent_session_id FROM session_links WHERE child_session_id IN (?) AND relation_type = 'spawned'",
    )
    .all(child) as Array<{ detail: string }>;
  assert.ok(
    plan.some((row) => row.detail.includes("session_links_child_idx")),
    "the bounded provenance read uses the child index",
  );

  // The schema promises that deleting either endpoint removes the relation.
  getDb().prepare("DELETE FROM session_index WHERE id = ?").run(parent);
  assert.equal(sessionStore.spawnedParentsByChildIds([child]).size, 0);
  sessionStore.linkSpawned(otherParent, child);
  getDb().prepare("DELETE FROM session_index WHERE id = ?").run(child);
  const afterChildDelete = getDb()
    .prepare(
      "SELECT COUNT(*) AS count FROM session_links WHERE parent_session_id = ? AND relation_type = 'spawned'",
    )
    .get(otherParent) as { count: number };
  assert.equal(afterChildDelete.count, 0);
  getDb().prepare("DELETE FROM session_index WHERE id = ?").run(otherParent);
});

test("SQLite session store records spawn takeover monotonically", () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  const parent = `own-parent-${suffix}`;
  const child = `own-child-${suffix}`;
  const legacy = `own-legacy-${suffix}`;
  const malformed = `own-malformed-${suffix}`;
  const plain = `own-plain-${suffix}`;
  for (const id of [parent, child, legacy, malformed, plain])
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "assistant",
      title: id,
    });
  const ownershipOf = (id: string) =>
    sessionStore.spawnedParentsByChildIds([id]).get(id);

  // A new link is coordinator-owned from creation.
  sessionStore.linkSpawned(parent, child, 10);
  assert.deepEqual(ownershipOf(child), {
    parentSessionId: parent,
    ownership: "coordinator",
  });

  // The first qualifying prompt transitions and stamps; later ones do not.
  assert.equal(sessionStore.markSpawnedTakenOver(child, 500), true);
  assert.deepEqual(ownershipOf(child), {
    parentSessionId: parent,
    ownership: "taken-over",
    takenOverAt: 500,
  });
  assert.equal(
    sessionStore.markSpawnedTakenOver(child, 900),
    false,
    "a later prompt reports no transition, so nothing is broadcast",
  );
  assert.equal(
    ownershipOf(child)?.takenOverAt,
    500,
    "the first takeover timestamp is preserved",
  );

  // Re-linking the same pair is idempotent and cannot erase the takeover.
  sessionStore.linkSpawned(parent, child, 20);
  assert.deepEqual(ownershipOf(child), {
    parentSessionId: parent,
    ownership: "taken-over",
    takenOverAt: 500,
  });

  // A link written before ownership tracking, and one whose metadata cannot be
  // read, both fail closed to `unknown` rather than to coordinator ownership.
  sessionStore.linkSpawned(parent, legacy, 10);
  sessionStore.linkSpawned(parent, malformed, 10);
  const setMetadata = (id: string, value: string | null) =>
    getDb()
      .prepare(
        `UPDATE session_links SET metadata_json = ?
          WHERE child_session_id = ? AND relation_type = 'spawned'`,
      )
      .run(value, id);
  setMetadata(legacy, null);
  setMetadata(malformed, "{not json");
  assert.equal(ownershipOf(legacy)?.ownership, "unknown");
  assert.equal(ownershipOf(malformed)?.ownership, "unknown");
  setMetadata(malformed, JSON.stringify({ ownership: "owner-of-everything" }));
  assert.equal(ownershipOf(malformed)?.ownership, "unknown");

  // A taken-over marker without a finite timestamp is malformed too. It must
  // remain repairable by the first qualifying prompt.
  setMetadata(malformed, JSON.stringify({ ownership: "taken-over" }));
  assert.equal(ownershipOf(malformed)?.ownership, "unknown");
  setMetadata(malformed, '{"ownership":"taken-over","takenOverAt":1e999}');
  assert.equal(ownershipOf(malformed)?.ownership, "unknown");
  assert.equal(sessionStore.markSpawnedTakenOver(malformed, 700), true);
  assert.deepEqual(ownershipOf(malformed), {
    parentSessionId: parent,
    ownership: "taken-over",
    takenOverAt: 700,
  });

  // An unknown edge still transitions: a direct human prompt is evidence that
  // missing creation metadata is not.
  assert.equal(sessionStore.markSpawnedTakenOver(legacy, 800), true);
  assert.equal(ownershipOf(legacy)?.ownership, "taken-over");

  // A session that was never spawned has no ownership to move.
  assert.equal(sessionStore.markSpawnedTakenOver(plain), false);
  assert.equal(ownershipOf(plain), undefined);

  for (const id of [parent, child, legacy, malformed, plain])
    getDb().prepare("DELETE FROM session_index WHERE id = ?").run(id);
});

test("SQLite session store does not constrain future persona names", () => {
  const id = `future-persona-${Date.now()}`;
  const storedOk = sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "future-persona" as import("@assistant/shared").SessionAgentType,
    title: "Future persona session",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
  });

  assert.equal(storedOk, true);
  const stored = sessionStore.get(id);
  assert.ok(stored, "future persona session was stored");
  assert.equal(
    stored.agentType,
    "future-persona" as import("@assistant/shared").SessionAgentType,
  );
});

/* ------------------- automatic archival of settled sessions ------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

function seedSettled(
  label: string,
  opts: {
    scope?: import("@assistant/shared").SessionScope;
    settledAt?: number;
    messageCount?: number;
  } = {},
): string {
  const id = `retention-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: `Settled ${label}`,
    messageCount: opts.messageCount ?? 3,
    updatedAt: 1_000,
    ...(opts.scope ? { scope: opts.scope } : {}),
  });
  if (opts.settledAt !== undefined)
    sessionStore.setSettled(id, true, opts.settledAt);
  return id;
}

test("archiveSettledBatch rechecks durable eligibility for every id in one write", () => {
  const now = Date.now();
  const cutoff = now - 7 * DAY_MS;
  const old = seedSettled("old", { settledAt: cutoff - DAY_MS });
  const boundary = seedSettled("boundary", { settledAt: cutoff });
  const fresh = seedSettled("fresh", { settledAt: cutoff + 1 });
  const never = seedSettled("never");
  const internal = seedSettled("internal", {
    scope: "internal",
    settledAt: cutoff - DAY_MS,
  });
  const deleted = seedSettled("deleted", { settledAt: cutoff - DAY_MS });
  sessionStore.remove(deleted);
  const already = seedSettled("already", { settledAt: cutoff - DAY_MS });
  sessionStore.setArchived(already, true, 5);
  // Settled, then a NEWER outcome the user never acknowledged: settlement no
  // longer holds, however old the mark is.
  const woken = seedSettled("woken", { settledAt: cutoff - DAY_MS });
  sessionStore.recordSessionOutcome(woken, "completed");
  // Settled AFTER its latest outcome, acknowledging it: settlement holds.
  const acknowledged = seedSettled("acknowledged");
  sessionStore.recordSessionOutcome(acknowledged, "failed");
  sessionStore.setSettled(acknowledged, true, cutoff - DAY_MS, 1);
  // Re-settled recently: the LATEST settlement is what ages.
  const resettled = seedSettled("resettled", {
    settledAt: cutoff - 3 * DAY_MS,
  });
  sessionStore.setSettled(resettled, true, cutoff + DAY_MS);
  const unknown = `retention-unknown-${Date.now()}`;

  const ids = [
    old,
    boundary,
    fresh,
    never,
    internal,
    deleted,
    already,
    woken,
    acknowledged,
    resettled,
    unknown,
    old, // duplicates collapse
  ];
  const archived = sessionStore.archiveSettledBatch(ids, cutoff, now);

  assert.deepEqual(
    new Set(archived),
    new Set([old, boundary, acknowledged]),
    "only live user rows settled at or before the cutoff with an acknowledged outcome",
  );
  for (const id of archived) {
    const row = sessionStore.get(id);
    assert.equal(row?.archivedAt, now, `${id} carries the sweep's timestamp`);
    assert.ok(
      row && row.readAt >= row.updatedAt,
      `${id} is read through its latest update, like a manual archive`,
    );
  }
  assert.equal(sessionStore.get(fresh)?.archivedAt, undefined);
  assert.equal(sessionStore.get(never)?.archivedAt, undefined);
  assert.equal(sessionStore.get(internal)?.archivedAt, undefined);
  assert.equal(sessionStore.get(woken)?.archivedAt, undefined);
  assert.equal(sessionStore.get(resettled)?.archivedAt, undefined);
  assert.equal(
    sessionStore.get(already)?.archivedAt,
    5,
    "an archived row keeps its original archive time",
  );
  assert.deepEqual(sessionStore.archiveSettledBatch([], cutoff, now), []);

  // Reversible: restoring puts the row straight back into the default list.
  sessionStore.setArchived(old, false);
  assert.equal(sessionStore.get(old)?.archivedAt, undefined);
  assert.ok(
    sessionStore.list({ excludeArchived: true }).some((row) => row.id === old),
  );
});

test("archiveSettledBatch commits a large backfill as one batch", () => {
  const now = Date.now();
  const cutoff = now - 7 * DAY_MS;
  // More ids than one `IN (…)` chunk carries, so the batch spans chunks and
  // still lands under one commit.
  getDb().exec("BEGIN"); // seeding is not what this test measures
  const ids = Array.from({ length: 620 }, (_, i) =>
    seedSettled(`bulk-${i}`, { settledAt: cutoff - DAY_MS }),
  );
  getDb().exec("COMMIT");
  const archived = sessionStore.archiveSettledBatch(ids, cutoff, now);
  assert.equal(archived.length, ids.length, "every id was archived");
  const counted = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM session_index
        WHERE id LIKE 'retention-bulk-%' AND archived_at_ms = ?`,
    )
    .get(now) as { n: number };
  assert.equal(counted.n, ids.length);
  getDb().exec("BEGIN");
  for (const id of ids) sessionStore.remove(id);
  getDb().exec("COMMIT");
});

test("the default store read excludes archived rows; the archive view asks for them", () => {
  const active = seedSettled("active");
  const shelved = seedSettled("shelved");
  sessionStore.setArchived(shelved, true);

  const defaults = new Set(
    sessionStore.list({ excludeArchived: true }).map((row) => row.id),
  );
  assert.ok(defaults.has(active));
  assert.ok(
    !defaults.has(shelved),
    "an archived row never reaches the default read",
  );
  const everything = new Set(sessionStore.list().map((row) => row.id));
  assert.ok(everything.has(active) && everything.has(shelved));
  assert.ok(sessionStore.countArchived() >= 1);

  // The live gate holds an archived runtime back from the default projection,
  // where the store rows no longer cover it, and lets it through for the
  // archive view, where they do.
  const gate = sessionStore.liveDefaultScopeGate([active, shelved]);
  assert.equal(gate(active), true);
  assert.equal(gate(shelved), false);
  const archiveGate = sessionStore.liveDefaultScopeGate([active, shelved], {
    includeArchived: true,
  });
  assert.equal(archiveGate(shelved), true);
});
