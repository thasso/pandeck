import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "session-view-lifecycle-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { Connection } = await import("./connection.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { backgroundWorkStore } = await import("./db/backgroundWorkStore.ts");
const { BACKGROUND_WORK_SNAPSHOT_MAX, backgroundWorkSnapshot } =
  await import("./backgroundWorkRegistry.ts");
const { hub } = await import("./hub.ts");
const { getDb, withDbTransaction } = await import("./db/index.ts");

interface SentMessage {
  type: string;
  sessionId?: string;
  message?: string;
}

function connectionViewing(id: string) {
  const sent: SentMessage[] = [];
  let detached = 0;
  let removed = 0;
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(JSON.parse(payload) as SentMessage),
  };
  const conn = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs);
  conn.viewing = {
    sessionId: id,
    kind: "assistant",
    removeViewer: () => {
      removed += 1;
    },
  };
  conn.runtimeView = {
    detach: () => {
      detached += 1;
    },
  };
  return {
    conn: conn as unknown as {
      onArchiveSession: (id: string, archived: boolean) => Promise<void>;
      onDeleteSession: (id: string) => Promise<void>;
      viewing?: unknown;
    },
    sent,
    detached: () => detached,
    removed: () => removed,
  };
}

function seed(id: string): void {
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: "Prompted session",
    messageCount: 2,
  });
}

function assertViewCleared(
  result: ReturnType<typeof connectionViewing>,
  id: string,
): void {
  assert.equal(result.conn.viewing, undefined);
  assert.equal(result.detached(), 1);
  assert.equal(result.removed(), 1);
  assert.ok(
    result.sent.some(
      (message) =>
        message.type === "sessionViewCleared" && message.sessionId === id,
    ),
  );
  assert.equal(
    sessionStore.list({ scopes: "all" }).filter((row) => row.messageCount === 0)
      .length,
    0,
    "closing the view must not create an empty replacement session",
  );
}

test("archiving the viewed session clears the view without creating a replacement", async () => {
  const id = "archive-viewed";
  seed(id);
  const result = connectionViewing(id);

  await result.conn.onArchiveSession(id, true);

  assertViewCleared(result, id);
  assert.equal(sessionStore.get(id)?.archivedAt !== undefined, true);
});

test("deleting the viewed session clears the view without creating a replacement", async () => {
  const id = "delete-viewed";
  seed(id);
  const result = connectionViewing(id);

  await result.conn.onDeleteSession(id);

  assertViewCleared(result, id);
  assert.ok(
    sessionStore
      .list({ scopes: "all", includeDeleted: true })
      .find((row) => row.id === id)?.deletedAt,
  );
});

test("deleting a session with live background work is refused, not silently orphaning it", async () => {
  const id = "delete-background-owner";
  seed(id);
  backgroundWorkStore.reserveItem({
    ownerSessionId: id,
    backend: "host-process",
    kind: "shell",
    label: "pnpm run watch",
    sourceRequestId: "delete-guard-1",
    lifetimeMs: 60_000,
    settingsGeneration: 1,
    bootEpoch: "boot-delete-guard",
    ownerLimit: 1_000,
  });
  const result = connectionViewing(id);

  await result.conn.onDeleteSession(id);

  // Deleting would leave a real process running with no owner to show or stop
  // it, so the user is told to stop it first and the session survives.
  const error = result.sent.find((message) => message.type === "error");
  assert.match(
    error?.message ?? "",
    /background process running\. Stop it first\./,
  );
  assert.equal(sessionStore.get(id)?.deletedAt, undefined);
  assert.equal(result.conn.viewing !== undefined, true);

  // Once the work is terminal the ordinary delete goes through.
  for (const item of backgroundWorkStore.listItems({
    ownerSessionId: id,
    state: "active",
  }))
    backgroundWorkStore.terminalize({ itemId: item.id, state: "completed" });
  await result.conn.onDeleteSession(id);
  assert.ok(
    sessionStore
      .list({ scopes: "all", includeDeleted: true })
      .find((row) => row.id === id)?.deletedAt,
  );
});

let backgroundSerial = 0;
function finishedBackgroundWork(ownerSessionId: string): string {
  backgroundSerial += 1;
  const item = backgroundWorkStore.reserveItem({
    ownerSessionId,
    backend: "host-process",
    kind: "shell",
    label: "pnpm run build",
    sourceRequestId: `delete-history-${backgroundSerial}`,
    lifetimeMs: 60_000,
    settingsGeneration: 1,
    bootEpoch: "boot-delete-history",
    ownerLimit: 1_000,
  });
  backgroundWorkStore.terminalize({ itemId: item.id, state: "completed" });
  return item.id;
}

/**
 * `count` finished rows for one owner at the cost of one: the store writes the
 * first, and one transaction clones it under fresh ids. The clones carry that
 * row's revision, as rows stamped by a single write do. Store writes commit one
 * at a time (~4 ms each), which made 1,200 of them a 10 s seed.
 */
function seedFinishedHistory(ownerSessionId: string, count: number): string[] {
  const template = backgroundWorkStore.getItem(
    finishedBackgroundWork(ownerSessionId),
  )!;
  const ids = [template.id];
  withDbTransaction(() => {
    const row = getDb()
      .prepare("SELECT * FROM background_work_items WHERE id = ?")
      .get(template.id) as Record<string, unknown>;
    const columns = Object.keys(row);
    const insert = getDb().prepare(
      `INSERT INTO background_work_items (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    );
    for (let index = 1; index < count; index += 1) {
      const id = `${template.id}-clone-${index}`;
      insert.run(
        ...(columns.map((column) =>
          column === "id"
            ? id
            : column === "source_request_id"
              ? `${String(row.source_request_id)}-clone-${index}`
              : row[column],
        ) as never[]),
      );
      ids.push(id);
    }
  });
  return ids;
}

/** Every `background` state event a connected client receives meanwhile. */
function watchBackgroundEvents() {
  const events: Array<{ id: string; kind: string; revision: number }> = [];
  const batches: Array<{ seq: number; size: number }> = [];
  const viewer = {
    send: (message: {
      type: string;
      topic?: string;
      seq?: number;
      events?: typeof events;
    }): void => {
      if (message.type !== "stateEvents" || message.topic !== "background")
        return;
      events.push(...(message.events ?? []));
      batches.push({ seq: message.seq!, size: message.events?.length ?? 0 });
    },
    wantsTopic: (topic: string) => topic === "background",
  };
  hub.register(viewer as never);
  return {
    events,
    batches,
    flushed: () => new Promise((resolve) => setTimeout(resolve, 60)),
    stop: () => hub.unregister(viewer as never),
  };
}

test("deleting a session tombstones its background history and broadcasts deletes for exactly those rows", async () => {
  const id = "delete-background-history";
  const other = "delete-background-bystander";
  seed(id);
  seed(other);
  const owned = [finishedBackgroundWork(id), finishedBackgroundWork(id)];
  const bystander = finishedBackgroundWork(other);
  const watch = watchBackgroundEvents();
  try {
    await watch.flushed();
    watch.events.length = 0;

    await connectionViewing(id).conn.onDeleteSession(id);
    await watch.flushed();

    assert.deepEqual(
      watch.events.map((event) => [event.id, event.kind]).sort(),
      owned.map((itemId) => [itemId, "delete"]).sort(),
    );
    for (const event of watch.events)
      assert.equal(
        event.revision,
        backgroundWorkStore.itemRevisions([event.id])[0]?.revision,
      );
    // A fresh subscribe no longer lists them; the bystander's row is intact.
    const listed = backgroundWorkSnapshot().items.map((item) => item.id);
    for (const itemId of owned) assert.equal(listed.includes(itemId), false);
    assert.equal(listed.includes(bystander), true);
    // Membership only: the rows themselves stay.
    for (const itemId of owned)
      assert.equal(backgroundWorkStore.getItem(itemId, true)?.id, itemId);
  } finally {
    watch.stop();
  }
});

test("archiving a session keeps its background history", async () => {
  const id = "archive-background-history";
  seed(id);
  const itemId = finishedBackgroundWork(id);
  const before = backgroundWorkStore.getItem(itemId)!.revision;

  await connectionViewing(id).conn.onArchiveSession(id, true);

  assert.equal(sessionStore.get(id)?.archivedAt !== undefined, true);
  assert.equal(backgroundWorkStore.getItem(itemId)?.revision, before);
});

test("work admitted after the delete's projection read still refuses the delete", async () => {
  const id = "delete-background-race";
  seed(id);
  const history = finishedBackgroundWork(id);
  // The projection says the session is idle; work starts while it is read.
  const listSessions = hub.listSessions.bind(hub);
  hub.listSessions = (async (...args: Parameters<typeof listSessions>) => {
    const listed = await listSessions(...args);
    hub.listSessions = listSessions;
    backgroundWorkStore.reserveItem({
      ownerSessionId: id,
      backend: "host-process",
      kind: "shell",
      label: "pnpm run watch",
      sourceRequestId: "delete-race-1",
      lifetimeMs: 60_000,
      settingsGeneration: 1,
      bootEpoch: "boot-delete-race",
      ownerLimit: 1_000,
    });
    return listed;
  }) as typeof hub.listSessions;
  const result = connectionViewing(id);
  try {
    await result.conn.onDeleteSession(id);
  } finally {
    hub.listSessions = listSessions;
  }

  const error = result.sent.find((message) => message.type === "error");
  assert.match(
    error?.message ?? "",
    /background work is still running\. Stop it first\./,
  );
  assert.equal(sessionStore.get(id)?.deletedAt, undefined);
  assert.equal(result.conn.viewing !== undefined, true);
  assert.equal(backgroundWorkStore.getItem(history)?.id, history);
});

test("a failed session write fails the delete and keeps the session and its history", async () => {
  const id = "delete-session-write-fails";
  seed(id);
  const itemId = finishedBackgroundWork(id);
  const before = backgroundWorkStore.getItem(itemId)!.revision;
  getDb().exec(
    `CREATE TEMP TRIGGER fail_viewed_session_delete BEFORE UPDATE OF deleted_at_ms
     ON session_index WHEN OLD.id = '${id}'
     BEGIN SELECT RAISE(ABORT, 'injected session write failure'); END`,
  );
  const result = connectionViewing(id);
  try {
    await result.conn.onDeleteSession(id);
  } finally {
    getDb().exec("DROP TRIGGER fail_viewed_session_delete");
  }

  const error = result.sent.find((message) => message.type === "error");
  assert.match(
    error?.message ?? "",
    /Failed to delete session: .*injected session write failure/,
  );
  assert.equal(sessionStore.get(id)?.deletedAt, undefined);
  assert.equal(result.conn.viewing !== undefined, true);
  assert.equal(backgroundWorkStore.getItem(itemId)?.revision, before);
});

test("deleting a session with more history than one frame sends bounded batches", async () => {
  const id = "delete-large-background-history";
  seed(id);
  // Past both the per-statement id chunk (500) and the snapshot cap (200).
  const owned = seedFinishedHistory(id, 1_200);
  const watch = watchBackgroundEvents();
  try {
    await watch.flushed();
    watch.events.length = 0;
    watch.batches.length = 0;

    await connectionViewing(id).conn.onDeleteSession(id);
    await watch.flushed();

    assert.equal(sessionStore.get(id), undefined);
    assert.deepEqual(
      watch.events.map((event) => event.id).sort(),
      [...owned].sort(),
    );
    assert.ok(watch.events.every((event) => event.kind === "delete"));
    assert.equal(watch.batches.length, 6);
    for (const [index, batch] of watch.batches.entries()) {
      assert.ok(batch.size <= BACKGROUND_WORK_SNAPSHOT_MAX);
      // Consecutive, so a client sees no gap and never resyncs.
      if (index > 0) assert.equal(batch.seq, watch.batches[index - 1]!.seq + 1);
    }
  } finally {
    watch.stop();
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
