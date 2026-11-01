/**
 * V4: the `sessions` topic's production sweep (`sessionsTopic.ts`;
 * `docs/session-list.md`, "Audit"). The per-flush audit is off, as in
 * production; the sweep logs and repairs what no writer reported, and the
 * global publication checks before it recaptures.
 *   pnpm --filter @assistant/server test src/sessionsTopicSweep.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { hub } from "./hub.ts";
import { getDb } from "./db/index.ts";
import { permanentAssistantStore as pa } from "./db/permanentAssistantStore.ts";
import {
  touchAllSessionRows,
  touchSessionRows,
} from "./db/sessionListChanges.ts";
import { sessionStore } from "./db/sessionStore.ts";
import * as list from "./harnesses/sessionList.ts";
import {
  captureSessionListBaseline,
  resetSessionListAuditBaselineForTests,
  setSessionListAuditForTests,
  startSessionListSweep,
  sweepSessionRows,
} from "./sessionsTopic.ts";
import { takeStateTopicInvariantsForTests } from "./stateTopicKernel.ts";
import { sessionListClient } from "./test/sessionListClient.ts";

let serial = 0;
function seed(label: string): string {
  const id = `sweep-${label}-${++serial}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    title: id,
    messageCount: 2,
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
function rawMember(): string {
  const id = `sweep-raw-${++serial}`;
  const now = Date.now();
  raw(
    "INSERT INTO session_index (id, scope, harness, agent_type, title, created_at_ms, updated_at_ms, message_count) VALUES (?, 'user', 'pi', 'assistant', ?, ?, ?, 2)",
    id,
    id,
    now,
    now,
  );
  return id;
}

let warn: { mock: { calls: unknown[][] }; mockClear(): void };

/** The ids the repair logged since the last call. */
function logged(): string[] {
  const ids = warn.mock.calls
    .map((call) => /unreported row change: (\S+)/.exec(String(call[0]))?.[1])
    .filter((id): id is string => id !== undefined);
  warn.mockClear();
  return ids;
}

const flush = () => hub.flushPendingBroadcastsForTests();
async function sweep(): Promise<void> {
  sweepSessionRows();
  await flush();
}

beforeEach(async () => {
  setSessionListAuditForTests(false);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  touchSessionRows([seed("settle")]);
  await flush();
  captureSessionListBaseline();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setSessionListAuditForTests(true);
  resetSessionListAuditBaselineForTests();
  await flush();
  assert.deepEqual(takeStateTopicInvariantsForTests(), []);
});

describe("the production sweep", () => {
  test("logs each unreported kind once, re-stamps it and the client sees it", async () => {
    const [edited, unarchived, unbound, archived, archivedEdit] = [
      seed("a"),
      seed("c"),
      seed("c-bound"),
      seed("d"),
      seed("e"),
    ];
    sessionStore.setArchived(unarchived, true);
    sessionStore.setArchived(archivedEdit, true);
    const previous = pa.sessionId();
    pa.setSessionId(unbound);
    const client = sessionListClient();
    try {
      await flush();
      captureSessionListBaseline();
      client.clear();
      rawTitle(edited, "a: edited");
      const member = rawMember();
      rawArchive(unarchived, null);
      raw(
        "UPDATE permanent_assistant_state SET session_id = NULL WHERE singleton_id = 1",
      );
      rawArchive(archived, Date.now());
      rawTitle(archivedEdit, "e: archived edit");
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      });
      const stop = startSessionListSweep();
      await vi.advanceTimersByTimeAsync(60_000 + 1_000);
      const expected = [
        edited,
        member,
        unarchived,
        unbound,
        archived,
        archivedEdit,
      ];
      assert.deepEqual(logged().sort(), [...expected].sort());
      assert.equal(client.row(edited)?.title, "a: edited");
      for (const id of [member, unarchived, unbound])
        assert.ok(client.row(id), `${id} appeared`);
      assert.ok(client.deleted().includes(archived));
      await vi.advanceTimersByTimeAsync(60_000 + 1_000);
      assert.deepEqual(logged(), [], "repaired, so not logged again");
      stop();
    } finally {
      if (previous) pa.setSessionId(previous);
      else pa.clearSessionId();
      client.close();
    }
  });

  test("the reviewer's timeline: a global publication, then a raw edit and a raw member", async () => {
    const live = seed("timeline");
    const client = sessionListClient();
    await flush();
    captureSessionListBaseline();
    // 2: a reminder-limit global touch stamps L, and its flush is delivered.
    touchAllSessionRows("reminder-limit");
    await flush();
    assert.deepEqual(logged(), []);
    // 3: a raw edit of L and an unreported new member.
    rawTitle(live, "J2");
    const member = rawMember();
    client.clear();
    // 4: the first sweep logs both, and their upserts reach the client.
    await sweep();
    assert.deepEqual(logged().sort(), [live, member].sort());
    assert.equal(client.row(live)?.title, "J2");
    assert.ok(client.row(member));
    // 5: a second sweep logs nothing.
    await sweep();
    assert.deepEqual(logged(), []);
    client.close();
  });

  test("an archived-only trivial change at a global touch is excused until its publication", async () => {
    const id = seed("archived-trivial");
    sessionStore.setArchived(id, true);
    await flush();
    captureSessionListBaseline();
    touchAllSessionRows("reminder-limit");
    rawTitle(id, "trivial global-trigger change");
    await flush();
    await sweep();
    assert.deepEqual(logged(), []);
    rawTitle(id, "edited after the publication");
    await sweep();
    assert.deepEqual(logged(), [id]);
  });

  test("a failed global flush keeps the excuse until a delivered retry checks and recaptures", async () => {
    const [archived, live] = [seed("failed-archived"), seed("failed-live")];
    sessionStore.setArchived(archived, true);
    await flush();
    captureSessionListBaseline();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const original = list.mergedSessionList;
    let fail = true;
    vi.spyOn(list, "mergedSessionList").mockImplementation((opts = {}) => {
      if (fail && opts.onlyIds) throw new Error("injected read failure");
      return original(opts);
    });
    touchAllSessionRows("reminder-limit");
    rawTitle(archived, "trivial while pending");
    await flush();
    fail = false;
    // Still pending: the delivered retry's check excuses the archived row,
    // but sees an edit of a live row made after the stamp it was owed.
    rawTitle(live, "unstamped after the global stamp");
    touchSessionRows([seed("retry")]);
    await flush();
    assert.deepEqual(logged(), []);
    // The recapture happened: a later raw edit is caught by the sweep.
    rawTitle(live, "after the recapture");
    await sweep();
    assert.deepEqual(logged(), [live]);
  });

  test("a retained id (summaries failing once) is retried by the sweep, not logged", async () => {
    const id = seed("retained");
    const client = sessionListClient();
    await flush();
    client.clear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const original = list.mergedSessionList;
    let fail = true;
    vi.spyOn(list, "mergedSessionList").mockImplementation((opts = {}) => {
      if (fail && opts.onlyIds) throw new Error("injected read failure");
      return original(opts);
    });
    sessionStore.markRead(id, Date.now() + 5_000);
    await flush();
    assert.deepEqual(client.upserted(), []);
    fail = false;
    await sweep();
    assert.deepEqual(logged(), []);
    assert.deepEqual(client.upserted(), [id]);
    client.close();
  });

  test("drift between the boot touch and the first sweep is caught by it", async () => {
    const id = seed("boot");
    await flush();
    touchAllSessionRows("boot");
    captureSessionListBaseline();
    await flush();
    rawTitle(id, "drift after boot");
    await sweep();
    assert.deepEqual(logged(), [id]);
  });
});
