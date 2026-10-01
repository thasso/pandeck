/**
 * Automatic archival of settled sessions (Task-696): the seven-day policy,
 * every reason a settled row is still left alone, the one-batch backfill, the
 * best-effort schedule, and the default list scaling with the ACTIVE rows.
 *   pnpm --filter @assistant/server test src/sessionRetention.test.ts
 */
import assert from "node:assert/strict";
import type { SessionListItem, ServerMessage } from "@assistant/shared";
import { afterEach, test, vi } from "vitest";
import { Connection } from "./connection.ts";
import { getDb } from "./db/index.ts";
import { sessionStore } from "./db/sessionStore.ts";
import * as workflowStore from "./db/workflowStore.ts";
import { hub } from "./hub.ts";
import { listSessions, type LiveListInfo } from "./sessions.ts";
import {
  SESSION_AUTO_ARCHIVE_AFTER_MS,
  SESSION_AUTO_ARCHIVE_SWEEP_INTERVAL_MS,
  selectSettledArchiveCandidates,
  startSessionAutoArchiveSweep,
  stopSessionAutoArchiveSweep,
  sweepSettledSessionArchive,
} from "./sessionRetention.ts";
import {
  CODE_DELIVERY_RECIPE_ID,
  CODE_DELIVERY_RECIPE_VERSION,
} from "./workflow/codeDeliveryRecipe.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
/** Settled one day past the policy: eligible unless something else holds it. */
const OLD = NOW - SESSION_AUTO_ARCHIVE_AFTER_MS - DAY_MS;

let n = 0;
const created: string[] = [];
let taskCounter = 900_000;

afterEach(() => {
  stopSessionAutoArchiveSweep();
  vi.restoreAllMocks();
  vi.useRealTimers();
  getDb().exec("BEGIN");
  for (const id of created.splice(0)) sessionStore.remove(id);
  getDb().exec("COMMIT");
});

function seed(
  label: string,
  opts: { settledAt?: number; messageCount?: number; purpose?: string } = {},
): string {
  const id = `retention-${label}-${NOW}-${n++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: `Settled ${label}`,
    messageCount: opts.messageCount ?? 2,
    updatedAt: OLD - DAY_MS,
    ...(opts.purpose ? { purpose: opts.purpose } : {}),
  });
  if (opts.settledAt !== undefined)
    sessionStore.setSettled(id, true, opts.settledAt);
  created.push(id);
  return id;
}

function row(
  id: string,
  extra: Partial<SessionListItem> = {},
  settled = true,
): SessionListItem {
  return {
    id,
    harness: "pi",
    agentType: "assistant",
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 2,
    forkAutoRenamePending: false,
    isStreaming: false,
    awaitingInput: false,
    unread: false,
    ...(settled ? { settledAt: OLD } : {}),
    ...extra,
  };
}

function backgroundActivity(
  activeCount: number,
): NonNullable<SessionListItem["backgroundActivity"]> {
  return {
    activeCount,
    shellCount: activeCount,
    monitorCommandCount: 0,
    monitorWebsocketCount: 0,
    startingCount: 0,
    stoppingCount: 0,
    oldestStartedAt: 1,
  };
}

const nobody = {
  now: NOW,
  viewed: new Set<string>(),
  runOwned: new Set<string>(),
};

const select = (
  rows: SessionListItem[],
  ctx: Partial<typeof nobody> = {},
): string[] => selectSettledArchiveCandidates(rows, { ...nobody, ...ctx });

/* --------------------------------- policy --------------------------------- */

test("the policy is seven days after the LATEST settlement", () => {
  assert.equal(SESSION_AUTO_ARCHIVE_AFTER_MS, 7 * DAY_MS);
  assert.equal(SESSION_AUTO_ARCHIVE_SWEEP_INTERVAL_MS, 60 * 60 * 1000);
  const cutoff = NOW - SESSION_AUTO_ARCHIVE_AFTER_MS;
  assert.deepEqual(
    select([
      row("exactly", { settledAt: cutoff }),
      row("one-ms-short", { settledAt: cutoff + 1 }),
      row("never", {}, false),
      row("archived-already", { archived: true }),
    ]),
    ["exactly"],
  );
});

test("a session whose latest outcome is unacknowledged is not settled, however old its mark", async () => {
  // The projection withholds `settledAt` from a woken row; the store recheck
  // refuses it too, so neither half can archive it on its own.
  const woken = seed("woken", { settledAt: OLD });
  sessionStore.recordSessionOutcome(woken, "completed");
  const acknowledged = seed("acknowledged");
  sessionStore.recordSessionOutcome(acknowledged, "failed");
  sessionStore.setSettled(acknowledged, true, OLD, 1);

  const rows = await hub.listSessions();
  assert.equal(rows.find((r) => r.id === woken)?.settledAt, undefined);
  assert.equal(rows.find((r) => r.id === acknowledged)?.settledAt, OLD);

  const archived = await sweepSettledSessionArchive(NOW);
  assert.ok(archived.includes(acknowledged));
  assert.ok(!archived.includes(woken));
  assert.equal(sessionStore.get(woken)?.archivedAt, undefined);
});

test("every dynamic blocker the Settle action honours holds a session back", () => {
  const blocked: Array<[string, Partial<SessionListItem>]> = [
    ["running", { isStreaming: true }],
    [
      "delegating",
      {
        delegation: {
          activeCount: 1,
          startingCount: 0,
          workingCount: 1,
          awaitingParentCount: 0,
        },
      },
    ],
    ["background", { backgroundActivity: backgroundActivity(1) }],
    [
      "retained-host",
      { backgroundActivity: { ...backgroundActivity(0), retainedHost: true } },
    ],
    ["approval", { attention: "approval", awaitingInput: true }],
    ["question", { attention: "question", awaitingInput: true }],
    ["task-choice", { attention: "task-choice", awaitingInput: true }],
    ["awaiting", { awaitingInput: true }],
    ["queued", { queuedWork: true }],
  ];
  const rows = [...blocked.map(([id, extra]) => row(id, extra)), row("idle")];
  assert.deepEqual(select(rows), ["idle"]);
});

test("a viewed session and a Workflow Run's role session are skipped", () => {
  const rows = [row("viewed"), row("role"), row("free")];
  assert.deepEqual(
    select(rows, { viewed: new Set(["viewed"]), runOwned: new Set(["role"]) }),
    ["free"],
  );
});

/* --------------------------------- sweep ---------------------------------- */

test("the sweep archives old settled sessions in one batch with one broadcast, skipping what is viewed", async () => {
  const viewed = seed("viewed", { settledAt: OLD });
  const eligible = Array.from({ length: 12 }, (_, i) =>
    seed(`eligible-${i}`, { settledAt: OLD }),
  );
  const fresh = seed("fresh", { settledAt: NOW - DAY_MS });
  const draft = seed("draft", {
    settledAt: OLD,
    messageCount: 0,
    purpose: "draft",
  });
  const empty = seed("empty", { settledAt: OLD, messageCount: 0 });
  const batch = vi.spyOn(sessionStore, "archiveSettledBatch");
  const broadcast = vi
    .spyOn(hub, "broadcastSessions")
    .mockResolvedValue(undefined);
  const viewer = {
    send: (_message: ServerMessage) => undefined,
    viewingSessionId: () => viewed,
  };
  hub.register(viewer);

  try {
    const archived = await sweepSettledSessionArchive(NOW);

    assert.deepEqual(
      new Set(archived),
      new Set([...eligible, draft]),
      "every old settled listable row, the draft included, and nothing viewed, fresh or empty",
    );
    assert.equal(batch.mock.calls.length, 1, "one store transaction");
    assert.equal(broadcast.mock.calls.length, 1, "one list broadcast");
    assert.equal(sessionStore.get(viewed)?.archivedAt, undefined);
    assert.equal(sessionStore.get(fresh)?.archivedAt, undefined);
    assert.equal(
      sessionStore.get(empty)?.archivedAt,
      undefined,
      "a zero-message claim is not a conversation and never reaches the list",
    );

    // Nothing is destroyed: the rows are read by id, listed by the archive
    // view, counted, and restorable.
    const first = eligible[0]!;
    assert.ok(sessionStore.get(first), "a direct link still resolves the id");
    const defaults = await hub.listSessions();
    assert.ok(!defaults.some((r) => r.id === first));
    const archive = await hub.listSessions({ includeArchived: true });
    assert.equal(archive.find((r) => r.id === first)?.archived, true);
    assert.ok((await hub.archivedSessionCount()) >= eligible.length);
    sessionStore.setArchived(first, false);
    assert.ok((await hub.listSessions()).some((r) => r.id === first));
    // A bare store restore keeps the old settlement, so the next sweep takes
    // it again; the user's Restore action unsettles as well (below).
    hub.unregister(viewer);
    assert.deepEqual(
      new Set(await sweepSettledSessionArchive(NOW)),
      new Set([viewed, first]),
      "the view closing made the viewed session eligible",
    );
    assert.equal(broadcast.mock.calls.length, 2);
    // A sweep with nothing to do writes and broadcasts nothing.
    assert.deepEqual(await sweepSettledSessionArchive(NOW), []);
    assert.equal(
      broadcast.mock.calls.length,
      2,
      "no broadcast without a change",
    );
  } finally {
    hub.unregister(viewer);
  }
});

test("a role session of a working-set Workflow Run stays, even while idle", async () => {
  const implementer = seed("implementer", { settledAt: OLD });
  const bystander = seed("bystander", { settledAt: OLD });
  const run = workflowStore.createRun({
    taskId: ++taskCounter,
    recipeId: CODE_DELIVERY_RECIPE_ID,
    recipeVersion: CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: 2,
    maxReviewPasses: 1,
    actor: { kind: "user" },
  });
  const step = workflowStore.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { role: "implementer" },
    actor: { kind: "system" },
  });
  workflowStore.startStep(
    step.id,
    { kind: "session", id: implementer },
    { kind: "system" },
  );
  workflowStore.completeStep(step.id, {
    status: "completed",
    result: { status: "completed", summary: "implemented" },
    actor: { kind: "system" },
  });
  vi.spyOn(hub, "broadcastSessions").mockResolvedValue(undefined);

  try {
    const archived = await sweepSettledSessionArchive(NOW);
    assert.ok(archived.includes(bystander));
    assert.ok(!archived.includes(implementer), "the run still owns it");
  } finally {
    workflowStore.requestRunCancellation(run.id, { kind: "user" });
    workflowStore.setRunLifecycle(run.id, "cancelled", {
      actor: { kind: "user" },
    });
    workflowStore.deleteCancelledRun(run.id);
  }
});

test("the user's Restore brings a session back into the working set, so retention does not take it again", async () => {
  const id = seed("restored", { settledAt: OLD });
  vi.spyOn(hub, "broadcastSessions").mockResolvedValue(undefined);
  assert.deepEqual(await sweepSettledSessionArchive(NOW), [id]);
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: () => undefined,
  } as unknown as ConstructorParameters<typeof Connection>[0]);

  await connection.handle({ type: "archiveSession", id, archived: false });

  assert.equal(sessionStore.get(id)?.archivedAt, undefined);
  assert.equal(sessionStore.isSettled(id), false, "restored = unsettled");
  assert.deepEqual(await sweepSettledSessionArchive(NOW), []);
  assert.ok((await hub.listSessions()).some((r) => r.id === id));
});

test("a Connection reports the session it is showing", () => {
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: () => undefined,
  } as unknown as ConstructorParameters<typeof Connection>[0]);
  hub.register(connection);
  try {
    assert.equal(connection.viewingSessionId(), undefined);
    assert.ok(!hub.viewedSessionIds().has("shown"));
    (connection as unknown as { viewing: { id: string } }).viewing = {
      id: "shown",
    };
    assert.equal(connection.viewingSessionId(), "shown");
    assert.ok(hub.viewedSessionIds().has("shown"));
  } finally {
    hub.unregister(connection);
  }
});

test("the sweep runs one at a time, and the schedule survives a failed run", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const list = vi.spyOn(hub, "listSessions");

  // Overlap: a second invocation while the first is still reading answers
  // empty without a second read.
  let release!: (rows: Awaited<ReturnType<typeof hub.listSessions>>) => void;
  list.mockImplementationOnce(
    () => new Promise((resolve) => (release = resolve)),
  );
  const first = sweepSettledSessionArchive(NOW);
  assert.deepEqual(await sweepSettledSessionArchive(NOW), []);
  await vi.waitFor(() => assert.equal(list.mock.calls.length, 1));
  release([]);
  assert.deepEqual(await first, []);
  assert.equal(list.mock.calls.length, 1);

  // Boot: a failing sweep is logged, and startup is unaffected.
  list.mockRejectedValueOnce(new Error("injected boot failure"));
  assert.doesNotThrow(() => startSessionAutoArchiveSweep());
  await vi.advanceTimersByTimeAsync(0);
  assert.match(String(warn.mock.calls[0]?.[0]), /boot auto-archive/);

  // Hourly: the next tick retries, and a failure there is logged the same way.
  list.mockRejectedValueOnce(new Error("injected hourly failure"));
  await vi.advanceTimersByTimeAsync(SESSION_AUTO_ARCHIVE_SWEEP_INTERVAL_MS);
  assert.match(String(warn.mock.calls[1]?.[0]), /hourly auto-archive/);
  list.mockResolvedValueOnce([]);
  await vi.advanceTimersByTimeAsync(SESSION_AUTO_ARCHIVE_SWEEP_INTERVAL_MS);
  assert.equal(list.mock.calls.length, 4, "each hour reads again");
  assert.equal(warn.mock.calls.length, 2);
  startSessionAutoArchiveSweep(); // idempotent: no second boot sweep
  assert.equal(list.mock.calls.length, 4);
});

/* ------------------------------ list scaling ------------------------------ */

test("the default projection reads only unarchived rows and never reintroduces an archived runtime", async () => {
  const active = seed("active");
  const archived = seed("archived");
  sessionStore.setArchived(archived, true);
  const storeList = vi.spyOn(sessionStore, "list");
  const readAt = () => 0;
  const liveArchived: LiveListInfo = {
    kind: "assistant",
    sessionId: archived,
    file: `/tmp/${archived}.jsonl`,
    title: "Still in memory",
    messageCount: 3,
    isStreaming: false,
    awaitingInput: false,
    updatedAt: NOW,
  };

  const defaults = await listSessions([liveArchived], readAt);
  assert.deepEqual(storeList.mock.calls.at(-1), [{ excludeArchived: true }]);
  assert.ok(defaults.some((r) => r.id === active));
  assert.ok(
    !defaults.some((r) => r.id === archived),
    "the live runtime of an archived session does not ride back into the list",
  );

  const archive = await listSessions([liveArchived], readAt, {
    includeArchived: true,
  });
  assert.deepEqual(storeList.mock.calls.at(-1), [{}]);
  assert.equal(archive.find((r) => r.id === archived)?.archived, true);
});
