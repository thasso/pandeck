/**
 * A frozen-deadline fact is owed from the instant its terminal row COMMITS. Each
 * crash phase below is a separate Node process on one temporary database that
 * dies inside the store's post-commit state-change notifier — after the
 * terminal row is durable and before `terminalize` returns to the supervisor,
 * so before the delivery queue ever sees the fact. Boot must still deliver it.
 * Production supervisor, admission, Stop, store, notices and restore; only the
 * backend port, the clock and the turn itself are fakes.
 *   pnpm --filter @assistant/server test src/backgroundDeadlineCrash.test.ts
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, test } from "vitest";

const root = mkdtempSync(join(tmpdir(), "background-deadline-crash-"));
const dataDir = join(root, "data");
const home = join(root, "home");
mkdirSync(dataDir);
mkdirSync(home);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const url = (path: string) => new URL(path, import.meta.url).href;

const script = `
  import { writeSync } from "node:fs";
  const [phase, owner, path] = process.argv.slice(1);
  const root = ${JSON.stringify(root)};
  globalThis.fetch = async () => { throw new Error("network is closed in this test"); };
  const { DATA_DIR } = await import(${JSON.stringify(url("./config.ts"))});
  if (!DATA_DIR.startsWith(root + "/") || !process.env.HOME.startsWith(root + "/") || !process.env.ASSISTANT_CONFIG.startsWith(${JSON.stringify(tmpdir())}))
    throw new Error("refusing to run outside the disposable directories: " + DATA_DIR);
  const hold = await import(${JSON.stringify(url("./automaticTurnHold.ts"))});
  const { sessionStore } = await import(${JSON.stringify(url("./db/sessionStore.ts"))});
  const store = await import(${JSON.stringify(url("./db/backgroundWorkStore.ts"))});
  const { backgroundDeliveryOutboxStore } = await import(${JSON.stringify(url("./db/backgroundDeliveryOutboxStore.ts"))});
  const { BackgroundCompletionDelivery } = await import(${JSON.stringify(url("./backgroundWork/completionDelivery.ts"))});
  const { BackgroundWorkSupervisor } = await import(${JSON.stringify(url("./backgroundWork/supervisor.ts"))});
  const { updateSettings } = await import(${JSON.stringify(url("./settings.ts"))});
  const notices = await import(${JSON.stringify(url("./backgroundCompletionNotices.ts"))});
  const { reconcileBackgroundWorkOnBoot } = await import(${JSON.stringify(url("./backgroundWorkBoot.ts"))});
  const { backgroundWorkStore } = store;
  const report = (out) => writeSync(1, "RESULT " + JSON.stringify(out) + "\\n");
  const offered = [];
  const enqueued = [];
  const delivery = new BackgroundCompletionDelivery({
    drainPeers: async () => {},
    held: hold.automaticTurnsHeld,
    disposition: notices.completionDisposition,
    outbox: notices.backgroundDeliveryOutbox,
    offer: async (sessionId, offer, key) => {
      offered.push({ sessionId, key, block: offer.contextBlock });
      return "delivered";
    },
  });
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
  };
  let launches = 0;
  const port = {
    backend: "host-process",
    launch: async () => { launches += 1; return { launched: true }; },
    // ACK-first acknowledges; provider-first never does, the provider reports.
    stop: () => path === "ack" ? Promise.resolve({ acknowledged: true }) : new Promise(() => {}),
    stopAll: async () => ({ acknowledgedItemIds: [], unconfirmedItemIds: [] }),
  };
  const supervisor = new BackgroundWorkSupervisor({
    ports: [port],
    clock,
    completionRecorded: (item) => {
      enqueued.push(item.id);
      notices.enqueueCompletionNotice(delivery, item, false);
    },
  });
  if (phase === "crash") {
    updateSettings({ backgroundWork: { enabled: true, ownerSessionCap: 20, taskLifetimeMinutes: 60, claudeEmptyHostGraceSeconds: 30 } });
    sessionStore.upsert({ id: owner, scope: "user", harness: "pi", agentType: "developer", title: "crash " + owner });
    const admission = supervisor.admit({
      ownerSessionId: owner, backend: "host-process", kind: "shell",
      label: "full test run", sourceRequestId: "run:" + owner,
    });
    if (!admission.admitted) throw new Error("not admitted");
    const item = await supervisor.launch(admission);
    if (owner.endsWith("-held")) hold.holdAutomaticTurns(owner);
    // The moment the terminal row is observable, after COMMIT: record what is
    // durable, then die before the supervisor regains control.
    store.setBackgroundWorkStateChangeNotifier((change) => {
      const row = backgroundWorkStore.getItem(item.id);
      if (!change.itemIds.includes(item.id) || row.state !== "stopped") return;
      report({
        phase, item: item.id, state: row.state, origin: row.stopOrigin,
        held: hold.automaticTurnsHeld(owner),
        revision: row.revision, enqueued,
        outbox: backgroundDeliveryOutboxStore.list().filter((r) => r.itemId === item.id),
      });
      process.exit(91);
    });
    await advanceTo(item.deadlineAt);
    if (path === "provider") supervisor.completed({ itemId: item.id, state: "stopped" });
    await settle();
    report({ phase, survived: true });
    process.exit(0);
  }
  reconcileBackgroundWorkOnBoot();
  const out = { phase };
  out.restore = notices.restoreOwedBackgroundDelivery(delivery);
  for (const id of ["ack-unheld", "ack-held", "provider-unheld", "provider-held"]) await delivery.drain(id);
  out.offeredAtBoot = offered.map((o) => o.sessionId);
  out.stillHeld = ["ack-held", "provider-held"].filter((id) => hold.automaticTurnsHeld(id));
  for (const id of ["ack-held", "provider-held"]) {
    hold.resumeAutomaticTurns(id);
    await delivery.requestDrain(id);
  }
  out.offered = offered.map((o) => ({ sessionId: o.sessionId, key: o.key, deadline: o.block.includes("Stopped by PA at its frozen deadline") }));
  out.outbox = backgroundDeliveryOutboxStore.list();
  out.launches = launches;
  report(out);
  process.exit(0);
`;

async function run(
  args: string[],
): Promise<{ code: number; result: Record<string, any> }> {
  let stdout = "";
  let code = 0;
  try {
    ({ stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, ...args],
      {
        // `src/test/setup.ts` already pointed ASSISTANT_CONFIG at its fixture.
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          ASSISTANT_CWD: root,
          HOME: home,
        },
        timeout: 60_000,
      },
    ));
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    code = failed.code ?? -1;
    stdout = failed.stdout ?? "";
    if (code !== 91) throw new Error(`${args.join(" ")}: ${failed.stderr}`);
  }
  const line = stdout
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("RESULT "));
  assert.ok(line, `${args.join(" ")} reported nothing:\n${stdout}`);
  return { code, result: JSON.parse(line.slice("RESULT ".length)) };
}

test("a crash right after the deadline's terminal commit still owes and delivers the fact once", async () => {
  assert.ok(process.env.ASSISTANT_CONFIG?.startsWith(tmpdir()));
  const items: Record<string, string> = {};
  for (const path of ["ack", "provider"])
    for (const held of ["unheld", "held"]) {
      const owner = `${path}-${held}`;
      const { code, result } = await run(["crash", owner, path]);
      assert.equal(code, 91, `${owner}: died inside the post-commit notifier`);
      assert.equal(result.state, "stopped");
      assert.equal(result.origin, "deadline");
      assert.equal(result.held, held === "held", `${owner}: hold as set up`);
      assert.deepEqual(result.enqueued, [], `${owner}: queue never saw it`);
      // The receipt is already durable when the terminal row is observable.
      assert.deepEqual(
        result.outbox.map((row: Record<string, unknown>) => [
          row.sessionId,
          row.revision,
          row.disposition,
          row.retained,
        ]),
        [[owner, result.revision, "wake", true]],
        `${owner}: receipt committed with the terminal row`,
      );
      items[owner] = result.item;
    }

  const boot = await run(["boot", "", ""]);
  assert.deepEqual(boot.result.restore, { restored: 4, forgotten: 0 });
  assert.deepEqual(
    boot.result.offeredAtBoot.sort(),
    ["ack-unheld", "provider-unheld"],
    "unheld owners at boot; held ones wait",
  );
  assert.deepEqual(boot.result.stillHeld, ["ack-held", "provider-held"]);
  assert.equal(boot.result.offered.length, 4, "each exactly once");
  for (const offer of boot.result.offered) {
    assert.ok(offer.deadline, offer.sessionId);
    assert.match(offer.key, new RegExp(items[offer.sessionId]!));
  }
  assert.deepEqual(boot.result.outbox, [], "delivered facts are retired");
  assert.equal(boot.result.launches, 0, "nothing is relaunched");

  const reboot = await run(["reboot", "", ""]);
  assert.deepEqual(reboot.result.restore, { restored: 0, forgotten: 0 });
  assert.deepEqual(reboot.result.offered, []);
}, 300_000);
