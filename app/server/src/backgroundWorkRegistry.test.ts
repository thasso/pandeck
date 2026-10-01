/**
 * The wire half of Task-482: what background work looks like once it leaves the
 * store, and what it does — and does not — do to the session it belongs to.
 *   pnpm --filter @assistant/server test src/backgroundWorkRegistry.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  backgroundWorkBlockedReason,
  settleBlockedReason,
  type BackgroundWorkItemSummary,
  type ServerMessage,
  type SessionListItem,
} from "@assistant/shared";
import {
  backgroundWorkSnapshot,
  backgroundWorkStateItems,
  BACKGROUND_WORK_SNAPSHOT_MAX,
} from "./backgroundWorkRegistry.ts";
import { backgroundWorkStore } from "./db/backgroundWorkStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { listSessions } from "./sessions.ts";

let serial = 0;
function makeOwner(): string {
  serial += 1;
  const id = `bg-registry-${Date.now()}-${serial}`;
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "claude-sdk",
    agentType: "developer",
    title: "owner",
    // A row with no messages is not a conversation and never reaches the list.
    messageCount: 2,
  });
  return id;
}

function reserve(owner: string, overrides: Record<string, unknown> = {}) {
  serial += 1;
  return backgroundWorkStore.reserveItem({
    ownerSessionId: owner,
    backend: "host-process",
    kind: "shell",
    label: "pnpm run build",
    sourceRequestId: `toolu_source_${serial}`,
    lifetimeMs: 60 * 60 * 1000,
    settingsGeneration: 1,
    bootEpoch: "boot-registry",
    ownerLimit: 1_000,
    ...overrides,
  });
}

test("the summary carries PA identity and bounded facts, never provider or host detail", () => {
  const owner = makeOwner();
  const item = reserve(owner, {
    backend: "claude-query",
    kind: "monitor-command",
    label: "tail -f build log",
    host: { epochKey: `epoch-summary-${serial}`, emptyGraceMs: 30_000 },
  });
  backgroundWorkStore.markRunning({ itemId: item.id });
  backgroundWorkStore.bindProvider({
    itemId: item.id,
    providerTaskId: "vendor-task-secret",
    providerTaskType: "bash",
  });
  backgroundWorkStore.recordEvidence({
    itemId: item.id,
    eventId: "evt-1",
    sequence: 1,
    evidence: {
      artifactId: "artifact-1",
      originalBytes: 1_000_000,
      capturedBytes: 65_536,
      truncated: true,
      text: true,
    },
  });

  const event = backgroundWorkStateItems([item.id])[0];
  assert.equal(event?.kind, "upsert");
  const summary = (event as { item: BackgroundWorkItemSummary }).item;
  assert.equal(summary.id, item.id);
  assert.equal(summary.ownerSessionId, owner);
  assert.equal(summary.backend, "claude-query");
  assert.equal(summary.kind, "monitor-command");
  assert.equal(summary.state, "running");
  // The item is running, so its epoch is live: execution promotes it without
  // waiting for the backend to report the query.
  assert.equal(summary.host?.state, "live");
  // The binding is a FACT, not a handle: the vendor id stays backend-internal.
  assert.equal(summary.providerBound, true);
  assert.equal(summary.evidence?.capturedBytes, 65_536);
  assert.equal(summary.evidence?.truncated, true);

  const wire = JSON.stringify(summary);
  for (const secret of [
    "vendor-task-secret",
    "epoch-summary",
    "boot-registry",
    "toolu_source_",
  ])
    assert.equal(
      wire.includes(secret),
      false,
      `the summary must not carry ${secret}`,
    );
  assert.deepEqual(
    Object.keys(summary).filter((key) =>
      [
        "providerTaskId",
        "providerTaskType",
        "sourceRequestId",
        "bootEpoch",
        "epochKey",
        "pid",
        "cwd",
        "command",
      ].includes(key),
    ),
    [],
  );
});

test("state items converge: an unchanged row re-reads equal, a tombstone deletes", () => {
  const owner = makeOwner();
  const item = reserve(owner);
  const first = backgroundWorkStateItems([item.id])[0];
  const second = backgroundWorkStateItems([item.id])[0];
  assert.deepEqual(first, second);
  assert.ok(
    backgroundWorkSnapshot().revisions.some((entry) => entry.id === item.id),
  );

  const running = backgroundWorkStore.markRunning({ itemId: item.id });
  const moved = backgroundWorkStateItems([item.id])[0];
  assert.equal(moved?.revision, running.revision);
  assert.notEqual(moved?.revision, first?.revision);

  backgroundWorkStore.terminalize({ itemId: item.id, state: "completed" });
  backgroundWorkStore.deleteOwnerSession(owner);
  const deleted = backgroundWorkStateItems([item.id])[0];
  assert.equal(deleted?.kind, "delete");
  assert.equal(
    backgroundWorkSnapshot().revisions.some((entry) => entry.id === item.id),
    false,
  );
});

test("an idle session reports background activity without any provider run state", async () => {
  const owner = makeOwner();
  const shell = reserve(owner, { label: "long build" });
  reserve(owner, { kind: "monitor-websocket", label: "socket" });
  backgroundWorkStore.markRunning({ itemId: shell.id });

  const sessions = await listSessions([], () => Date.now());
  const row = sessions.find((session) => session.id === owner);
  assert.ok(row, "the owning session is listed");
  assert.equal(row.backgroundActivity?.activeCount, 2);
  assert.equal(row.backgroundActivity?.shellCount, 1);
  assert.equal(row.backgroundActivity?.monitorWebsocketCount, 1);
  assert.equal(row.backgroundActivity?.startingCount, 1);
  assert.ok(row.backgroundActivity?.oldestStartedAt);
  // The whole point of the separate component: the provider turn is over.
  assert.equal(row.isStreaming, false);
  assert.equal(row.runStartedAt, undefined);

  // Settling is refused for the same reason the registry shows work, in one
  // wording both sides use.
  assert.equal(
    settleBlockedReason(row),
    "it still has 2 background processes running.",
  );

  for (const item of backgroundWorkStore.listItems({
    ownerSessionId: owner,
    state: "active",
  }))
    backgroundWorkStore.terminalize({ itemId: item.id, state: "completed" });
  const settled = (await listSessions([], () => Date.now())).find(
    (session) => session.id === owner,
  );
  assert.equal(settled?.backgroundActivity, undefined);
  assert.equal(settleBlockedReason(settled as SessionListItem), undefined);
  // Starting and finishing background work moved neither the read mark nor the
  // provider run state it must never speak for.
  assert.equal(settled?.unread, row.unread);
  assert.equal(settled?.isStreaming, false);
  assert.equal(settled?.runStartedAt, undefined);
});

test("a retained epoch with no children left still blocks settle and delete", async () => {
  const owner = makeOwner();
  const item = reserve(owner, {
    backend: "claude-query",
    label: "vendor task",
    host: { epochKey: `epoch-blocking-${serial}`, emptyGraceMs: 30_000 },
  });
  backgroundWorkStore.markRunning({ itemId: item.id });
  backgroundWorkStore.setHostState({ hostId: item.hostId!, state: "live" });
  backgroundWorkStore.terminalize({ itemId: item.id, state: "completed" });

  const row = (await listSessions([], () => Date.now())).find(
    (session) => session.id === owner,
  );
  // No items left, but the query is still retained and still holds the owner
  // slot: settling or deleting here would orphan it.
  assert.equal(row?.backgroundActivity?.activeCount, 0);
  assert.equal(row?.backgroundActivity?.retainedHost, true);
  assert.equal(
    settleBlockedReason(row as SessionListItem),
    "it still holds a retained background host.",
  );

  backgroundWorkStore.setHostState({ hostId: item.hostId!, state: "closed" });
  const closed = (await listSessions([], () => Date.now())).find(
    (session) => session.id === owner,
  );
  assert.equal(closed?.backgroundActivity, undefined);
  assert.equal(settleBlockedReason(closed as SessionListItem), undefined);
});

test("the shared blocker speaks only for work that is really there", () => {
  assert.equal(backgroundWorkBlockedReason(undefined), undefined);
  assert.equal(
    backgroundWorkBlockedReason({
      activeCount: 0,
      shellCount: 0,
      monitorCommandCount: 0,
      monitorWebsocketCount: 0,
      startingCount: 0,
      stoppingCount: 0,
      oldestStartedAt: 0,
    }),
    undefined,
  );
  assert.equal(
    backgroundWorkBlockedReason({
      activeCount: 1,
      shellCount: 1,
      monitorCommandCount: 0,
      monitorWebsocketCount: 0,
      startingCount: 0,
      stoppingCount: 0,
      oldestStartedAt: 1,
    }),
    "it still has 1 background process running.",
  );
  assert.equal(
    backgroundWorkBlockedReason({
      activeCount: 0,
      shellCount: 0,
      monitorCommandCount: 0,
      monitorWebsocketCount: 0,
      startingCount: 0,
      stoppingCount: 0,
      oldestStartedAt: 5,
      retainedHost: true,
    }),
    "it still holds a retained background host.",
  );
});

test("mutations reach subscribers as state events only, ending in a delete", async () => {
  const { hub } = await import("./hub.ts");
  const owner = makeOwner();
  const messages: ServerMessage[] = [];
  const viewer = {
    send: (message: ServerMessage): void => {
      messages.push(message);
    },
    wantsTopic: (topic: string) => topic === "background",
  };
  hub.register(viewer);
  try {
    const item = reserve(owner, { label: "npm run watch" });
    await hub.flushPendingBroadcastsForTests();
    const batches = messages.filter(
      (message) =>
        message.type === "stateEvents" && message.topic === "background",
    );
    assert.ok(batches.length >= 1);
    for (const batch of batches)
      // The event IS the mutation's wire form: no collection rides along.
      assert.deepEqual(Object.keys(batch).sort(), [
        "events",
        "seq",
        "topic",
        "type",
      ]);

    backgroundWorkStore.markRunning({ itemId: item.id });
    backgroundWorkStore.terminalize({ itemId: item.id, state: "completed" });
    await hub.flushPendingBroadcastsForTests();
    backgroundWorkStore.deleteOwnerSession(owner);
    await hub.flushPendingBroadcastsForTests();
    const last = messages
      .filter(
        (message) =>
          message.type === "stateEvents" && message.topic === "background",
      )
      .at(-1) as { events?: Array<{ id: string; kind: string }> } | undefined;
    assert.equal(
      last?.events?.find((event) => event.id === item.id)?.kind,
      "delete",
    );
  } finally {
    hub.unregister(viewer);
  }
});

test("a flush carries exactly the rows writes reported, never untouched history", async () => {
  const { hub } = await import("./hub.ts");
  const owner = makeOwner();
  // Settled history from before this viewer connected: it must never ride a
  // later broadcast, because nothing about it changed.
  const history = reserve(owner, { label: "old build" });
  backgroundWorkStore.terminalize({ itemId: history.id, state: "completed" });
  await hub.flushPendingBroadcastsForTests();

  const events: Array<{
    id: string;
    kind: string;
    revision: number;
    item?: BackgroundWorkItemSummary;
  }> = [];
  const viewer = {
    send: (message: ServerMessage): void => {
      if (message.type === "stateEvents" && message.topic === "background")
        events.push(...(message.events as typeof events));
    },
    wantsTopic: (topic: string) => topic === "background",
  };
  hub.register(viewer);
  const flushed = async () => {
    await hub.flushPendingBroadcastsForTests();
    const mine = events.filter((event) =>
      [history.id, item.id, host.id, fleeting.id].includes(event.id),
    );
    events.length = 0;
    return mine;
  };
  let item = reserve(owner, { label: "watch" });
  const host = reserve(owner, {
    backend: "claude-query",
    host: { epochKey: `epoch-flush-${serial}`, emptyGraceMs: 30_000 },
  });
  let fleeting = host;
  try {
    // Create: one upsert per reported row, nothing for the history row.
    const created = await flushed();
    assert.deepEqual(
      created.map((event) => [event.id, event.kind]).sort(),
      [
        [host.id, "upsert"],
        [item.id, "upsert"],
      ].sort(),
    );

    // Update and terminal transition in one window coalesce to the last write.
    backgroundWorkStore.markRunning({ itemId: item.id });
    item = backgroundWorkStore.terminalize({
      itemId: item.id,
      state: "completed",
    });
    const settled = await flushed();
    assert.equal(settled.length, 1);
    assert.equal(settled[0]?.kind, "upsert");
    assert.equal(settled[0]?.revision, item.revision);
    assert.equal(settled[0]?.item?.state, "completed");

    // A host transition re-sends its FINISHED children too: host state is
    // part of each child's summary.
    backgroundWorkStore.terminalize({ itemId: host.id, state: "completed" });
    await flushed();
    backgroundWorkStore.setHostState({
      hostId: backgroundWorkStore.getItem(host.id)!.hostId!,
      state: "closed",
    });
    const closed = await flushed();
    assert.deepEqual(
      closed.map((event) => [event.id, event.kind, event.item?.host?.state]),
      [[host.id, "upsert", "closed"]],
    );

    // Tombstoning deletes every member row, the untouched history included.
    // A row that joins and leaves inside one window still gets its delete: a
    // subscribe in between may have snapshotted it.
    fleeting = reserve(owner, { label: "blink" });
    backgroundWorkStore.terminalize({ itemId: fleeting.id, state: "failed" });
    backgroundWorkStore.deleteOwnerSession(owner);
    const deleted = await flushed();
    assert.deepEqual(
      deleted.map((event) => [event.id, event.kind]).sort(),
      [
        [fleeting.id, "delete"],
        [history.id, "delete"],
        [host.id, "delete"],
        [item.id, "delete"],
      ].sort(),
    );
    for (const event of deleted)
      assert.equal(
        event.revision,
        backgroundWorkStore.itemRevisions([event.id])[0]?.revision,
      );
  } finally {
    hub.unregister(viewer);
  }
});

test("the subscribe snapshot is a bounded window that drops finished work first", () => {
  const owner = makeOwner();
  const finished = reserve(owner, { label: "yesterday's build" });
  backgroundWorkStore.terminalize({ itemId: finished.id, state: "completed" });
  const live = reserve(owner, { label: "today's build" });
  backgroundWorkStore.markRunning({ itemId: live.id });

  // A registry that keeps its history must never answer with all of it: the
  // window is a hard cap, and it says so rather than passing itself off as the
  // complete list.
  const tiny = backgroundWorkSnapshot(1);
  assert.equal(tiny.items.length, 1);
  assert.equal(tiny.truncated, true);
  assert.ok(
    ["pending-launch", "running"].includes(tiny.items[0]?.state ?? ""),
    "a cap drops finished work before it drops something still running",
  );
  // The sidecar describes exactly the rows that shipped — a revision for a row
  // the client was never given would claim it is already up to date on it.
  assert.deepEqual(
    tiny.revisions.map((entry) => entry.id),
    tiny.items.map((item) => item.id),
  );

  const whole = backgroundWorkSnapshot(BACKGROUND_WORK_SNAPSHOT_MAX);
  assert.ok(whole.items.length <= BACKGROUND_WORK_SNAPSHOT_MAX);
  assert.equal(whole.truncated, false);
  const ids = whole.items.map((item) => item.id);
  assert.ok(ids.includes(live.id) && ids.includes(finished.id));
  const lastActive = whole.items.findLastIndex((item) =>
    ["pending-launch", "running"].includes(item.state),
  );
  const firstTerminal = whole.items.findIndex(
    (item) => !["pending-launch", "running"].includes(item.state),
  );
  assert.ok(
    firstTerminal === -1 || firstTerminal > lastActive,
    "active work sorts ahead of history, so the cap can only cut history",
  );
});
