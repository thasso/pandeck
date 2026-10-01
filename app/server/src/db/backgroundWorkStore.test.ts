import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type {
  BackgroundWorkStateChange,
  ReserveBackgroundWorkInput,
} from "./backgroundWorkStore.ts";

const dataDir = mkdtempSync(join(tmpdir(), "background-work-store-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const {
  BACKGROUND_WORK_PUBLIC_WRITE_PATHS,
  BackgroundWorkCapacityError,
  BackgroundWorkOverCapEpochError,
  BackgroundWorkValidationError,
  backgroundWorkStore,
  setBackgroundWorkStateChangeNotifier,
} = await import("./backgroundWorkStore.ts");
const { sessionStore } = await import("./sessionStore.ts");
const { getDb } = await import("./index.ts");

let serial = 0;
function makeSession(scope: "user" | "internal" = "user"): string {
  serial += 1;
  const id = `bg-${scope}-${Date.now()}-${serial}`;
  sessionStore.upsert({
    id,
    scope,
    harness: "claude-sdk",
    agentType: "developer",
  });
  return id;
}

function reserveInput(
  ownerSessionId: string,
  overrides: Partial<ReserveBackgroundWorkInput> = {},
): ReserveBackgroundWorkInput {
  serial += 1;
  return {
    ownerSessionId,
    backend: "host-process",
    kind: "shell",
    label: "pnpm run test",
    sourceRequestId: `src-${serial}`,
    lifetimeMs: 60 * 60 * 1000,
    settingsGeneration: 3,
    bootEpoch: "boot-a",
    // High by default so one test's leftover owners cannot starve the next; the
    // capacity test sets its own limit relative to the live count.
    ownerLimit: 1_000,
    ...overrides,
  };
}

test("the migration creates both tables with their capacity and binding guards", () => {
  const tables = getDb()
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name IN ('background_work_items', 'background_hosts')
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  assert.deepEqual(
    tables.map((row) => row.name),
    ["background_hosts", "background_work_items"],
  );
  const indexes = (
    getDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('background_work_items', 'background_hosts')",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  assert.ok(indexes.includes("background_hosts_one_live_per_owner_idx"));
  assert.ok(indexes.includes("background_work_items_provider_binding_idx"));
});

test("pi and Claude work round-trip through one provider-neutral row", () => {
  const owner = makeSession();
  const shell = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: "pi-1" }),
  );
  assert.equal(shell.backend, "host-process");
  assert.equal(shell.state, "pending-launch");
  assert.equal(shell.provenance, "reserved");
  assert.equal(shell.hostId, undefined);

  const socket = backgroundWorkStore.reserveItem(
    reserveInput(owner, {
      sourceRequestId: "pi-2",
      kind: "monitor-websocket",
      label: "watch build socket",
    }),
  );
  const claudeOwner = makeSession();
  const vendor = backgroundWorkStore.reserveItem(
    reserveInput(claudeOwner, {
      backend: "claude-query",
      kind: "monitor-command",
      sourceRequestId: "toolu_1",
      host: { epochKey: "epoch-1", emptyGraceMs: 30_000 },
    }),
  );
  assert.ok(vendor.hostId);
  // One shape for three very different runtimes: the only difference on the row
  // is which backend/kind it names.
  for (const item of [shell, socket, vendor]) {
    assert.equal(backgroundWorkStore.getItem(item.id)?.id, item.id);
    assert.equal(item.settingsGeneration, 3);
    assert.equal(item.deadlineAt, item.createdAt + 60 * 60 * 1000);
  }
});

test("the row keeps a bounded command and the description, and a tombstone clears both", () => {
  const owner = makeSession();
  const script = `echo start\n${"x".repeat(5_000)}`;
  const item = backgroundWorkStore.reserveItem(
    reserveInput(owner, {
      label: "Start dev server",
      description: "Start dev server",
      command: script,
    }),
  );
  assert.equal(item.description, "Start dev server");
  assert.equal(item.command?.length, 4_096);
  assert.equal(item.commandTruncated, true);
  const short = backgroundWorkStore.reserveItem(
    reserveInput(owner, { command: "pnpm test", description: "   " }),
  );
  assert.equal(short.command, "pnpm test");
  assert.equal(short.commandTruncated, undefined);
  assert.equal(short.description, undefined);
  backgroundWorkStore.terminalize({ itemId: item.id, state: "completed" });
  backgroundWorkStore.terminalize({ itemId: short.id, state: "completed" });
  backgroundWorkStore.deleteOwnerSession(owner);
  const deleted = getDb()
    .prepare(
      `SELECT label, description, command, command_truncated
       FROM background_work_items WHERE id IN (?, ?)`,
    )
    .all(item.id, short.id) as Array<{
    label: string;
    description: string | null;
    command: string | null;
    command_truncated: number;
  }>;
  assert.equal(deleted.length, 2);
  for (const row of deleted)
    assert.deepEqual(
      { ...row },
      {
        label: "deleted",
        description: null,
        command: null,
        command_truncated: 0,
      },
    );
});

test("a Claude host epoch is created lazily and never by an ordinary query", () => {
  const plainOwner = makeSession();
  // An ordinary Claude turn never reaches a reservation at all, so nothing
  // here writes a host row; PA-supervised work needs no retained query either.
  backgroundWorkStore.reserveItem(
    reserveInput(plainOwner, { sourceRequestId: "pi-only" }),
  );
  assert.equal(backgroundWorkStore.hostForOwner(plainOwner), undefined);
  // And Claude work cannot exist WITHOUT one: it executes inside the query, so
  // a hostless row could never be bound or stopped.
  assert.throws(
    () =>
      backgroundWorkStore.reserveItem(
        reserveInput(plainOwner, {
          backend: "claude-query",
          sourceRequestId: "no-host",
        }),
      ),
    BackgroundWorkValidationError,
  );

  const owner = makeSession();
  const first = backgroundWorkStore.reserveItem(
    reserveInput(owner, {
      backend: "claude-query",
      sourceRequestId: "toolu_a",
      host: { epochKey: `epoch-${owner}`, emptyGraceMs: 30_000 },
    }),
  );
  const host = backgroundWorkStore.hostForOwner(owner);
  assert.equal(host?.id, first.hostId);
  assert.equal(host?.state, "creating");

  const second = backgroundWorkStore.reserveItem(
    reserveInput(owner, {
      backend: "claude-query",
      sourceRequestId: "toolu_b",
      host: { epochKey: `epoch-${owner}`, emptyGraceMs: 30_000 },
    }),
  );
  assert.equal(second.hostId, first.hostId);

  assert.throws(
    () =>
      backgroundWorkStore.reserveItem(
        reserveInput(owner, {
          backend: "claude-query",
          sourceRequestId: "toolu_c",
          host: { epochKey: `epoch-${owner}-second`, emptyGraceMs: 30_000 },
        }),
      ),
    BackgroundWorkValidationError,
  );
});

test("the last owner slot is reserved atomically and reused by the same owner", () => {
  const first = makeSession();
  const second = makeSession();
  const third = makeSession();
  const before = backgroundWorkStore.ownerSlotCount();
  const limit = before + 2;
  backgroundWorkStore.reserveItem(
    reserveInput(first, { ownerLimit: limit, sourceRequestId: "slot-a" }),
  );
  backgroundWorkStore.reserveItem(
    reserveInput(second, { ownerLimit: limit, sourceRequestId: "slot-b" }),
  );
  assert.equal(backgroundWorkStore.ownerSlotCount(), limit);

  // A third OWNER is refused …
  assert.throws(
    () =>
      backgroundWorkStore.reserveItem(
        reserveInput(third, { ownerLimit: limit, sourceRequestId: "slot-c" }),
      ),
    BackgroundWorkCapacityError,
  );
  // … while another child of an owner that already holds a slot is not: the cap
  // counts SESSIONS, and there is no configured child ceiling.
  const reused = backgroundWorkStore.reserveItem(
    reserveInput(first, { ownerLimit: limit, sourceRequestId: "slot-a2" }),
  );
  assert.equal(reused.provenance, "reserved");
  assert.equal(backgroundWorkStore.ownerSlotCount(), limit);

  // Terminalizing the whole owner releases the slot for somebody else.
  for (const item of backgroundWorkStore.listItems({
    ownerSessionId: first,
    state: "active",
  }))
    backgroundWorkStore.terminalize({ itemId: item.id, state: "completed" });
  assert.equal(backgroundWorkStore.ownerSlotCount(), limit - 1);
  const admitted = backgroundWorkStore.reserveItem(
    reserveInput(third, { ownerLimit: limit, sourceRequestId: "slot-c2" }),
  );
  assert.equal(admitted.state, "pending-launch");
});

test("a repeated source request identity reserves nothing new", () => {
  const owner = makeSession();
  const first = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: "toolu_same", lifetimeMs: 1_000 }),
  );
  const again = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: "toolu_same", lifetimeMs: 999_000 }),
  );
  assert.equal(again.id, first.id);
  // The FIRST reservation's frozen deadline stands; a retry cannot extend it.
  assert.equal(again.deadlineAt, first.deadlineAt);
  assert.equal(
    backgroundWorkStore.listItems({ ownerSessionId: owner }).length,
    1,
  );
});

test("observed work adopts a free slot and is counted, never evicted, over cap", () => {
  const owner = makeSession();
  const adopted = backgroundWorkStore.observeItem(
    reserveInput(owner, {
      sourceRequestId: "observed-1",
      ownerLimit: backgroundWorkStore.ownerSlotCount() + 1,
    }),
  );
  assert.equal(adopted.provenance, "observed-adopted");
  assert.equal(adopted.state, "running");
  assert.equal(adopted.startedAt, adopted.createdAt);

  const overCapOwner = makeSession();
  const overCap = backgroundWorkStore.observeItem(
    reserveInput(overCapOwner, {
      sourceRequestId: "observed-2",
      ownerLimit: 1,
    }),
  );
  assert.equal(overCap.provenance, "observed-over-cap");
  assert.equal(overCap.state, "running");
  // Recorded, so the user can see and stop it — and no new admission follows.
  assert.throws(
    () =>
      backgroundWorkStore.reserveItem(
        reserveInput(overCapOwner, {
          sourceRequestId: "after-over-cap",
          ownerLimit: 1,
        }),
      ),
    BackgroundWorkCapacityError,
  );
});

test("transitions are legal-only and evidence never resurrects a terminal row", () => {
  const owner = makeSession();
  const item = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: "legal-1" }),
  );
  const running = backgroundWorkStore.markRunning({ itemId: item.id });
  assert.equal(running.state, "running");
  assert.ok(running.startedAt);

  const done = backgroundWorkStore.terminalize({
    itemId: item.id,
    state: "completed",
    exitCode: 0,
    reason: "exited cleanly",
  });
  assert.equal(done.state, "completed");
  assert.ok(done.terminalAt);

  // Later provider evidence is evidence, not authority.
  const echoed = backgroundWorkStore.recordEvidence({
    itemId: item.id,
    outcomeSummary: "late line",
  });
  assert.equal(echoed.state, "completed");
  assert.equal(echoed.outcomeSummary, undefined);
  const reterminalized = backgroundWorkStore.terminalize({
    itemId: item.id,
    state: "failed",
    reason: "second opinion",
  });
  assert.equal(reterminalized.state, "completed");
  assert.equal(reterminalized.terminalReason, "exited cleanly");
  assert.throws(
    () => backgroundWorkStore.markRunning({ itemId: item.id }),
    BackgroundWorkValidationError,
  );

  const late = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: "legal-2" }),
  );
  backgroundWorkStore.markRunning({ itemId: late.id });
  assert.throws(
    () =>
      backgroundWorkStore.terminalize({
        itemId: late.id,
        state: "not-started",
      }),
    BackgroundWorkValidationError,
  );
});

test("duplicate and out-of-order provider evidence are no-ops", () => {
  const owner = makeSession();
  const item = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: "evidence-1" }),
  );
  backgroundWorkStore.markRunning({ itemId: item.id });
  const first = backgroundWorkStore.recordEvidence({
    itemId: item.id,
    eventId: "evt-2",
    sequence: 2,
    outcomeSummary: "second snapshot",
    evidence: {
      originalBytes: 4_096,
      capturedBytes: 1_024,
      truncated: true,
      text: true,
    },
  });
  assert.equal(first.outcomeSummary, "second snapshot");
  assert.equal(first.evidence?.capturedBytes, 1_024);

  const duplicate = backgroundWorkStore.recordEvidence({
    itemId: item.id,
    eventId: "evt-2",
    sequence: 2,
    evidence: { capturedBytes: 9_999 },
  });
  assert.equal(duplicate.evidence?.capturedBytes, 1_024);

  const stale = backgroundWorkStore.recordEvidence({
    itemId: item.id,
    eventId: "evt-1",
    sequence: 1,
    evidence: { capturedBytes: 8 },
  });
  assert.equal(stale.evidence?.capturedBytes, 1_024);
  assert.equal(stale.lastEventSeq, 2);

  const newer = backgroundWorkStore.recordEvidence({
    itemId: item.id,
    eventId: "evt-3",
    sequence: 3,
    evidence: { capturedBytes: 2_048 },
  });
  assert.equal(newer.evidence?.capturedBytes, 2_048);
});

test("Stop is reserved before side effects and pre-launch Stop wins the race", () => {
  const owner = makeSession();
  const pending = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: "stop-1" }),
  );
  const prevented = backgroundWorkStore.requestStop({
    itemId: pending.id,
    reason: "owner changed their mind",
    sourceRequestId: "stop-req-1",
  });
  assert.equal(prevented.preventedLaunch, true);
  assert.equal(prevented.item.state, "not-started");
  assert.equal(prevented.item.terminalReason, "stopped-by-owner");

  const repeat = backgroundWorkStore.requestStop({
    itemId: pending.id,
    reason: "again",
    sourceRequestId: "stop-req-1",
  });
  assert.equal(repeat.reserved, false);

  const claudeOwner = makeSession();
  const bound = backgroundWorkStore.reserveItem(
    reserveInput(claudeOwner, {
      backend: "claude-query",
      sourceRequestId: "stop-2",
      host: { epochKey: `epoch-stop-${claudeOwner}`, emptyGraceMs: 0 },
    }),
  );
  backgroundWorkStore.markRunning({ itemId: bound.id });
  const awaiting = backgroundWorkStore.requestStop({
    itemId: bound.id,
    reason: "deadline",
    sourceRequestId: "stop-req-2",
    ackDeadlineMs: 10_000,
  });
  // Execution crossed admission but the vendor handle is not bound yet.
  assert.equal(awaiting.item.stopState, "awaiting-binding");
  assert.ok(awaiting.item.stopAckDeadlineAt);

  const boundItem = backgroundWorkStore.bindProvider({
    itemId: bound.id,
    providerTaskId: "vendor-task-1",
  });
  assert.equal(boundItem.stopState, "requested");

  const unconfirmed = backgroundWorkStore.recordStopAttempt({
    itemId: bound.id,
    unconfirmed: true,
    evidence: "no acknowledgement within 10s",
  });
  // Nonterminal on purpose: nothing observed the task actually stopping.
  assert.equal(unconfirmed.stopState, "unconfirmed");
  assert.equal(unconfirmed.state, "running");
  assert.equal(unconfirmed.stopAttempts, 1);

  const answered = backgroundWorkStore.terminalize({
    itemId: bound.id,
    state: "stopped",
    reason: "acknowledged late",
  });
  assert.equal(answered.state, "stopped");
  assert.equal(answered.stopState, "requested");
});

test("a provider binding is unique within its host epoch", () => {
  const owner = makeSession();
  const host = { epochKey: `epoch-bind-${owner}`, emptyGraceMs: 0 };
  const first = backgroundWorkStore.reserveItem(
    reserveInput(owner, {
      backend: "claude-query",
      sourceRequestId: "bind-1",
      host,
    }),
  );
  const second = backgroundWorkStore.reserveItem(
    reserveInput(owner, {
      backend: "claude-query",
      sourceRequestId: "bind-2",
      host,
    }),
  );
  backgroundWorkStore.bindProvider({
    itemId: first.id,
    providerTaskId: "vendor-1",
    providerTaskType: "bash",
  });
  assert.throws(() =>
    backgroundWorkStore.bindProvider({
      itemId: second.id,
      providerTaskId: "vendor-1",
    }),
  );
  // A row already bound elsewhere is not silently rebound either.
  assert.throws(
    () =>
      backgroundWorkStore.bindProvider({
        itemId: first.id,
        providerTaskId: "vendor-2",
      }),
    BackgroundWorkValidationError,
  );
});

test("closing a host takes its remaining work with a distinct outcome", () => {
  const owner = makeSession();
  const item = backgroundWorkStore.reserveItem(
    reserveInput(owner, {
      backend: "claude-query",
      sourceRequestId: "close-1",
      host: { epochKey: `epoch-close-${owner}`, emptyGraceMs: 0 },
    }),
  );
  backgroundWorkStore.markRunning({ itemId: item.id });
  const hostId = item.hostId!;
  backgroundWorkStore.setHostState({ hostId, state: "live" });
  const stopAll = backgroundWorkStore.requestHostStopAll({
    hostId,
    reason: "owner stop_all",
  });
  assert.ok(stopAll.stopAllRequestedAt);

  const closed = backgroundWorkStore.setHostState({
    hostId,
    state: "closed",
    reason: "no work left",
  });
  assert.equal(closed.state, "closed");
  assert.ok(closed.closedAt);
  const after = backgroundWorkStore.getItem(item.id);
  assert.equal(after?.state, "stopped");
  assert.equal(after?.terminalReason, "stopped-by-host-close");
  assert.throws(
    () => backgroundWorkStore.setHostState({ hostId, state: "draining" }),
    BackgroundWorkValidationError,
  );
});

test("boot reconciliation loses previous-process work idempotently, drains excepted", () => {
  const owner = makeSession();
  const running = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: "boot-1", bootEpoch: "boot-old" }),
  );
  backgroundWorkStore.markRunning({ itemId: running.id });
  const drained = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: "boot-2", bootEpoch: "boot-old" }),
  );
  backgroundWorkStore.markRunning({ itemId: drained.id });
  backgroundWorkStore.recordPlannedDrain({
    itemId: drained.id,
    reason: "stopped for deployment",
  });
  const abandoned = backgroundWorkStore.reserveItem(
    reserveInput(owner, {
      sourceRequestId: "boot-unconfirmed-drain",
      bootEpoch: "boot-old",
    }),
  );
  backgroundWorkStore.markRunning({ itemId: abandoned.id });
  backgroundWorkStore.requestStop({
    itemId: abandoned.id,
    reason: "stopped for deployment",
    sourceRequestId: "boot-unconfirmed-stop",
  });
  backgroundWorkStore.recordStopAttempt({
    itemId: abandoned.id,
    unconfirmed: true,
    evidence: "deployment Stop timed out",
  });
  backgroundWorkStore.recordPlannedDrain({
    itemId: abandoned.id,
    reason: "stopped for deployment",
  });
  const finished = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: "boot-3", bootEpoch: "boot-old" }),
  );
  backgroundWorkStore.terminalize({ itemId: finished.id, state: "completed" });
  const hostOwner = makeSession();
  const hosted = backgroundWorkStore.reserveItem(
    reserveInput(hostOwner, {
      backend: "claude-query",
      sourceRequestId: "boot-4",
      bootEpoch: "boot-old",
      host: { epochKey: `epoch-boot-${hostOwner}`, emptyGraceMs: 0 },
    }),
  );

  const first = backgroundWorkStore.reconcileBoot({ bootEpoch: "boot-new" });
  assert.ok(first.items >= 3);
  assert.equal(first.hosts >= 1, true);
  assert.equal(backgroundWorkStore.getItem(running.id)?.state, "lost");
  assert.equal(
    backgroundWorkStore.getItem(running.id)?.terminalReason,
    "server-restart",
  );
  // A planned drain already said something more specific; it survives.
  assert.equal(backgroundWorkStore.getItem(drained.id)?.state, "stopped");
  assert.equal(
    backgroundWorkStore.getItem(drained.id)?.terminalReason,
    "stopped for deployment",
  );
  assert.equal(backgroundWorkStore.getItem(abandoned.id)?.state, "lost");
  assert.equal(
    backgroundWorkStore.getItem(abandoned.id)?.terminalReason,
    "deployment-stop-unconfirmed",
  );
  assert.equal(
    backgroundWorkStore.getItem(abandoned.id)?.stopState,
    "requested",
    "terminal rows cannot carry unconfirmed, so terminal reason preserves it",
  );
  assert.equal(backgroundWorkStore.getItem(finished.id)?.state, "completed");
  assert.equal(backgroundWorkStore.getHost(hosted.hostId!)?.state, "lost");

  const second = backgroundWorkStore.reconcileBoot({ bootEpoch: "boot-new" });
  assert.deepEqual(second, { items: 0, hosts: 0 });
});

test("reads are bounded and labels are truncated rather than stored whole", () => {
  const owner = makeSession();
  const long = "x".repeat(5_000);
  const item = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: "bounded-1", label: long }),
  );
  assert.equal(item.label.length, 200);
  assert.ok(item.label.endsWith("…"));

  for (let index = 0; index < 5; index += 1)
    backgroundWorkStore.reserveItem(
      reserveInput(owner, { sourceRequestId: `bounded-page-${index}` }),
    );
  assert.equal(
    backgroundWorkStore.listItems({ ownerSessionId: owner, limit: 2 }).length,
    2,
  );
  assert.equal(
    backgroundWorkStore.listItems({
      ownerSessionId: owner,
      limit: 1_000,
    }).length,
    6,
  );
  assert.equal(
    backgroundWorkStore.listItems({ ownerSessionId: owner, state: "terminal" })
      .length,
    0,
  );
});

test("only a live user session may own background work", () => {
  assert.throws(
    () => backgroundWorkStore.reserveItem(reserveInput("no-such-session")),
    BackgroundWorkValidationError,
  );
  assert.throws(
    () =>
      backgroundWorkStore.reserveItem(reserveInput(makeSession("internal"))),
    BackgroundWorkValidationError,
  );
});

test("every public write enters the revision seam and reports touched ids", () => {
  const changes: BackgroundWorkStateChange[] = [];
  setBackgroundWorkStateChangeNotifier((change) => changes.push(change));
  try {
    for (const name of BACKGROUND_WORK_PUBLIC_WRITE_PATHS)
      assert.match(
        backgroundWorkStore[name].toString(),
        /\bmutation\(/,
        `${name} must enter the transaction-aware revision seam`,
      );

    const owner = makeSession();
    const item = backgroundWorkStore.reserveItem(
      reserveInput(owner, {
        backend: "claude-query",
        sourceRequestId: "revision-1",
        host: { epochKey: `epoch-rev-${owner}`, emptyGraceMs: 0 },
      }),
    );
    assert.deepEqual(changes.at(-1)?.itemIds, [item.id]);
    assert.deepEqual(changes.at(-1)?.ownerSessionIds, [owner]);

    const started = backgroundWorkStore.markRunning({ itemId: item.id });
    assert.ok(started.revision > item.revision);

    // A host transition fans out to the items whose projection carries it.
    const beforeHost = changes.length;
    backgroundWorkStore.setHostState({ hostId: item.hostId!, state: "live" });
    assert.equal(changes.length, beforeHost + 1);
    assert.deepEqual(changes.at(-1)?.itemIds, [item.id]);
    assert.deepEqual(changes.at(-1)?.hostIds, [item.hostId]);
    assert.ok(
      backgroundWorkStore.getItem(item.id)!.revision > started.revision,
    );

    // Executing every write path, not just reading its source: each one must
    // move the row's revision AND report the touched ids exactly once, or a
    // subscriber can miss the change entirely.
    const exercised = new Set<string>([
      "reserveItem",
      "markRunning",
      "setHostState",
    ]);
    const bump = (
      name: (typeof BACKGROUND_WORK_PUBLIC_WRITE_PATHS)[number],
      run: () => void,
      inspectItemId = item.id,
    ): void => {
      const before = backgroundWorkStore.getItem(inspectItemId)?.revision ?? -1;
      const notifications = changes.length;
      run();
      exercised.add(name);
      assert.equal(
        changes.length,
        notifications + 1,
        `${name} must notify exactly once after commit`,
      );
      const after = backgroundWorkStore.getItem(inspectItemId)?.revision ?? -1;
      assert.ok(after > before, `${name} must stamp a new revision`);
    };

    bump("bindProvider", () =>
      backgroundWorkStore.bindProvider({
        itemId: item.id,
        providerTaskId: "task-seam",
      }),
    );
    bump("recordEvidence", () =>
      backgroundWorkStore.recordEvidence({
        itemId: item.id,
        sequence: 1,
        evidence: { originalBytes: 4, capturedBytes: 4 },
      }),
    );
    bump("requestStop", () =>
      backgroundWorkStore.requestStop({
        itemId: item.id,
        reason: "seam",
        sourceRequestId: "seam-stop",
      }),
    );
    bump("recordStopAttempt", () =>
      backgroundWorkStore.recordStopAttempt({ itemId: item.id }),
    );
    bump("recordPlannedDrain", () =>
      backgroundWorkStore.recordPlannedDrain({
        itemId: item.id,
        reason: "seam drain",
      }),
    );
    bump("terminalize", () =>
      backgroundWorkStore.terminalize({ itemId: item.id, state: "stopped" }),
    );

    const launchOwner = makeSession();
    const neverLaunched = backgroundWorkStore.reserveItem(
      reserveInput(launchOwner, { sourceRequestId: "revision-fail-launch" }),
    );
    bump(
      "failLaunch",
      () =>
        backgroundWorkStore.failLaunch({
          itemId: neverLaunched.id,
          reason: "nothing started",
        }),
      neverLaunched.id,
    );

    const hostOwner = makeSession();
    const hosted = backgroundWorkStore.reserveItem(
      reserveInput(hostOwner, {
        backend: "claude-query",
        sourceRequestId: "revision-host",
        host: { epochKey: `epoch-seam-${hostOwner}`, emptyGraceMs: 0 },
      }),
    );
    backgroundWorkStore.setHostState({ hostId: hosted.hostId!, state: "live" });
    bump(
      "requestHostStopAll",
      () =>
        backgroundWorkStore.requestHostStopAll({
          hostId: hosted.hostId!,
          reason: "seam stop-all",
        }),
      hosted.id,
    );

    const observedOwner = makeSession();
    const beforeObserve = changes.length;
    const observed = backgroundWorkStore.observeItem(
      reserveInput(observedOwner, { sourceRequestId: "revision-observed" }),
    );
    const observedId = observed.id;
    exercised.add("observeItem");
    assert.equal(changes.length, beforeObserve + 1);
    assert.deepEqual(changes.at(-1)?.itemIds, [observedId]);
    assert.ok(observed.revision > 0);
    bump(
      "reconcileBoot",
      () => backgroundWorkStore.reconcileBoot({ bootEpoch: "boot-seam" }),
      observedId,
    );
    // A tombstoned row leaves the live projection, so its revision is read
    // from the sidecar rather than from a projection that now hides it.
    const beforeTombstone = changes.length;
    const tombstonedFrom = backgroundWorkStore.itemRevisions([observedId])[0]!
      .revision;
    backgroundWorkStore.deleteOwnerSession(observedOwner);
    exercised.add("deleteOwnerSession");
    assert.equal(changes.length, beforeTombstone + 1);
    const tombstoned = backgroundWorkStore.itemRevisions([observedId])[0]!;
    assert.equal(tombstoned.member, false);
    assert.ok(tombstoned.revision > tombstonedFrom);

    const deletedOwner = makeSession();
    const orphan = backgroundWorkStore.reserveItem(
      reserveInput(deletedOwner, { sourceRequestId: "revision-orphan" }),
    );
    backgroundWorkStore.terminalize({ itemId: orphan.id, state: "completed" });
    sessionStore.remove(deletedOwner);
    const beforeRepair = changes.length;
    const orphanFrom = backgroundWorkStore.itemRevisions([orphan.id])[0]!
      .revision;
    backgroundWorkStore.tombstoneDeletedOwners();
    exercised.add("tombstoneDeletedOwners");
    assert.equal(changes.length, beforeRepair + 1);
    assert.ok(changes.at(-1)?.itemIds.includes(orphan.id));
    const repaired = backgroundWorkStore.itemRevisions([orphan.id])[0]!;
    assert.equal(repaired.member, false);
    assert.ok(repaired.revision > orphanFrom);

    assert.deepEqual(
      BACKGROUND_WORK_PUBLIC_WRITE_PATHS.filter((name) => !exercised.has(name)),
      [],
      "every public write path must be exercised here",
    );
  } finally {
    setBackgroundWorkStateChangeNotifier(undefined);
  }
});

test("deleting an owner tombstones history and refuses to hide live work", () => {
  const owner = makeSession();
  const item = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: "tombstone-1" }),
  );
  assert.throws(
    () => backgroundWorkStore.deleteOwnerSession(owner),
    BackgroundWorkValidationError,
  );
  // Refused as a whole: the session is still live.
  assert.equal(sessionStore.get(owner)?.id, owner);
  backgroundWorkStore.terminalize({ itemId: item.id, state: "completed" });
  assert.deepEqual(backgroundWorkStore.deleteOwnerSession(owner), {
    session: "deleted",
    itemIds: [item.id],
  });
  assert.equal(sessionStore.get(owner), undefined);
  assert.equal(backgroundWorkStore.getItem(item.id), undefined);
  const revisions = backgroundWorkStore.itemRevisions([item.id])[0];
  assert.equal(revisions?.member, false);
  // Admission refuses the deleted owner, so nothing new can join its history.
  assert.throws(
    () => backgroundWorkStore.reserveItem(reserveInput(owner)),
    BackgroundWorkValidationError,
  );
});

test("a failed session write rolls the background tombstone back with it", () => {
  const owner = makeSession();
  const item = backgroundWorkStore.reserveItem(reserveInput(owner));
  backgroundWorkStore.terminalize({ itemId: item.id, state: "completed" });
  const before = backgroundWorkStore.getItem(item.id)!;
  const changes: BackgroundWorkStateChange[] = [];
  setBackgroundWorkStateChangeNotifier((change) => changes.push(change));
  getDb().exec(
    `CREATE TEMP TRIGGER fail_session_delete BEFORE UPDATE OF deleted_at_ms
     ON session_index WHEN OLD.id = '${owner}'
     BEGIN SELECT RAISE(ABORT, 'injected session write failure'); END`,
  );
  try {
    assert.throws(
      () => backgroundWorkStore.deleteOwnerSession(owner),
      /injected session write failure/,
    );
  } finally {
    getDb().exec("DROP TRIGGER fail_session_delete");
    setBackgroundWorkStateChangeNotifier(undefined);
  }
  assert.equal(sessionStore.get(owner)?.id, owner);
  const after = backgroundWorkStore.getItem(item.id);
  assert.equal(after?.revision, before.revision);
  assert.equal(after?.label, before.label);
  assert.deepEqual(changes, [], "a rolled-back write notifies nobody");
});

test("an id with no session row deletes nothing and succeeds", () => {
  assert.deepEqual(
    backgroundWorkStore.deleteOwnerSession(`never-registered-${Date.now()}`),
    { session: "missing", itemIds: [] },
  );
});

test("the deleted-owner repair tombstones orphaned history only, idempotently", () => {
  const finished = (owner: string, label: string) => {
    const item = backgroundWorkStore.reserveItem(
      reserveInput(owner, { label }),
    );
    return backgroundWorkStore.terminalize({
      itemId: item.id,
      state: "completed",
    });
  };
  const live = makeSession();
  const liveItem = finished(live, "live owner's build");
  const archived = makeSession();
  const archivedItem = finished(archived, "archived owner's build");
  sessionStore.setArchived(archived, true);
  const deleted = makeSession();
  const deletedItems = [
    finished(deleted, "deleted owner's build"),
    finished(deleted, "deleted owner's test"),
  ];
  sessionStore.remove(deleted);
  // Still running under a deleted owner: skipped and reported, never hidden.
  const running = makeSession();
  const runningItem = backgroundWorkStore.reserveItem(
    reserveInput(running, { label: "still running" }),
  );
  sessionStore.remove(running);
  // No session row at all. The foreign key forbids it today, but an owner
  // nobody can show or stop counts as deleted all the same.
  const vanished = makeSession();
  const vanishedItem = finished(vanished, "vanished owner's build");
  getDb().exec("PRAGMA foreign_keys = OFF");
  try {
    getDb().prepare("DELETE FROM session_index WHERE id = ?").run(vanished);
  } finally {
    getDb().exec("PRAGMA foreign_keys = ON");
  }

  const changes: BackgroundWorkStateChange[] = [];
  setBackgroundWorkStateChangeNotifier((change) => changes.push(change));
  try {
    const repaired = backgroundWorkStore.tombstoneDeletedOwners();
    const orphaned = [...deletedItems, vanishedItem].map((item) => item.id);
    assert.deepEqual([...repaired.itemIds].sort(), [...orphaned].sort());
    assert.deepEqual(
      [...repaired.ownerSessionIds].sort(),
      [deleted, vanished].sort(),
    );
    assert.deepEqual(repaired.blockedOwnerSessionIds, [running]);
    // One transaction and notification per repaired owner, together exactly
    // the tombstoned rows.
    assert.equal(changes.length, 2);
    assert.deepEqual(
      changes.flatMap((change) => change.itemIds).sort(),
      [...orphaned].sort(),
    );
    for (const id of orphaned) {
      assert.equal(backgroundWorkStore.getItem(id), undefined);
      // Membership only: the row itself stays.
      assert.equal(backgroundWorkStore.getItem(id, true)?.id, id);
    }
    for (const item of [liveItem, archivedItem]) {
      const current = backgroundWorkStore.getItem(item.id);
      assert.equal(current?.revision, item.revision);
      assert.equal(current?.label, item.label);
    }
    assert.equal(
      backgroundWorkStore.getItem(runningItem.id)?.state,
      "pending-launch",
    );

    // Idempotent: nothing left to tombstone, so nothing is written or sent.
    const again = backgroundWorkStore.tombstoneDeletedOwners();
    assert.deepEqual(again.itemIds, []);
    assert.deepEqual(again.blockedOwnerSessionIds, [running]);
    assert.equal(changes.length, 2);

    // Once the skipped owner's work ends, the next run takes it.
    backgroundWorkStore.terminalize({
      itemId: runningItem.id,
      state: "completed",
    });
    assert.deepEqual(backgroundWorkStore.tombstoneDeletedOwners().itemIds, [
      runningItem.id,
    ]);
  } finally {
    setBackgroundWorkStateChangeNotifier(undefined);
  }
});

test("at boot the repair follows reconciliation, so an earlier epoch's work never blocks it", () => {
  const owner = makeSession();
  const stale = backgroundWorkStore.reserveItem(
    reserveInput(owner, { bootEpoch: "boot-before-restart" }),
  );
  backgroundWorkStore.markRunning({ itemId: stale.id });
  sessionStore.remove(owner);
  backgroundWorkStore.reconcileBoot({ bootEpoch: "boot-after-restart" });
  assert.equal(backgroundWorkStore.getItem(stale.id)?.state, "lost");
  const repaired = backgroundWorkStore.tombstoneDeletedOwners();
  assert.ok(repaired.itemIds.includes(stale.id));
  assert.equal(repaired.blockedOwnerSessionIds.includes(owner), false);
});

test("an over-cap Claude epoch is counted but never a slot its owner reuses", () => {
  // Fill the cap with a real owner first, so "over cap" is the state under
  // test rather than an artefact of whatever ran before.
  const blocking = makeSession();
  backgroundWorkStore.reserveItem(
    reserveInput(blocking, { sourceRequestId: "over-cap-blocker" }),
  );
  const limit = backgroundWorkStore.ownerSlotCount();
  const owner = makeSession();
  const observed = backgroundWorkStore.observeItem(
    reserveInput(owner, {
      backend: "claude-query",
      sourceRequestId: "over-cap-host",
      ownerLimit: limit,
      host: { epochKey: `epoch-over-${owner}`, emptyGraceMs: 0 },
    }),
  );
  assert.equal(observed.provenance, "observed-over-cap");
  assert.ok(observed.hostId);
  // The epoch exists — the query really is running — but it must not become a
  // held slot, or one unreserved observation would license unlimited work.
  assert.equal(backgroundWorkStore.hostForOwner(owner)?.id, observed.hostId);
  assert.throws(
    () =>
      backgroundWorkStore.reserveItem(
        reserveInput(owner, {
          backend: "claude-query",
          sourceRequestId: "after-over-cap-host",
          ownerLimit: limit,
          host: { epochKey: `epoch-over-${owner}`, emptyGraceMs: 0 },
        }),
      ),
    BackgroundWorkCapacityError,
  );
});

test("a launch that never happened releases its epoch reservation in the same write", () => {
  const failedOwner = makeSession();
  const failed = backgroundWorkStore.reserveItem(
    reserveInput(failedOwner, {
      backend: "claude-query",
      sourceRequestId: "release-failed",
      host: { epochKey: `epoch-release-${failedOwner}`, emptyGraceMs: 0 },
    }),
  );
  const failedHost = failed.hostId!;
  const before = backgroundWorkStore.ownerSlotCount();
  backgroundWorkStore.failLaunch({
    itemId: failed.id,
    reason: "the provider reported no task",
  });
  // The epoch was a reservation nothing ever ran in; it cannot acquire another
  // child, so holding the owner slot open would leak it forever.
  assert.equal(backgroundWorkStore.getHost(failedHost)?.state, "closed");
  assert.equal(
    backgroundWorkStore.getHost(failedHost)?.terminalReason,
    "reservation-released",
  );
  assert.equal(backgroundWorkStore.hostForOwner(failedOwner), undefined);
  assert.equal(backgroundWorkStore.ownerSlotCount(), before - 1);

  const stopOwner = makeSession();
  const stopped = backgroundWorkStore.reserveItem(
    reserveInput(stopOwner, {
      backend: "claude-query",
      sourceRequestId: "release-stop",
      host: { epochKey: `epoch-stop-release-${stopOwner}`, emptyGraceMs: 0 },
    }),
  );
  backgroundWorkStore.requestStop({
    itemId: stopped.id,
    reason: "owner stopped it before launch",
    sourceRequestId: "release-stop-req",
  });
  assert.equal(backgroundWorkStore.getHost(stopped.hostId!)?.state, "closed");
  assert.equal(backgroundWorkStore.hostForOwner(stopOwner), undefined);

  // A LIVE epoch is different: a real query exists, so its closure and quiet
  // grace belong to the backend and terminalizing a child must not close it.
  const liveOwner = makeSession();
  const live = backgroundWorkStore.reserveItem(
    reserveInput(liveOwner, {
      backend: "claude-query",
      sourceRequestId: "keep-live",
      host: { epochKey: `epoch-live-${liveOwner}`, emptyGraceMs: 30_000 },
    }),
  );
  backgroundWorkStore.setHostState({ hostId: live.hostId!, state: "live" });
  backgroundWorkStore.terminalize({ itemId: live.id, state: "completed" });
  assert.equal(backgroundWorkStore.getHost(live.hostId!)?.state, "live");
});

test("an epoch something ran in is never released as an unused reservation", () => {
  // Observed work is executing on arrival, so its epoch is live from the start
  // — closing it as "nothing ever ran here" would free a slot a real query holds.
  const observedOwner = makeSession();
  const observed = backgroundWorkStore.observeItem(
    reserveInput(observedOwner, {
      backend: "claude-query",
      sourceRequestId: "no-release-observed",
      host: { epochKey: `epoch-obs-live-${observedOwner}`, emptyGraceMs: 0 },
    }),
  );
  assert.equal(backgroundWorkStore.getHost(observed.hostId!)?.state, "live");
  backgroundWorkStore.terminalize({ itemId: observed.id, state: "completed" });
  assert.equal(backgroundWorkStore.getHost(observed.hostId!)?.state, "live");

  // Reserved work that STARTED promotes its epoch itself, without waiting for
  // the backend to report the query live.
  const ranOwner = makeSession();
  const ran = backgroundWorkStore.reserveItem(
    reserveInput(ranOwner, {
      backend: "claude-query",
      sourceRequestId: "no-release-ran",
      host: { epochKey: `epoch-ran-${ranOwner}`, emptyGraceMs: 0 },
    }),
  );
  assert.equal(backgroundWorkStore.getHost(ran.hostId!)?.state, "creating");
  backgroundWorkStore.markRunning({ itemId: ran.id });
  assert.equal(backgroundWorkStore.getHost(ran.hostId!)?.state, "live");
  backgroundWorkStore.terminalize({ itemId: ran.id, state: "completed" });
  assert.equal(backgroundWorkStore.getHost(ran.hostId!)?.state, "live");

  // And a runtime failure is not a launch failure: `failLaunch` refuses a row
  // that already executed rather than guessing from the terminal state.
  const runtimeOwner = makeSession();
  const runtime = backgroundWorkStore.reserveItem(
    reserveInput(runtimeOwner, {
      backend: "claude-query",
      sourceRequestId: "no-release-runtime",
      host: { epochKey: `epoch-runtime-${runtimeOwner}`, emptyGraceMs: 0 },
    }),
  );
  backgroundWorkStore.markRunning({ itemId: runtime.id });
  assert.throws(
    () =>
      backgroundWorkStore.failLaunch({
        itemId: runtime.id,
        reason: "exited 1",
      }),
    BackgroundWorkValidationError,
  );
  backgroundWorkStore.terminalize({
    itemId: runtime.id,
    state: "failed",
    reason: "exited 1",
  });
  assert.equal(backgroundWorkStore.getHost(runtime.hostId!)?.state, "live");
});

test("an over-cap epoch never launders later work into an ordinary slot", () => {
  const blocking = makeSession();
  backgroundWorkStore.reserveItem(
    reserveInput(blocking, { sourceRequestId: "launder-blocker" }),
  );
  const limit = backgroundWorkStore.ownerSlotCount();
  const owner = makeSession();
  const host = { epochKey: `epoch-launder-${owner}`, emptyGraceMs: 0 };
  const overCap = backgroundWorkStore.observeItem(
    reserveInput(owner, {
      backend: "claude-query",
      sourceRequestId: "launder-observed",
      ownerLimit: limit,
      host,
    }),
  );
  assert.equal(overCap.provenance, "observed-over-cap");

  // Capacity frees up later — the blocker finishes AND the cap is generous, so
  // `claimOwnerSlot` would happily admit this. The epoch is the only thing left
  // that can refuse, which is exactly the path under test.
  backgroundWorkStore.terminalize({
    itemId: backgroundWorkStore.listItems({
      ownerSessionId: blocking,
      state: "active",
    })[0]!.id,
    state: "completed",
  });
  const roomyLimit = limit + 10;
  // The refusal names the EPOCH as the reason and reports the caller's real
  // limit: this is not ordinary cap exhaustion, and a fabricated zero cap would
  // be a lie in a public field.
  assert.throws(
    () =>
      backgroundWorkStore.reserveItem(
        reserveInput(owner, {
          backend: "claude-query",
          sourceRequestId: "launder-reserved",
          ownerLimit: roomyLimit,
          host,
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof BackgroundWorkOverCapEpochError);
      assert.ok(error instanceof BackgroundWorkCapacityError);
      assert.equal(error.limit, roomyLimit);
      assert.equal(error.epochKey, host.epochKey);
      assert.match(error.message, /recorded over capacity/);
      return true;
    },
  );

  // A further OBSERVATION inside it is still recorded — that is reporting
  // reality — but it inherits the epoch's provenance rather than adopting a
  // slot, so "held" cannot flap with whichever child happens to be active.
  const second = backgroundWorkStore.observeItem(
    reserveInput(owner, {
      backend: "claude-query",
      sourceRequestId: "launder-observed-2",
      ownerLimit: roomyLimit,
      host,
    }),
  );
  assert.equal(second.provenance, "observed-over-cap");
});

test("incoherent evidence is a named refusal, not a raw constraint failure", () => {
  const owner = makeSession();
  const item = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: "evidence-coherence" }),
  );
  backgroundWorkStore.markRunning({ itemId: item.id });
  assert.throws(
    () =>
      backgroundWorkStore.recordEvidence({
        itemId: item.id,
        sequence: 1,
        evidence: { originalBytes: 10, capturedBytes: 11 },
      }),
    BackgroundWorkValidationError,
  );
  assert.throws(
    () =>
      backgroundWorkStore.recordEvidence({
        itemId: item.id,
        sequence: 2,
        evidence: { truncated: true },
      }),
    BackgroundWorkValidationError,
  );
  // The merged result is what matters: a later call may supply only one half.
  backgroundWorkStore.recordEvidence({
    itemId: item.id,
    sequence: 3,
    evidence: { originalBytes: 100 },
  });
  assert.throws(
    () =>
      backgroundWorkStore.recordEvidence({
        itemId: item.id,
        sequence: 4,
        evidence: { capturedBytes: 101 },
      }),
    BackgroundWorkValidationError,
  );

  // An over-long artifact id repeats as the SAME artifact once normalized.
  const longArtifact = `artifact-${"q".repeat(400)}`;
  backgroundWorkStore.recordEvidence({
    itemId: item.id,
    sequence: 5,
    evidence: { artifactId: longArtifact, capturedBytes: 100 },
  });
  const repeated = backgroundWorkStore.recordEvidence({
    itemId: item.id,
    sequence: 6,
    evidence: { artifactId: longArtifact },
  });
  assert.equal(repeated.evidence?.artifactId?.length, 200);
});

test("host termination gives each child the outcome it actually had", () => {
  const owner = makeSession();
  const host = { epochKey: `epoch-fanout-${Date.now()}`, emptyGraceMs: 0 };
  const running = backgroundWorkStore.reserveItem(
    reserveInput(owner, {
      backend: "claude-query",
      sourceRequestId: "fanout-running",
      host,
    }),
  );
  const pending = backgroundWorkStore.reserveItem(
    reserveInput(owner, {
      backend: "claude-query",
      sourceRequestId: "fanout-pending",
      host,
    }),
  );
  const drained = backgroundWorkStore.reserveItem(
    reserveInput(owner, {
      backend: "claude-query",
      sourceRequestId: "fanout-drained",
      host,
    }),
  );
  backgroundWorkStore.markRunning({ itemId: running.id });
  backgroundWorkStore.markRunning({ itemId: drained.id });
  backgroundWorkStore.recordPlannedDrain({
    itemId: drained.id,
    reason: "stopped for deployment",
  });
  backgroundWorkStore.setHostState({ hostId: running.hostId!, state: "live" });
  backgroundWorkStore.setHostState({
    hostId: running.hostId!,
    state: "closed",
    reason: "owner closed the host",
  });

  assert.equal(backgroundWorkStore.getItem(running.id)?.state, "stopped");
  assert.equal(
    backgroundWorkStore.getItem(running.id)?.terminalReason,
    "stopped-by-host-close",
  );
  // Never launched, so it never stopped either.
  assert.equal(backgroundWorkStore.getItem(pending.id)?.state, "not-started");
  // The planned drain said something more specific than "the host closed".
  assert.equal(
    backgroundWorkStore.getItem(drained.id)?.terminalReason,
    "stopped for deployment",
  );

  const lostOwner = makeSession();
  const lost = backgroundWorkStore.reserveItem(
    reserveInput(lostOwner, {
      backend: "claude-query",
      sourceRequestId: "fanout-lost",
      host: { epochKey: `epoch-lost-${Date.now()}`, emptyGraceMs: 0 },
    }),
  );
  backgroundWorkStore.markRunning({ itemId: lost.id });
  backgroundWorkStore.setHostState({ hostId: lost.hostId!, state: "live" });
  backgroundWorkStore.setHostState({ hostId: lost.hostId!, state: "lost" });
  // Nobody observed this stopping — the epoch was lost, and so was its work.
  assert.equal(backgroundWorkStore.getItem(lost.id)?.state, "lost");
  assert.equal(
    backgroundWorkStore.getItem(lost.id)?.terminalReason,
    "host-lost",
  );
});

test("a live epoch keeps its owner visibly busy after its last child ends", () => {
  const owner = makeSession();
  const item = backgroundWorkStore.reserveItem(
    reserveInput(owner, {
      backend: "claude-query",
      sourceRequestId: "empty-host",
      host: { epochKey: `epoch-empty-${owner}`, emptyGraceMs: 30_000 },
    }),
  );
  backgroundWorkStore.markRunning({ itemId: item.id });
  backgroundWorkStore.setHostState({ hostId: item.hostId!, state: "live" });
  backgroundWorkStore.terminalize({ itemId: item.id, state: "completed" });

  const activity = backgroundWorkStore.activityByOwner().get(owner);
  assert.equal(activity?.activeCount, 0);
  assert.equal(activity?.retainedHost, true);
  // The query is still retained, so history may not be scrubbed yet either.
  assert.throws(
    () => backgroundWorkStore.deleteOwnerSession(owner),
    BackgroundWorkValidationError,
  );
  backgroundWorkStore.setHostState({ hostId: item.hostId!, state: "closed" });
  assert.equal(backgroundWorkStore.activityByOwner().get(owner), undefined);
  assert.deepEqual(backgroundWorkStore.deleteOwnerSession(owner).itemIds, [
    item.id,
  ]);
});

test("a provider id is unique per epoch, not globally", () => {
  const first = makeSession();
  const second = makeSession();
  const a = backgroundWorkStore.reserveItem(
    reserveInput(first, {
      backend: "claude-query",
      sourceRequestId: "scope-a",
      host: { epochKey: `epoch-scope-a-${first}`, emptyGraceMs: 0 },
    }),
  );
  const b = backgroundWorkStore.reserveItem(
    reserveInput(second, {
      backend: "claude-query",
      sourceRequestId: "scope-b",
      host: { epochKey: `epoch-scope-b-${second}`, emptyGraceMs: 0 },
    }),
  );
  backgroundWorkStore.bindProvider({ itemId: a.id, providerTaskId: "task_1" });
  // The same vendor id in a DIFFERENT query is a different task; only within
  // one epoch is it an identity.
  const bound = backgroundWorkStore.bindProvider({
    itemId: b.id,
    providerTaskId: "task_1",
  });
  assert.equal(bound.providerTaskId, "task_1");
});

test("an already-running item still advances its evidence cursor", () => {
  const owner = makeSession();
  const item = backgroundWorkStore.observeItem(
    reserveInput(owner, { sourceRequestId: "cursor-1" }),
  );
  assert.equal(item.state, "running");
  assert.equal(item.lastEventSeq, undefined);

  const seen = backgroundWorkStore.markRunning({
    itemId: item.id,
    eventId: "evt-5",
    sequence: 5,
  });
  assert.equal(seen.lastEventSeq, 5);
  // Without the advance, this older snapshot would still be accepted and could
  // rewind what the newer one already told us.
  const older = backgroundWorkStore.recordEvidence({
    itemId: item.id,
    eventId: "evt-4",
    sequence: 4,
    evidence: { capturedBytes: 1 },
  });
  assert.equal(older.evidence, undefined);
});

test("an over-long source identity is idempotent under its stored form", () => {
  const owner = makeSession();
  const longId = `toolu_${"z".repeat(400)}`;
  const first = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: longId }),
  );
  // The retry must find the row the truncated identity was stored under rather
  // than colliding with the uniqueness constraint.
  const retry = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: longId }),
  );
  assert.equal(retry.id, first.id);
  assert.equal(first.sourceRequestId.length, 200);
});

test("a stop attempt cannot be claimed before the handle it would target exists", () => {
  const owner = makeSession();
  const item = backgroundWorkStore.reserveItem(
    reserveInput(owner, {
      backend: "claude-query",
      sourceRequestId: "attempt-guard",
      host: { epochKey: `epoch-attempt-${owner}`, emptyGraceMs: 0 },
    }),
  );
  backgroundWorkStore.markRunning({ itemId: item.id });
  backgroundWorkStore.requestStop({
    itemId: item.id,
    reason: "deadline",
    sourceRequestId: "attempt-guard-req",
  });
  assert.equal(
    backgroundWorkStore.getItem(item.id)?.stopState,
    "awaiting-binding",
  );
  assert.throws(
    () => backgroundWorkStore.recordStopAttempt({ itemId: item.id }),
    BackgroundWorkValidationError,
  );
  backgroundWorkStore.bindProvider({
    itemId: item.id,
    providerTaskId: "task-attempt",
  });
  assert.equal(
    backgroundWorkStore.recordStopAttempt({ itemId: item.id }).stopAttempts,
    1,
  );
});

test("a pinned evidence artifact is never silently repointed", () => {
  const owner = makeSession();
  const item = backgroundWorkStore.reserveItem(
    reserveInput(owner, { sourceRequestId: "artifact-pin" }),
  );
  backgroundWorkStore.markRunning({ itemId: item.id });
  backgroundWorkStore.recordEvidence({
    itemId: item.id,
    sequence: 1,
    evidence: {
      artifactId: "artifact-a",
      originalBytes: 10,
      capturedBytes: 10,
    },
  });
  assert.throws(
    () =>
      backgroundWorkStore.recordEvidence({
        itemId: item.id,
        sequence: 2,
        evidence: { artifactId: "artifact-b" },
      }),
    BackgroundWorkValidationError,
  );
  assert.equal(
    backgroundWorkStore.getItem(item.id)?.evidence?.artifactId,
    "artifact-a",
  );
});
