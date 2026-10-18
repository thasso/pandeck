import assert from "node:assert/strict";
import { test } from "vitest";

const { sessionStore, SPAWNED_DESCENDANTS_SQL, SPAWN_GRANT_EDGE_SQL } =
  await import("./sessionStore.ts");
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

test("live failover alone replaces a binding, with a stale/deleted-row fence", () => {
  const id = `switch-bound-session-${Date.now()}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    credentialProfileId: "first",
    requiresEnterprise: true,
  });
  sessionStore.switchCredentialProfile(id, "first", "second");
  assert.equal(sessionStore.get(id)?.credentialProfileId, "second");
  assert.equal(sessionStore.get(id)?.requiresEnterprise, true);
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    credentialProfileId: "first",
  });
  assert.equal(
    sessionStore.get(id)?.credentialProfileId,
    "second",
    "late metadata refresh cannot restore the old login",
  );
  assert.throws(() =>
    sessionStore.switchCredentialProfile(id, "first", "third"),
  );
  sessionStore.markDeleted(id);
  assert.throws(() =>
    sessionStore.switchCredentialProfile(id, "second", "third"),
  );
});

test("SQLite session store durably freezes an enterprise account requirement", () => {
  const id = `enterprise-session-${Date.now()}`;
  sessionStore.claimScope({
    id,
    harness: "pi",
    agentType: "assistant",
    requiresEnterprise: true,
  });
  assert.equal(sessionStore.get(id)?.requiresEnterprise, true);

  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  assert.equal(sessionStore.get(id)?.requiresEnterprise, true);
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    requiresEnterprise: false,
  });
  assert.equal(sessionStore.get(id)?.requiresEnterprise, true);
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

test("SQLite session store creates a user-owned edge atomically and preserves it on re-link", () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  const parent = `born-parent-${suffix}`;
  const child = `born-child-${suffix}`;
  for (const id of [parent, child])
    sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  sessionStore.linkSpawned(parent, child, 123, "taken-over");
  sessionStore.linkSpawned(parent, child, 456);
  assert.deepEqual(sessionStore.spawnedParentsByChildIds([child]).get(child), {
    parentSessionId: parent,
    ownership: "taken-over",
    takenOverAt: 123,
  });
  assert.ok(
    sessionStore.spawnedDescendantIds(parent).includes(child),
    "worktree tree membership retains every provenance edge",
  );
  assert.equal(sessionStore.spawnedParentByChild().get(child), parent);
  assert.equal(sessionStore.setSpawnedOwnership(child, "coordinator"), true);
  assert.deepEqual(sessionStore.spawnedParentsByChildIds([child]).get(child), {
    parentSessionId: parent,
    ownership: "coordinator",
  });
});

test("SQLite session store sets spawn ownership on the user's word", () => {
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

  // Taking over transitions and stamps; taking over again does not.
  assert.equal(
    sessionStore.setSpawnedOwnership(child, "taken-over", 500),
    true,
  );
  assert.deepEqual(ownershipOf(child), {
    parentSessionId: parent,
    ownership: "taken-over",
    takenOverAt: 500,
  });
  assert.equal(
    sessionStore.setSpawnedOwnership(child, "taken-over", 900),
    false,
    "a repeated takeover reports no transition, so nothing is broadcast",
  );
  assert.equal(
    ownershipOf(child)?.takenOverAt,
    500,
    "the first takeover timestamp is preserved",
  );

  // Handing back returns the child to its coordinator; repeating it is no
  // transition, and taking over again stamps afresh.
  assert.equal(sessionStore.setSpawnedOwnership(child, "coordinator"), true);
  assert.deepEqual(ownershipOf(child), {
    parentSessionId: parent,
    ownership: "coordinator",
  });
  assert.equal(sessionStore.setSpawnedOwnership(child, "coordinator"), false);
  assert.equal(
    sessionStore.setSpawnedOwnership(child, "taken-over", 1_000),
    true,
  );
  assert.equal(
    ownershipOf(child)?.takenOverAt,
    1_000,
    "a takeover after a hand back is a new one, with its own timestamp",
  );

  // Re-linking the same pair is idempotent and cannot erase the takeover.
  sessionStore.linkSpawned(parent, child, 20);
  assert.deepEqual(ownershipOf(child), {
    parentSessionId: parent,
    ownership: "taken-over",
    takenOverAt: 1_000,
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
  // remain repairable by an explicit takeover.
  setMetadata(malformed, JSON.stringify({ ownership: "taken-over" }));
  assert.equal(ownershipOf(malformed)?.ownership, "unknown");
  setMetadata(malformed, '{"ownership":"taken-over","takenOverAt":1e999}');
  assert.equal(ownershipOf(malformed)?.ownership, "unknown");
  assert.equal(
    sessionStore.setSpawnedOwnership(malformed, "taken-over", 700),
    true,
  );
  assert.deepEqual(ownershipOf(malformed), {
    parentSessionId: parent,
    ownership: "taken-over",
    takenOverAt: 700,
  });

  // An unknown edge still transitions: the user's decision is evidence that
  // missing creation metadata is not.
  assert.equal(
    sessionStore.setSpawnedOwnership(legacy, "taken-over", 800),
    true,
  );
  assert.equal(ownershipOf(legacy)?.ownership, "taken-over");

  // A session that was never spawned has no ownership to move.
  assert.equal(sessionStore.setSpawnedOwnership(plain, "taken-over"), false);
  assert.equal(ownershipOf(plain), undefined);

  for (const id of [parent, child, legacy, malformed, plain])
    getDb().prepare("DELETE FROM session_index WHERE id = ?").run(id);
});

/**
 * Every metadata shape a spawn edge may hold, and whether it inherits
 * approval grants: only SQL NULL (an edge older than inheritance) and a plain
 * object without the property do. Writers only ever emit `false`, so any other
 * value — even `true` — is corruption and fails closed.
 */
const INHERITANCE_SHAPES: Array<[string | null, boolean]> = [
  [null, true],
  ['{"ownership":"coordinator"}', true],
  ['{"ownership":"coordinator","inheritGrants":false}', false],
  ['{"inheritGrants":"no"}', false],
  ['{"inheritGrants":true}', false],
  ["not json", false],
  ["null", false],
  ["7", false],
  ['"x"', false],
  ["[]", false],
];

test("a spawn edge inherits grants only when its metadata says nothing against it", () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  const parent = `inherit-parent-${suffix}`;
  sessionStore.upsert({ id: parent, harness: "pi", agentType: "assistant" });
  const inheritsOf = (id: string) => sessionStore.spawnGrantEdge(id)?.inherits;

  INHERITANCE_SHAPES.forEach(([metadata, inherits], index) => {
    const child = `inherit-child-${index}-${suffix}`;
    sessionStore.upsert({ id: child, harness: "pi", agentType: "assistant" });
    sessionStore.linkSpawned(parent, child, 10);
    getDb()
      .prepare(
        `UPDATE session_links SET metadata_json = ?
          WHERE child_session_id = ? AND relation_type = 'spawned'`,
      )
      .run(metadata, child);
    assert.equal(inheritsOf(child), inherits, `read ${String(metadata)}`);

    // Ownership changes rewrite the metadata and must carry the result.
    assert.equal(
      sessionStore.setSpawnedOwnership(child, "taken-over", 500),
      true,
    );
    assert.equal(inheritsOf(child), inherits, `take over ${String(metadata)}`);
    assert.equal(sessionStore.setSpawnedOwnership(child, "coordinator"), true);
    assert.equal(inheritsOf(child), inherits, `hand back ${String(metadata)}`);
    getDb().prepare("DELETE FROM session_index WHERE id = ?").run(child);
  });

  // The opt-out is written at creation, in the same insert, and only as false.
  const optedOut = `inherit-opted-out-${suffix}`;
  const plain = `inherit-plain-${suffix}`;
  for (const id of [optedOut, plain])
    sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  sessionStore.linkSpawned(parent, optedOut, 10, "taken-over", {
    inheritGrants: false,
  });
  sessionStore.linkSpawned(parent, plain, 10, "coordinator", {
    inheritGrants: true,
  });
  const metadataOf = (id: string) =>
    (
      getDb()
        .prepare(
          "SELECT metadata_json FROM session_links WHERE child_session_id = ?",
        )
        .get(id) as { metadata_json: string }
    ).metadata_json;
  assert.deepEqual(JSON.parse(metadataOf(optedOut)), {
    ownership: "taken-over",
    takenOverAt: 10,
    inheritGrants: false,
  });
  assert.deepEqual(JSON.parse(metadataOf(plain)), { ownership: "coordinator" });
  assert.deepEqual(
    sessionStore.spawnedParentsByChildIds([optedOut]).get(optedOut),
    {
      parentSessionId: parent,
      ownership: "taken-over",
      takenOverAt: 10,
    },
  );
  for (const id of [parent, optedOut, plain])
    getDb().prepare("DELETE FROM session_index WHERE id = ?").run(id);
});

test("the grant walk climbs nearest first and stops at an opt-out, a deleted parent or a cycle", () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  const id = (name: string) => `walk-${name}-${suffix}`;
  for (const name of ["root", "mid", "leaf", "opted", "below", "x", "y"])
    sessionStore.upsert({
      id: id(name),
      harness: "pi",
      agentType: "assistant",
    });
  sessionStore.linkSpawned(id("root"), id("mid"));
  sessionStore.linkSpawned(id("mid"), id("leaf"));
  assert.deepEqual(sessionStore.spawnGrantAncestors(id("leaf")), [
    id("mid"),
    id("root"),
  ]);
  assert.deepEqual(sessionStore.spawnGrantAncestors(id("root")), []);

  sessionStore.linkSpawned(id("leaf"), id("opted"), 1, "coordinator", {
    inheritGrants: false,
  });
  sessionStore.linkSpawned(id("opted"), id("below"));
  assert.deepEqual(sessionStore.spawnGrantAncestors(id("opted")), []);
  assert.deepEqual(sessionStore.spawnGrantAncestors(id("below")), [
    id("opted"),
  ]);

  // Archived still counts; soft-deleted ends the walk below it.
  sessionStore.setArchived(id("root"), true);
  assert.deepEqual(sessionStore.spawnGrantAncestors(id("leaf")), [
    id("mid"),
    id("root"),
  ]);
  sessionStore.markDeleted(id("mid"));
  assert.deepEqual(sessionStore.spawnGrantAncestors(id("leaf")), []);

  // A cycle terminates.
  sessionStore.linkSpawned(id("x"), id("y"));
  sessionStore.linkSpawned(id("y"), id("x"));
  assert.deepEqual(sessionStore.spawnGrantAncestors(id("x")), [id("y")]);

  for (const name of ["root", "mid", "leaf", "opted", "below", "x", "y"])
    getDb().prepare("DELETE FROM session_index WHERE id = ?").run(id(name));
});

test("the grant walk's edge read searches the child index and the parent's key", () => {
  const plan = (
    getDb()
      .prepare(`EXPLAIN QUERY PLAN ${SPAWN_GRANT_EDGE_SQL}`)
      .all("x") as Array<{ detail: string }>
  )
    .map((row) => row.detail)
    .join("\n");
  assert.match(
    plan,
    /SEARCH l USING (?:COVERING )?INDEX session_links_child_idx/,
    plan,
  );
  assert.match(
    plan,
    /SEARCH p USING (?:INTEGER PRIMARY KEY|INDEX sqlite_autoindex_session_index_1|PRIMARY KEY)/,
    plan,
  );
  assert.doesNotMatch(plan, /\bSCAN\b/, plan);
});

test("SQLite session store does not constrain future persona names", () => {
  const id = `future-persona-${Date.now()}`;
  const storedOk = sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "future-persona" as import("@assistant/shared").AgentType,
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
    "future-persona" as import("@assistant/shared").AgentType,
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

test("spawnedDescendantIds walks every depth once, survives a cycle and follows only spawn edges", () => {
  const tag = `${Date.now()}-${Math.random()}`;
  const id = (name: string) => `desc-${name}-${tag}`;
  for (const name of ["root", "a", "b", "a1", "forked", "internal"])
    sessionStore.upsert({
      id: id(name),
      harness: "pi",
      agentType: "developer",
    });
  sessionStore.linkSpawned(id("root"), id("a"));
  sessionStore.linkSpawned(id("root"), id("b"));
  sessionStore.linkSpawned(id("a"), id("a1"));
  // A cycle back to the root, which no real spawn makes.
  sessionStore.linkSpawned(id("a1"), id("root"));
  sessionStore.remove(id("b"));
  // Other relations are not spawn edges.
  const insert = getDb().prepare(
    "INSERT INTO session_links (parent_session_id, child_session_id, relation_type, created_at_ms) VALUES (?, ?, ?, 0)",
  );
  insert.run(id("a"), id("forked"), "forked");
  insert.run(id("a"), id("internal"), "internal");

  assert.deepEqual(
    sessionStore.spawnedDescendantIds(id("root")).sort(),
    [id("a"), id("a1"), id("b")].sort(),
    "every depth, a soft-deleted peer included, the root excluded",
  );
  assert.deepEqual(
    sessionStore.spawnedDescendantIds(id("a1")).sort(),
    [id("a"), id("b"), id("root")].sort(),
  );
  assert.deepEqual(sessionStore.spawnedDescendantIds(id("forked")), []);
});

test("spawnedDescendantIds searches by parent at both steps of its recursion", () => {
  const plan = (
    getDb()
      .prepare(`EXPLAIN QUERY PLAN ${SPAWNED_DESCENDANTS_SQL}`)
      .all("x", "x") as Array<{ detail: string }>
  )
    .map((row) => row.detail)
    .join("\n");
  const searches =
    plan.match(
      /SEARCH \S+ USING (?:COVERING )?INDEX \S+ \(parent_session_id=\?/g,
    ) ?? [];
  assert.equal(searches.length, 2, plan);
  assert.doesNotMatch(plan, /SCAN (?:session_links|l)\b/, plan);
});
