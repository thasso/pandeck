/**
 * The default filtering substrate for the three-way session scope (Task-492):
 * a broad projection carries `user` sessions and nothing else, whether the row
 * comes from the store or from a live in-memory source.
 *   pnpm --filter @assistant/server test src/sessionScope.test.ts
 */
import assert from "node:assert/strict";
import type { SessionScope } from "@assistant/shared";
import { afterEach, test } from "vitest";
import { getDb } from "./db/index.ts";
import { sessionStore } from "./db/sessionStore.ts";
import {
  listSessions,
  archivedSessionCount,
  type LiveListInfo,
} from "./sessions.ts";

let n = 0;
const created: string[] = [];

function seed(
  scope: SessionScope,
  opts: { archived?: boolean; purpose?: string } = {},
): string {
  const id = `scope-${scope}-${Date.now()}-${n++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: `A ${scope} session`,
    scope,
    ...(opts.purpose ? { purpose: opts.purpose } : {}),
  });
  if (opts.archived) sessionStore.setArchived(id, true);
  created.push(id);
  return id;
}

function liveInfo(id: string, messageCount = 1): LiveListInfo {
  return {
    kind: "assistant",
    sessionId: id,
    file: `/tmp/${id}.jsonl`,
    title: "Live before persistence",
    messageCount,
    isStreaming: true,
    awaitingInput: false,
    updatedAt: Date.now(),
  };
}

afterEach(() => {
  for (const id of created.splice(0)) sessionStore.remove(id);
});

test("the store's default read is the user's sessions; every other scope is an explicit ask", () => {
  const user = seed("user");
  const internal = seed("internal");
  const subagent = seed("subagent");

  const listed = new Set(sessionStore.list().map((row) => row.id));
  assert.ok(listed.has(user));
  assert.ok(!listed.has(internal), "internal stays server-only");
  assert.ok(!listed.has(subagent), "subagent is not a default-projection row");

  const all = new Set(sessionStore.list({ scopes: "all" }).map((r) => r.id));
  assert.ok(all.has(user) && all.has(internal) && all.has(subagent));
  const asked = new Set(
    sessionStore.list({ scopes: ["subagent"] }).map((r) => r.id),
  );
  assert.deepEqual(asked.has(subagent) && !asked.has(user), true);

  assert.equal(sessionStore.get(subagent)?.scope, "subagent");
  assert.equal(sessionStore.get(user)?.scope, "user");
});

test("scope is insert-only: no later write can reclassify a session", () => {
  const id = seed("subagent");

  // Omitting it preserves the stored scope …
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: "Renamed by a title refresh",
  });
  assert.equal(sessionStore.get(id)?.scope, "subagent");
  assert.equal(sessionStore.get(id)?.title, "Renamed by a title refresh");

  // … and so does STATING a different one: the first write owns the row, so a
  // stray metadata refresh cannot promote a subagent session into the user's.
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    scope: "user",
    title: "Still a subagent session",
  });
  assert.equal(sessionStore.get(id)?.scope, "subagent");
  assert.equal(sessionStore.get(id)?.title, "Still a subagent session");

  const user = seed("user");
  sessionStore.upsert({
    id: user,
    harness: "pi",
    agentType: "assistant",
    scope: "subagent",
  });
  assert.equal(sessionStore.get(user)?.scope, "user");
});

test("the live gate answers per candidate id and lets an unknown id through", () => {
  const user = seed("user");
  const internal = seed("internal");
  const subagent = seed("subagent");
  const unknown = `scope-unknown-${Date.now()}`;
  const gate = sessionStore.liveDefaultScopeGate([
    user,
    internal,
    subagent,
    unknown,
  ]);
  assert.equal(gate(user), true);
  assert.equal(gate(internal), false);
  assert.equal(gate(subagent), false);
  // No row at all: allowed, and `claimScope` is what makes that safe.
  assert.equal(gate(unknown), true);
});

test("claimScope persists the scope before a live registry may see the id", () => {
  const id = `scope-claim-${Date.now()}`;
  created.push(id);
  sessionStore.claimScope({
    id,
    harness: "pi",
    agentType: "assistant",
    scope: "subagent",
  });
  assert.equal(
    sessionStore.get(id)?.scope,
    "subagent",
    "the row exists the moment the claim returns",
  );
  assert.equal(sessionStore.liveDefaultScopeGate([id])(id), false);

  // Re-claiming the same scope is the ordinary reopen and stays quiet.
  sessionStore.claimScope({
    id,
    harness: "pi",
    agentType: "assistant",
    scope: "subagent",
  });

  // Registering it as anything else is a bug at the registration, not a
  // subagent session quietly appearing in the user's sidebar.
  assert.throws(
    () =>
      sessionStore.claimScope({ id, harness: "pi", agentType: "assistant" }),
    /persisted as subagent and cannot be registered as user/,
  );
  assert.throws(
    () =>
      sessionStore.claimScope({
        id,
        harness: "pi",
        agentType: "assistant",
        scope: "internal",
      }),
    /persisted as subagent and cannot be registered as internal/,
  );

  // A user session needs no row to be claimed: that IS the default.
  const fresh = `scope-claim-user-${Date.now()}`;
  sessionStore.claimScope({ id: fresh, harness: "pi", agentType: "assistant" });
  assert.equal(sessionStore.get(fresh), undefined);
});

test("the archived count matches the listable user's shelf only", async () => {
  const before = await archivedSessionCount();
  seed("subagent", { archived: true });
  seed("internal", { archived: true });
  seed("user", { archived: true });
  assert.equal(
    await archivedSessionCount(),
    before,
    "zero-message rows hidden from the archive are not counted",
  );
  const prompted = seed("user");
  sessionStore.upsert({
    id: prompted,
    harness: "pi",
    agentType: "assistant",
    messageCount: 2,
  });
  sessionStore.setArchived(prompted, true);
  assert.equal(await archivedSessionCount(), before + 1);
});

test("the session list excludes metadata-only sessions until a prompt exists", async () => {
  const id = seed("user");

  const persistedOnly = await listSessions([], () => 0);
  assert.ok(
    !persistedOnly.some((session) => session.id === id),
    "a zero-message metadata claim is not a conversation",
  );

  const emptyLive = await listSessions([liveInfo(id, 0)], () => 0);
  assert.ok(
    !emptyLive.some((session) => session.id === id),
    "merely acquiring the runtime does not make it listable",
  );

  const promptedLive = await listSessions([liveInfo(id)], () => 0);
  assert.equal(
    promptedLive.find((session) => session.id === id)?.messageCount,
    1,
  );

  const draftId = seed("user", { purpose: "draft" });
  const drafts = await listSessions([liveInfo(draftId, 0)], () => 0);
  assert.equal(
    drafts.find((session) => session.id === draftId)?.messageCount,
    1,
    "an explicit draft remains listed and routeable before send",
  );
});

test("the session list projects stored spawn provenance in one batch", async () => {
  const parent = seed("user");
  const child = seed("user");
  const legacyChild = seed("user");
  sessionStore.linkSpawned(parent, child);
  // A spawn edge written before ownership tracking existed: no metadata at all.
  sessionStore.linkSpawned(parent, legacyChild);
  getDb()
    .prepare(
      `UPDATE session_links SET metadata_json = NULL
        WHERE child_session_id = ? AND relation_type = 'spawned'`,
    )
    .run(legacyChild);

  const listed = async () =>
    new Map(
      (
        await listSessions(
          [liveInfo(parent), liveInfo(child), liveInfo(legacyChild)],
          () => 0,
        )
      ).map((session) => [session.id, session]),
    );

  let sessions = await listed();
  assert.equal(sessions.get(child)?.spawnedBySessionId, parent);
  assert.equal(sessions.get(child)?.spawnOwnership, "coordinator");
  assert.equal(sessions.get(parent)?.spawnedBySessionId, undefined);
  assert.equal(
    sessions.get(parent)?.spawnOwnership,
    undefined,
    "a coordinator is not itself a spawned child",
  );
  assert.equal(
    sessions.get(legacyChild)?.spawnOwnership,
    "unknown",
    "an untracked legacy edge fails closed rather than claiming coordinator ownership",
  );

  sessionStore.markSpawnedTakenOver(child, 1234);
  sessions = await listed();
  assert.equal(sessions.get(child)?.spawnedBySessionId, parent);
  assert.equal(sessions.get(child)?.spawnOwnership, "taken-over");
});

test("the session list excludes out-of-scope rows even while they are live", async () => {
  const user = seed("user");
  const subagent = seed("subagent");
  const internal = seed("internal");

  const sessions = await listSessions(
    [liveInfo(subagent), liveInfo(internal), liveInfo(user)],
    () => 0,
    { includeArchived: true },
  );
  const ids = new Set(sessions.map((session) => session.id));
  assert.ok(ids.has(user));
  assert.ok(
    !ids.has(subagent),
    "a running subagent session is still not listed",
  );
  assert.ok(!ids.has(internal));
  assert.equal(sessions.find((s) => s.id === user)?.scope, "user");

  // A live row with no persisted metadata at all is the user's by
  // construction: the scope is written before anything can register a session.
  const unpersisted = `scope-live-only-${Date.now()}`;
  const withLiveOnly = await listSessions([liveInfo(unpersisted)], () => 0);
  assert.ok(withLiveOnly.some((session) => session.id === unpersisted));
});

test("onlyIds projects just the named sessions, stored or live", async () => {
  const wanted = seed("user");
  sessionStore.upsert({
    id: wanted,
    harness: "pi",
    agentType: "assistant",
    messageCount: 2,
  });
  const other = seed("user");
  sessionStore.upsert({
    id: other,
    harness: "pi",
    agentType: "assistant",
    messageCount: 2,
  });
  const liveOnly = seed("user");

  const rows = await listSessions(
    [liveInfo(liveOnly), liveInfo(other)],
    () => 0,
    { onlyIds: new Set([wanted, liveOnly]) },
  );
  assert.deepEqual(rows.map((row) => row.id).sort(), [wanted, liveOnly].sort());
});
