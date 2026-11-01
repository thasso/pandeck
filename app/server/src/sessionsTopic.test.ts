/**
 * The `sessions` state topic (`sessionsTopic.ts`; `docs/session-list.md`):
 * V2 its events, V3 the test-mode audit, V5 the consistency races and the
 * cost of a flush.
 *   pnpm --filter @assistant/server test src/sessionsTopic.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { ClientMessage } from "@assistant/shared";
import { hub } from "./hub.ts";
import { getDb } from "./db/index.ts";
import { withChangeSet } from "./db/changeSet.ts";
import { permanentAssistantStore as pa } from "./db/permanentAssistantStore.ts";
import {
  sessionListRevisions,
  touchAllSessionRows,
  touchSessionRows,
} from "./db/sessionListChanges.ts";
import { sessionStore } from "./db/sessionStore.ts";
import * as list from "./harnesses/sessionList.ts";
import { piStore } from "./piSdk/piStore.ts";
import { recordDirectPeerChild } from "./peerSpawnRuntimes.ts";
import {
  resetSessionListAuditBaselineForTests,
  sessionsStateTopic,
} from "./sessionsTopic.ts";
import {
  failOnStateTopicInvariantsForTests,
  isStateTopicInvariant,
  takeStateTopicInvariantsForTests,
} from "./stateTopicKernel.ts";
import { publishSessionRowsNow } from "./stateTopics.ts";
import { sessionListClient } from "./test/sessionListClient.ts";

let serial = 0;
function seed(label: string, messageCount = 2): string {
  const id = `topic-${label}-${++serial}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    title: id,
    messageCount,
  });
  return id;
}

const raw = (sql: string, ...args: (string | number | null)[]) =>
  getDb()
    .prepare(sql)
    .run(...args);
const rawTitle = (id: string, title: string) =>
  raw("UPDATE session_index SET title = ? WHERE id = ?", title, id);
const rawArchive = (id: string, at: number | null) =>
  raw("UPDATE session_index SET archived_at_ms = ? WHERE id = ?", at, id);

const revision = (id: string) => sessionListRevisions([id]).get(id) ?? 0;

/** Flush whatever is pending; a recorded violation is read from the ledger. */
async function flush(): Promise<void> {
  await hub.flushPendingBroadcastsForTests().catch((err: unknown) => {
    if (!isStateTopicInvariant(err)) throw err;
  });
}

/** Touch an unrelated row and flush: the audit runs at that flush. */
async function unrelatedFlush(): Promise<void> {
  touchSessionRows([seed("unrelated")]);
  await flush();
}

/** Exactly one recorded violation, naming `id` (and `field`). */
function violation(id: string, field?: string): void {
  const recorded = takeStateTopicInvariantsForTests();
  assert.equal(recorded.length, 1, recorded.map((e) => e.message).join(" | "));
  assert.match(recorded[0]!.message, new RegExp(id));
  if (field) assert.match(recorded[0]!.message, new RegExp(field));
}

function clean(): void {
  assert.deepEqual(
    takeStateTopicInvariantsForTests().map((e) => e.message),
    [],
  );
}

beforeEach(async () => {
  resetSessionListAuditBaselineForTests();
  // The first audit run only captures: establish the baseline.
  await unrelatedFlush();
  clean();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetSessionListAuditBaselineForTests();
  await flush();
  takeStateTopicInvariantsForTests();
});

/* ------------------------------- V2: events ------------------------------- */

describe("events", () => {
  test("a live touched row upserts at its new revision, with no file", async () => {
    const id = seed("live");
    const client = sessionListClient();
    await flush();
    client.clear();
    const before = revision(id);
    sessionStore.markRead(id, Date.now() + 1_000);
    await flush();
    const [event] = client.events().flatMap((batch) => batch.events);
    assert.equal(event?.kind, "upsert");
    assert.equal(event?.id, id);
    assert.ok(event!.revision > before);
    assert.equal(event!.revision, revision(id));
    assert.ok(event?.kind === "upsert" && !("file" in event.item));
    client.close();
  });

  test("archive deletes, unarchive upserts, tombstone deletes", async () => {
    const id = seed("lifecycle");
    const client = sessionListClient();
    await flush();
    const kinds = () =>
      client
        .events()
        .flatMap((batch) => batch.events)
        .filter((event) => event.id === id)
        .map((event) => event.kind);
    client.clear();
    sessionStore.setArchived(id, true);
    await flush();
    sessionStore.setArchived(id, false);
    await flush();
    sessionStore.markDeleted(id);
    await flush();
    assert.deepEqual(kinds(), ["delete", "upsert", "delete"]);
    assert.equal(client.row(id), undefined);
    client.close();
  });

  test("the hidden singleton only ever travels as a delete", async () => {
    const id = seed("singleton");
    const previous = pa.sessionId();
    const client = sessionListClient();
    try {
      pa.setSessionId(id);
      await flush();
      client.clear();
      sessionStore.markRead(id, Date.now() + 1_000);
      touchSessionRows([id]);
      await flush();
      const events = client.events().flatMap((batch) => batch.events);
      assert.ok(events.some((e) => e.id === id && e.kind === "delete"));
      assert.ok(!events.some((e) => e.id === id && e.kind === "upsert"));
    } finally {
      if (previous) pa.setSessionId(previous);
      else pa.clearSessionId();
      client.close();
    }
  });

  test("one-row refreshes hide an unbound PA persona while ordinary rows stay public", async () => {
    const [hidden, ordinary] = [seed("persona"), seed("ordinary")];
    sessionStore.upsert({
      id: hidden,
      harness: "pi",
      agentType: "personal-assistant",
    });
    const client = sessionListClient();
    try {
      await flush();
      client.clear();
      touchSessionRows([hidden, ordinary]);
      await flush();
      const events = client.events().flatMap((batch) => batch.events);
      assert.ok(
        events.some((event) => event.id === hidden && event.kind === "delete"),
      );
      assert.ok(
        !events.some((event) => event.id === hidden && event.kind === "upsert"),
      );
      const row = events.find((event) => event.id === ordinary);
      assert.ok(row?.kind === "upsert");
      assert.equal("file" in row.item, false);
    } finally {
      client.close();
    }
  });

  test("a recorded zero-message child is a member, a zero-message non-draft is not", async () => {
    const parent = seed("parent");
    const child = seed("child", 0);
    const empty = seed("empty", 0);
    const client = sessionListClient();
    await flush();
    client.clear();
    recordDirectPeerChild({
      childSessionId: child,
      spawnerSessionId: parent,
      costClass: "counted",
      source: { kind: "profile", profileId: "test-profile" },
      provider: "test",
      modelId: "test",
      thinkingLevel: "off",
      credentialProfileId: "test-profile",
      createdAt: Date.now(),
    });
    touchSessionRows([empty]);
    await flush();
    assert.ok(client.row(child), "the child upserts");
    assert.equal(client.row(empty), undefined);
    assert.ok(client.deleted().includes(empty));
    client.close();
  });

  test("a live-only pi row with no index row upserts once touched", async () => {
    const id = `topic-live-only-${++serial}`;
    const client = sessionListClient();
    await flush();
    client.clear();
    const listInfo = piStore.listInfo.bind(piStore);
    vi.spyOn(piStore, "listInfo").mockImplementation(() => [
      ...listInfo(),
      {
        kind: "assistant",
        sessionId: id,
        file: `/tmp/${id}.jsonl`,
        title: "Live only",
        messageCount: 2,
        isStreaming: false,
        awaitingInput: false,
        updatedAt: Date.now(),
      },
    ]);
    touchSessionRows([id]);
    await flush();
    assert.deepEqual(client.upserted(), [id]);
    assert.equal(client.row(id)?.title, "Live only");
    vi.restoreAllMocks();
    touchSessionRows([id]);
    await flush();
    client.close();
  });

  test("repeated touches of a non-member delete at increasing revisions", async () => {
    const id = seed("non-member", 0);
    const client = sessionListClient();
    await flush();
    client.clear();
    touchSessionRows([id]);
    await flush();
    touchSessionRows([id]);
    await flush();
    const deletes = client
      .events()
      .flatMap((batch) => batch.events)
      .filter((event) => event.id === id);
    assert.deepEqual(
      deletes.map((event) => event.kind),
      ["delete", "delete"],
    );
    assert.ok(deletes[1]!.revision > deletes[0]!.revision);
    client.close();
  });

  test("the snapshot carries the live rows, their revisions and the archived count", async () => {
    const [live, archived] = [seed("snap-live"), seed("snap-archived")];
    sessionStore.setArchived(archived, true);
    await flush();
    const client = sessionListClient();
    const snapshot = client.sent.find((m) => m.type === "sessionList");
    assert.ok(snapshot?.type === "sessionList");
    assert.ok(snapshot.sessions.some((row) => row.id === live));
    assert.ok(!snapshot.sessions.some((row) => row.id === archived));
    assert.ok(snapshot.sessions.every((row) => !("file" in row)));
    assert.deepEqual(
      snapshot.revisions.find((entry) => entry.id === live),
      { id: live, revision: revision(live) },
    );
    assert.equal(snapshot.archivedSessionCount, hub.archivedSessionCount());
    client.close();
  });
});

/* -------------------------------- V3: audit -------------------------------- */

describe("the test-mode audit", () => {
  test("(a) a raw edit of a live row", async () => {
    const id = seed("a");
    await unrelatedFlush();
    rawTitle(id, "edited behind its back");
    await unrelatedFlush();
    violation(id, "title");
  });

  test("(b) a new live member inserted with no touch", async () => {
    await unrelatedFlush();
    const id = `topic-b-${++serial}`;
    const now = Date.now();
    raw(
      "INSERT INTO session_index (id, scope, harness, agent_type, title, created_at_ms, updated_at_ms, message_count) VALUES (?, 'user', 'pi', 'assistant', ?, ?, ?, 2)",
      id,
      id,
      now,
      now,
    );
    await unrelatedFlush();
    violation(id, "added");
  });

  test("(c) a return from non-membership: a raw unarchive, a raw unbinding", async () => {
    const id = seed("c");
    sessionStore.setArchived(id, true);
    await unrelatedFlush();
    rawArchive(id, null);
    await unrelatedFlush();
    violation(id, "archived");
    // A violation leaves the baseline as it was; start the second case clean.
    resetSessionListAuditBaselineForTests();
    await unrelatedFlush();

    const bound = seed("c-bound");
    const previous = pa.sessionId();
    pa.setSessionId(bound);
    try {
      await unrelatedFlush();
      raw(
        "UPDATE permanent_assistant_state SET session_id = NULL WHERE singleton_id = 1",
      );
      await unrelatedFlush();
      violation(bound, "added");
    } finally {
      if (previous) pa.setSessionId(previous);
      else pa.clearSessionId();
    }
  });

  test("(d) a disappearance: a raw archive", async () => {
    const id = seed("d");
    await unrelatedFlush();
    rawArchive(id, Date.now());
    await unrelatedFlush();
    violation(id, "archived");
  });

  test("(e) an archived row edited with no global touch pending", async () => {
    const id = seed("e");
    sessionStore.setArchived(id, true);
    await unrelatedFlush();
    rawTitle(id, "archived and edited");
    await unrelatedFlush();
    violation(id, "title");
  });

  test("(f) the same changes through their reporters record nothing", async () => {
    const [a, c, d, e] = [seed("fa"), seed("fc"), seed("fd"), seed("fe")];
    sessionStore.setArchived(c, true);
    sessionStore.setArchived(e, true);
    await unrelatedFlush();
    sessionStore.upsert({
      id: a,
      harness: "pi",
      agentType: "developer",
      title: "renamed",
    });
    seed("fb");
    sessionStore.setArchived(c, false);
    sessionStore.setArchived(d, true);
    sessionStore.upsert({
      id: e,
      harness: "pi",
      agentType: "developer",
      title: "archived rename",
    });
    await unrelatedFlush();
    clean();
  });

  test("(g) a reported new member and a touch-before-change clock boundary record nothing", async () => {
    await unrelatedFlush();
    seed("g");
    const id = seed("g-clock");
    await unrelatedFlush();
    // A clock boundary touches first, then changes the input.
    touchSessionRows([id]);
    rawTitle(id, "after the boundary touch");
    await unrelatedFlush();
    clean();
  });

  test("(h) an archived row's trivial change while a global touch is pending is excused", async () => {
    const id = seed("h");
    sessionStore.setArchived(id, true);
    await unrelatedFlush();
    touchAllSessionRows("test global");
    rawTitle(id, "global trigger change");
    await flush();
    clean();
  });

  test("(i) after the delivered global publication the excuse is over", async () => {
    const live = seed("i-live");
    const archived = seed("i-archived");
    sessionStore.setArchived(archived, true);
    await unrelatedFlush();
    touchAllSessionRows("test global");
    await flush();
    clean();
    rawTitle(live, "edited after the global publication");
    rawTitle(archived, "archived edit after it");
    await unrelatedFlush();
    const recorded = takeStateTopicInvariantsForTests();
    assert.equal(recorded.length, 1);
    assert.match(recorded[0]!.message, new RegExp(live));
    assert.match(recorded[0]!.message, new RegExp(archived));
  });

  test("(j) a raw unarchive while a global touch is pending is still recorded", async () => {
    const id = seed("j");
    sessionStore.setArchived(id, true);
    await unrelatedFlush();
    touchAllSessionRows("test global");
    rawArchive(id, null);
    await flush();
    violation(id, "archived");
  });

  test.each(["archive", "tombstone", "disappear", "appear"] as const)(
    "(j) a global stamp does not report a raw %s transition",
    async (kind) => {
      const id = seed(`j-${kind}`, kind === "appear" ? 0 : 2);
      await unrelatedFlush();
      touchAllSessionRows("test global");
      if (kind === "archive") rawArchive(id, Date.now());
      else if (kind === "tombstone")
        raw(
          "UPDATE session_index SET deleted_at_ms = ? WHERE id = ?",
          Date.now(),
          id,
        );
      else
        raw(
          "UPDATE session_index SET message_count = ? WHERE id = ?",
          kind === "appear" ? 2 : 0,
          id,
        );
      await flush();
      violation(id);
    },
  );

  test("explicit transitions before and after repeated global stamps are reported", async () => {
    const [before, after, appeared] = [
      seed("j-before"),
      seed("j-after"),
      seed("j-appeared", 0),
    ];
    await unrelatedFlush();
    sessionStore.setArchived(before, true);
    touchAllSessionRows("first global");
    sessionStore.setArchived(after, true);
    sessionStore.upsert({
      id: appeared,
      harness: "pi",
      agentType: "developer",
      messageCount: 2,
    });
    touchAllSessionRows("second global");
    await flush();
    clean();
  });

  test("a rolled-back explicit touch cannot legitimise a global-only transition", async () => {
    const id = seed("j-rollback");
    await unrelatedFlush();
    touchAllSessionRows("test global");
    getDb().exec("BEGIN");
    touchSessionRows([id]);
    getDb().exec("ROLLBACK");
    rawArchive(id, Date.now());
    await flush();
    violation(id, "archived");
  });

  test.each(["before", "after"] as const)(
    "an explicit transition %s a global stamp in the same change set is reported",
    async (order) => {
      const id = seed(`j-same-${order}`);
      await unrelatedFlush();
      withChangeSet(() => {
        if (order === "before") sessionStore.setArchived(id, true);
        touchAllSessionRows("same transaction");
        if (order === "after") sessionStore.setArchived(id, true);
      });
      await flush();
      clean();
    },
  );

  test("a rolled-back second global stamp preserves the first stamp's provenance", async () => {
    const id = seed("j-global-rollback");
    await unrelatedFlush();
    touchAllSessionRows("committed global");
    assert.throws(
      () =>
        withChangeSet(() => {
          touchAllSessionRows("rolled-back global");
          throw new Error("rollback");
        }),
      /rollback/,
    );
    rawArchive(id, Date.now());
    await flush();
    violation(id, "archived");
  });

  test("unbinding a hidden row during a global window is an unreported appearance", async () => {
    const id = seed("j-unbound");
    const previous = pa.sessionId();
    pa.setSessionId(id);
    try {
      await unrelatedFlush();
      touchAllSessionRows("hidden global");
      raw(
        "UPDATE permanent_assistant_state SET session_id = NULL WHERE singleton_id = 1",
      );
      await flush();
      violation(id, "added");
    } finally {
      if (previous) pa.setSessionId(previous);
      else pa.clearSessionId();
    }
  });

  test("(k) a raw edit after a delivered publication of the same row is recorded", async () => {
    const id = seed("k");
    await unrelatedFlush();
    sessionStore.markRead(id, Date.now() + 1_000);
    await flush();
    rawTitle(id, "edited after its own publication");
    await unrelatedFlush();
    violation(id, "title");

    resetSessionListAuditBaselineForTests();
    await unrelatedFlush();
    touchAllSessionRows("test global");
    await flush();
    clean();
    rawTitle(id, "edited after the global publication");
    await unrelatedFlush();
    violation(id, "title");
  });

  test("(l) a failed send rebaselines nothing; a republish is excused, an unreported edit is not", async () => {
    const [failed, other] = [seed("l-failed"), seed("l-other")];
    const client = sessionListClient();
    await unrelatedFlush();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const send = client.connection.send.bind(client.connection);
    vi.spyOn(client.connection, "send").mockImplementationOnce(() => {
      throw new Error("injected send failure");
    });
    touchSessionRows([failed]);
    await flush();
    vi.mocked(client.connection.send).mockImplementation(send);
    clean();
    rawTitle(failed, "republished");
    touchSessionRows([failed]);
    rawTitle(other, "unreported");
    await unrelatedFlush();
    violation(other, "title");
    client.close();
  });

  test.each(["read", "send"] as const)(
    "a failed %s does not capture a retained id before its delivered retry",
    async (failure) => {
      const id = seed(`retained-${failure}`);
      const client = sessionListClient();
      try {
        await unrelatedFlush();
        vi.spyOn(console, "error").mockImplementation(() => {});
        if (failure === "send")
          vi.spyOn(client.connection, "send").mockImplementationOnce(() => {
            throw new Error("injected send failure");
          });
        else {
          const original = list.mergedSessionList;
          let failed = false;
          vi.spyOn(list, "mergedSessionList").mockImplementation(
            (opts = {}) => {
              if (opts.onlyIds && !failed) {
                failed = true;
                throw new Error("injected read failure");
              }
              return original(opts);
            },
          );
        }
        touchSessionRows([id]);
        await flush();
        clean();
        rawTitle(id, "still covered by the retained touch");
        await unrelatedFlush();
        clean();
        assert.equal(
          client.row(id)?.title,
          "still covered by the retained touch",
        );
        rawTitle(id, "after delivered retry");
        await unrelatedFlush();
        violation(id, "title");
      } finally {
        client.close();
      }
    },
  );

  test("the command boundary: the reply resolves, the ledger holds the violation", async () => {
    const [capped, quiet] = [seed("cmd-cap"), seed("cmd-quiet")];
    const client = sessionListClient();
    await unrelatedFlush();
    rawTitle(quiet, "unreported");
    await client.connection.handle({
      type: "setSessionPeerTurnCap",
      sessionId: capped,
      cap: 7,
    });
    violation(quiet, "title");
    resetSessionListAuditBaselineForTests();
    await unrelatedFlush();

    rawTitle(quiet, "unreported again");
    await client.connection.handle({
      type: "createDraftSession",
      agentType: "assistant",
      draftText: "draft",
    } as ClientMessage);
    await flush();
    violation(quiet, "title");
    client.close();
  });

  test.each(["snapshot", "items"] as const)(
    "a %s read after an unreported change records and throws",
    async (path) => {
      const id = seed(path);
      await unrelatedFlush();
      rawTitle(id, "unreported");
      assert.throws(
        () =>
          path === "snapshot"
            ? sessionsStateTopic.subscribeAnswer(false)
            : sessionsStateTopic.items([id]),
        (err: unknown) => isStateTopicInvariant(err),
      );
      violation(id, "title");
    },
  );

  test("the error surfaces from direct publication and a fake-timer flush, ids kept", async () => {
    const [id, touched] = [seed("timer"), seed("timer-touched")];
    const client = sessionListClient();
    await unrelatedFlush();
    client.clear();
    rawTitle(id, "unreported");
    touchSessionRows([touched]);
    assert.throws(() => publishSessionRowsNow(), isStateTopicInvariant);
    violation(id, "title");
    assert.deepEqual(client.upserted(), []);

    vi.useFakeTimers();
    try {
      touchSessionRows([seed("timer-2")]);
      assert.throws(() => vi.advanceTimersByTime(1_000), isStateTopicInvariant);
      violation(id, "title");
    } finally {
      vi.useRealTimers();
    }
    // Repair by a report: the kept ids publish with it.
    touchSessionRows([id]);
    await flush();
    clean();
    assert.ok(client.upserted().includes(touched));
    client.close();
  });

  test("an unconsumed violation fails the ledger hook", async () => {
    const id = seed("hook");
    await unrelatedFlush();
    rawTitle(id, "unreported");
    await unrelatedFlush();
    assert.throws(() => failOnStateTopicInvariantsForTests(), new RegExp(id));
    clean();
  });

  test("a module reset: the re-imported audit's violation is this instance's", async () => {
    const id = seed("reset");
    vi.resetModules();
    const other =
      (await import("./sessionsTopic.ts")) as typeof import("./sessionsTopic.ts");
    // Its first snapshot captures its own baseline; the second sees the edit.
    other.sessionsStateTopic.subscribeAnswer(false);
    rawTitle(id, "edited under a re-imported module");
    let thrown: unknown;
    try {
      other.sessionsStateTopic.subscribeAnswer(false);
    } catch (err) {
      thrown = err;
    }
    assert.ok(isStateTopicInvariant(thrown), "this instance knows its brand");
    assert.throws(() => failOnStateTopicInvariantsForTests(), new RegExp(id));
    clean();
    // Restore what the baseline here expects.
    touchSessionRows([id]);
    await flush();
    clean();
  });
});

/* ------------------------------ V5: races ------------------------------ */

describe("consistency races", () => {
  test("a subscribe between a stamp and its flush returns the new row; the event repeats it", async () => {
    const id = seed("race");
    await flush();
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "developer",
      title: "new content",
    });
    const client = sessionListClient();
    assert.equal(client.row(id)?.title, "new content");
    const snapshot = client.sent.find((m) => m.type === "sessionList");
    assert.ok(snapshot?.type === "sessionList");
    const snapRevision = snapshot.revisions.find((e) => e.id === id)?.revision;
    await flush();
    const event = client
      .events()
      .flatMap((b) => b.events)
      .find((e) => e.id === id);
    assert.equal(event?.revision, snapRevision);
    assert.equal(client.row(id)?.title, "new content");
    client.close();
  });

  test("a rolled-back in-transaction stamp publishes the id once, at its committed revision", async () => {
    const id = seed("rollback");
    await flush();
    const committed = revision(id);
    const db = getDb();
    db.exec("BEGIN");
    touchSessionRows([id]);
    db.exec("ROLLBACK");
    assert.equal(revision(id), committed);
    const client = sessionListClient();
    client.clear();
    await flush();
    const events = client
      .events()
      .flatMap((b) => b.events)
      .filter((e) => e.id === id);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.revision, committed);
    client.close();
  });
});

/* -------------------------------- cost -------------------------------- */

test("one flush with N touched ids builds rows once, bounded to those ids", async () => {
  const ids = [seed("cost-1"), seed("cost-2"), seed("cost-3")];
  await flush();
  const build = vi.spyOn(list, "mergedSessionList");
  touchSessionRows(ids);
  await flush();
  const bounded = build.mock.calls.filter(([opts]) => opts?.onlyIds);
  // The topic's batch build, then the unread listener's one-row build when
  // the singleton moved (not here).
  assert.equal(bounded.length, 1);
  assert.deepEqual([...bounded[0]![0]!.onlyIds!].sort(), [...ids].sort());
  const plan = getDb()
    .prepare(
      "EXPLAIN QUERY PLAN INSERT INTO session_list_revisions (session_id, revision) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision",
    )
    .all("x", 1) as { detail: string }[];
  assert.ok(
    plan.every((step) => !/SCAN session_list_revisions/.test(step.detail)),
  );
});
