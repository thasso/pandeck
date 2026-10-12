/**
 * A frozen-deadline fact stays owed across a restart until it is delivered,
 * held or not, while nothing older is announced and nothing is re-run. Each
 * phase is a SEPARATE Node process on the same temporary database, wired the
 * way `index.ts` wires delivery; only the backend port, the clock and the turn
 * itself are fakes.
 *   pnpm --filter @assistant/server test src/backgroundDeadlineRestart.test.ts
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, test } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "background-deadline-restart-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const url = (path: string) => new URL(path, import.meta.url).href;

/**
 * Owners, each one crash window:
 *  cut        Never held; its deadline fact was saved, the process died before
 *             the offer.
 *  busy       Never held; the offer found it busy, then the process died.
 *  held       Held when the deadline hit, still held at the restart.
 *  resumed    Held when the deadline hit, resumed, died before the offer.
 *  delivered  Never held; delivered before the restart.
 *  explicit   Its agent stopped the work itself: deferred, as before.
 *  legacy     A completion owed before this change and never Stop-touched.
 *  inflight   Its deadline Stop was still unacknowledged at the crash.
 */
const script = `
  const phase = process.argv[1];
  if (!process.env.DATA_DIR?.startsWith(${JSON.stringify(tmpdir())}))
    throw new Error("refusing to run outside a temporary DATA_DIR");
  const hold = await import(${JSON.stringify(url("./automaticTurnHold.ts"))});
  const { sessionStore } = await import(${JSON.stringify(url("./db/sessionStore.ts"))});
  const { backgroundWorkStore } = await import(${JSON.stringify(url("./db/backgroundWorkStore.ts"))});
  const { backgroundDeliveryOutboxStore } = await import(${JSON.stringify(url("./db/backgroundDeliveryOutboxStore.ts"))});
  const { BackgroundCompletionDelivery } = await import(${JSON.stringify(url("./backgroundWork/completionDelivery.ts"))});
  const { BackgroundWorkSupervisor } = await import(${JSON.stringify(url("./backgroundWork/supervisor.ts"))});
  const { updateSettings } = await import(${JSON.stringify(url("./settings.ts"))});
  const notices = await import(${JSON.stringify(url("./backgroundCompletionNotices.ts"))});
  const { reconcileBackgroundWorkOnBoot } = await import(${JSON.stringify(url("./backgroundWorkBoot.ts"))});
  const owners = ["cut", "busy", "held", "resumed", "delivered", "explicit", "legacy", "inflight"];
  const offered = [];
  const answer = {};
  const hang = new Set();
  const delivery = new BackgroundCompletionDelivery({
    // A hung peer phase is the process dying before the offer.
    drainPeers: (sessionId) => hang.has(sessionId) ? new Promise(() => {}) : Promise.resolve(),
    held: hold.automaticTurnsHeld,
    disposition: notices.completionDisposition,
    outbox: notices.backgroundDeliveryOutbox,
    offer: async (sessionId, offer) => {
      const result = answer[sessionId] ?? "delivered";
      offered.push({ sessionId, result, block: offer.contextBlock });
      return result;
    },
  });
  let launches = 0;
  const stops = [];
  let now = 1000;
  const timers = [];
  const clock = {
    now: () => now,
    schedule: (delay, callback) => {
      const timer = { at: now + Math.max(0, delay), callback, off: false };
      timers.push(timer);
      return { cancel: () => (timer.off = true) };
    },
  };
  const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
  const advanceTo = async (at) => {
    for (;;) {
      const next = timers.filter((t) => !t.off && t.at <= at).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.off = true;
      now = next.at;
      next.callback();
      await settle();
    }
    now = at;
    await settle();
  };
  const port = {
    backend: "host-process",
    launch: async () => { launches += 1; return { launched: true }; },
    stop: (request) => {
      stops.push(request.target.itemId);
      return request.target.ownerSessionId === "inflight"
        ? new Promise(() => {})
        : Promise.resolve({ acknowledged: true });
    },
    stopAll: async () => ({ acknowledgedItemIds: [], unconfirmedItemIds: [] }),
  };
  const supervisor = new BackgroundWorkSupervisor({
    ports: [port],
    clock,
    completionRecorded: (item) => notices.enqueueCompletionNotice(delivery, item, false),
  });
  const out = { phase, items: {} };
  if (phase === "seed") {
    updateSettings({ backgroundWork: { enabled: true, ownerSessionCap: 20, taskLifetimeMinutes: 60, claudeEmptyHostGraceSeconds: 30 } });
    for (const id of owners)
      sessionStore.upsert({ id, scope: "user", harness: "pi", agentType: "developer", title: "restart " + id });
    // Owed before this change: a plain completion, never Stop-touched.
    const old = backgroundWorkStore.reserveItem({
      ownerSessionId: "legacy", backend: "host-process", kind: "shell", label: "old",
      sourceRequestId: "legacy:old", lifetimeMs: 60000, settingsGeneration: 1,
      bootEpoch: "seed", ownerLimit: 100,
    });
    const oldDone = backgroundWorkStore.terminalize({ itemId: old.id, state: "completed" });
    backgroundDeliveryOutboxStore.save({ sessionId: "legacy", itemId: oldDone.id, revision: oldDone.revision, disposition: "wake", retained: false });
    out.items.legacy = old.id;

    const items = {};
    for (const id of owners.filter((o) => o !== "legacy")) {
      const admission = supervisor.admit({
        ownerSessionId: id, backend: "host-process", kind: "shell",
        label: "full test run " + id, sourceRequestId: "run:" + id,
      });
      if (!admission.admitted) throw new Error("not admitted: " + id);
      items[id] = await supervisor.launch(admission);
      out.items[id] = items[id].id;
    }
    hold.holdAutomaticTurns("held");
    hold.holdAutomaticTurns("resumed");
    answer.busy = "busy";
    hang.add("cut");
    // The agent stops its own work, and the provider reports it.
    let ack;
    port.stop = (request) => request.target.ownerSessionId === "explicit"
      ? new Promise((resolve) => (ack = resolve))
      : port.stopDefault(request);
    port.stopDefault = (request) => {
      stops.push(request.target.itemId);
      return request.target.ownerSessionId === "inflight"
        ? new Promise(() => {})
        : Promise.resolve({ acknowledged: true });
    };
    const explicit = supervisor.stopOne({
      itemId: items.explicit.id, ownerSessionId: "explicit",
      sourceRequestId: "agent-stop", reason: "not needed",
    });
    await settle();
    supervisor.completed({ itemId: items.explicit.id, state: "stopped" });
    ack({ acknowledged: true });
    await explicit;
    // Every remaining item reaches its frozen deadline together.
    await advanceTo(items.cut.deadlineAt);
    hang.add("resumed");
    hold.resumeAutomaticTurns("resumed");
    void delivery.requestDrain("resumed");
    for (const id of ["busy", "delivered", "held", "explicit", "inflight"]) await delivery.drain(id);
    await settle();
    out.stillHeld = hold.automaticTurnsHeld("held");
    out.outbox = backgroundDeliveryOutboxStore.list().map((row) => [row.sessionId, row.disposition, row.retained]);
    out.states = Object.fromEntries(owners.map((id) => [id, backgroundWorkStore.getItem(out.items[id]).state]));
    out.inflightStop = backgroundWorkStore.getItem(out.items.inflight).stopState;
  } else {
    reconcileBackgroundWorkOnBoot();
    if (phase === "reboot") for (const id of owners) hold.holdAutomaticTurns(id);
    out.restore = notices.restoreOwedBackgroundDelivery(delivery);
    for (const id of owners) await delivery.drain(id);
    out.offeredAtBoot = offered.map((o) => o.sessionId);
    out.stillHeld = hold.automaticTurnsHeld("held");
    for (const id of owners) hold.resumeAutomaticTurns(id);
    for (const id of owners) await delivery.requestDrain(id);
    out.blocks = Object.fromEntries(offered.map((o) => [o.sessionId, o.block]));
    out.deferred = owners.filter((id) => delivery.peekDeferredContext(id));
    out.inflight = backgroundWorkStore.getItem(process.argv[2]);
  }
  out.offered = offered.map((o) => o.sessionId + ":" + o.result);
  out.launches = launches;
  out.stops = stops.length;
  console.log("RESULT " + JSON.stringify(out));
  process.exit(0);
`;

async function runPhase(
  phase: string,
  inflightItem = "",
): Promise<Record<string, any>> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      script,
      phase,
      inflightItem,
    ],
    {
      // `src/test/setup.ts` already pointed ASSISTANT_CONFIG at its fixture.
      env: { ...process.env, DATA_DIR: dataDir, ASSISTANT_CWD: dataDir },
      timeout: 60_000,
    },
  );
  const line = stdout
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("RESULT "));
  assert.ok(line, `phase ${phase} reported nothing:\n${stdout}`);
  return JSON.parse(line.slice("RESULT ".length)) as Record<string, any>;
}

test("a deadline fact survives a restart until delivered, and nothing older is announced", async () => {
  assert.ok(process.env.ASSISTANT_CONFIG?.startsWith(tmpdir()));
  const seed = await runPhase("seed");
  assert.deepEqual(seed.states, {
    cut: "stopped",
    busy: "stopped",
    held: "stopped",
    resumed: "stopped",
    delivered: "stopped",
    explicit: "stopped",
    legacy: "completed",
    inflight: "running",
  });
  assert.equal(seed.inflightStop, "requested");
  assert.equal(seed.stillHeld, true, "a deadline never lifts the hold");
  // A busy owner is offered on every drain; nobody else before the restart.
  assert.deepEqual([...new Set(seed.offered)].sort(), [
    "busy:busy",
    "delivered:delivered",
  ]);
  assert.deepEqual(
    seed.outbox.sort(),
    [
      ["busy", "wake", true],
      ["cut", "wake", true],
      ["explicit", "defer", false],
      ["held", "wake", true],
      ["legacy", "wake", false],
      ["resumed", "wake", true],
    ],
    "deadline facts are retained held or not; the explicit Stop keeps its old rule",
  );
  assert.equal(seed.launches, 7);

  const boot = await runPhase("boot", seed.items.inflight);
  assert.deepEqual(
    boot.restore,
    { restored: 4, forgotten: 2 },
    "the explicit and legacy rows are forgotten as before",
  );
  assert.deepEqual(
    boot.offeredAtBoot.sort(),
    ["busy", "cut", "resumed"],
    "unheld owners are offered at boot; the held one is not",
  );
  assert.equal(boot.stillHeld, true);
  assert.deepEqual(boot.offered.sort(), [
    "busy:delivered",
    "cut:delivered",
    "held:delivered",
    "resumed:delivered",
  ]);
  for (const owner of ["busy", "cut", "held", "resumed"]) {
    assert.match(boot.blocks[owner], new RegExp(seed.items[owner]));
    assert.match(boot.blocks[owner], /Stopped by PA at its frozen deadline/);
  }
  assert.deepEqual(boot.deferred, [], "the explicit fact is not replayed");
  // The Stop in flight at the crash: lost, not stopped, never re-run, and no
  // notice — restart resumes nothing.
  assert.equal(boot.inflight.state, "lost");
  assert.equal(boot.inflight.terminalReason, "server-restart");
  assert.equal(boot.launches, 0);
  assert.equal(boot.stops, 0);

  const reboot = await runPhase("reboot", seed.items.inflight);
  assert.deepEqual(reboot.restore, { restored: 0, forgotten: 0 });
  assert.deepEqual(reboot.offered, []);
  assert.deepEqual(reboot.deferred, []);
}, 180_000);
