/**
 * Background completions a Stop touched stay owed across a restart until they
 * are delivered — through a Resume too. Each phase below is a SEPARATE Node
 * process on the same database, so nothing but SQLite carries a fact from one
 * to the next, and each wires delivery the way `index.ts` does.
 *   pnpm --filter @assistant/server test src/backgroundDeliveryRestart.test.ts
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, test } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "background-delivery-restart-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const url = (path: string) => new URL(path, import.meta.url).href;

/**
 * Owners, each one crash window:
 *  release   Stopped, owed a wake and a deferred fact, resumed, killed before
 *            any drain ran.
 *  busy      Stopped, resumed; the offer found the session busy.
 *  gone      Stopped, resumed; the offer found it unavailable.
 *  failed    Stopped, resumed; the offer threw.
 *  peeked    Stopped, owed a deferred fact, resumed; a human prompt carried
 *            it (peeked) but was cut off before it committed.
 *  held      Stopped and still held at the restart.
 *  delivered Stopped, resumed, delivered and committed before the restart.
 *  never     Never stopped; busy at the restart.
 *  before    Owed (busy) BEFORE a Stop landed; then stopped and resumed.
 */
const script = `
  const phase = process.argv[1];
  const hold = await import(${JSON.stringify(url("./automaticTurnHold.ts"))});
  const { sessionStore } = await import(${JSON.stringify(url("./db/sessionStore.ts"))});
  const { backgroundWorkStore } = await import(${JSON.stringify(url("./db/backgroundWorkStore.ts"))});
  const { BackgroundCompletionDelivery } = await import(${JSON.stringify(url("./backgroundWork/completionDelivery.ts"))});
  const notices = await import(${JSON.stringify(url("./backgroundCompletionNotices.ts"))});
  const { reconcileBackgroundWorkOnBoot } = await import(${JSON.stringify(url("./backgroundWorkBoot.ts"))});
  const owners = ["release", "busy", "gone", "failed", "peeked", "held", "delivered", "never", "before"];
  const offered = [];
  const answer = {};
  const delivery = new BackgroundCompletionDelivery({
    drainPeers: async () => {},
    held: hold.automaticTurnsHeld,
    disposition: notices.completionDisposition,
    outbox: notices.backgroundDeliveryOutbox,
    offer: async (sessionId, _offer, key) => {
      offered.push(sessionId + "=" + key);
      const result = answer[sessionId] ?? "delivered";
      if (result === "throw") throw new Error("provider exploded");
      return result;
    },
  });
  const finished = (owner, label, stop) => {
    const item = backgroundWorkStore.reserveItem({
      ownerSessionId: owner, backend: "host-process", kind: "shell", label,
      sourceRequestId: owner + ":" + label, lifetimeMs: 60000,
      settingsGeneration: 1, bootEpoch: "seed", ownerLimit: 100,
    });
    if (stop) {
      backgroundWorkStore.markRunning({ itemId: item.id });
      backgroundWorkStore.requestStop({ itemId: item.id, reason: "asked", sourceRequestId: owner + ":" + label + ":stop" });
    }
    return backgroundWorkStore.terminalize({ itemId: item.id, state: stop ? "stopped" : "completed" });
  };
  const owe = (owner, item) => delivery.enqueue(owner, notices.completionNoticeOf(item, false));
  const out = { phase, items: {} };
  if (phase === "seed") {
    for (const id of owners)
      sessionStore.upsert({ id, scope: "user", harness: "pi", agentType: "developer" });
    // Owed while unheld, and offered while the session was busy.
    answer.before = "busy";
    const early = finished("before", "wake", false);
    out.items["before:wake"] = early.id;
    owe("before", early);
    await delivery.drain("before");
    delete answer.before;
    for (const owner of owners.filter((o) => o !== "never")) hold.holdAutomaticTurns(owner);
    for (const owner of ["release", "busy", "gone", "failed", "held", "delivered", "never"]) {
      const wake = finished(owner, "wake", false);
      out.items[owner + ":wake"] = wake.id;
      owe(owner, wake);
    }
    for (const owner of ["release", "peeked", "held", "delivered"]) {
      const deferred = finished(owner, "deferred", true);
      out.items[owner + ":deferred"] = deferred.id;
      owe(owner, deferred);
    }
    Object.assign(answer, { busy: "busy", gone: "unavailable", failed: "throw", never: "busy" });
    // The drains each enqueue started read the hold while it still stands.
    for (const owner of owners) await delivery.drain(owner).catch(() => {});
    for (const owner of ["release", "busy", "gone", "failed", "peeked", "delivered", "before"])
      hold.resumeAutomaticTurns(owner);
    for (const owner of ["busy", "gone", "failed", "delivered"])
      await delivery.requestDrain(owner).catch(() => {});
    // A prompt that carried the deferred fact but never finished: peeked only.
    out.peeked = Boolean(delivery.peekDeferredContext("peeked"));
    delivery.peekDeferredContext("delivered")?.commit();
  } else {
    reconcileBackgroundWorkOnBoot();
    if (phase === "reboot") for (const owner of owners) hold.holdAutomaticTurns(owner);
    out.restore = notices.restoreOwedBackgroundDelivery(delivery);
    for (const owner of owners) await delivery.drain(owner);
    out.offeredAtBoot = [...offered];
    for (const owner of owners) hold.resumeAutomaticTurns(owner);
    for (const owner of owners) await delivery.requestDrain(owner);
    out.deferred = {};
    for (const owner of owners) {
      const pending = delivery.peekDeferredContext(owner);
      if (pending) {
        out.deferred[owner] = pending.block;
        pending.commit();
      }
    }
  }
  out.offered = offered;
  console.log("RESULT " + JSON.stringify(out));
  process.exit(0);
`;

async function runPhase(phase: string): Promise<Record<string, any>> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script, phase],
    {
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

/** Which owner each offered key went to, in order. */
const ownersOf = (offered: string[]) => offered.map((o) => o.split("=")[0]);

test("a fact a Stop touched is delivered after a restart unless it already was, a Resume notwithstanding", async () => {
  const seed = await runPhase("seed");
  assert.equal(seed.peeked, true, "the cut-off prompt did carry it");
  // Offered before the restart: never the released-but-undrained owner, nor
  // the ones still held or holding only a deferred fact (a busy one is
  // offered on every drain).
  assert.deepEqual([...new Set(ownersOf(seed.offered))].sort(), [
    "before",
    "busy",
    "delivered",
    "failed",
    "gone",
    "never",
  ]);

  const boot = await runPhase("boot");
  assert.deepEqual(
    boot.restore,
    { restored: 9, forgotten: 1 },
    "every undelivered fact a Stop touched comes back; the never-stopped one is forgotten",
  );
  // Released before the restart: offered at boot, held or not by then. Each
  // exactly once; neither the delivered nor the never-stopped owner again.
  assert.deepEqual(ownersOf(boot.offeredAtBoot).sort(), [
    "before",
    "busy",
    "failed",
    "gone",
    "release",
  ]);
  assert.deepEqual(
    ownersOf(boot.offered).sort(),
    ["before", "busy", "failed", "gone", "held", "release"],
    "the still-held owner's wake goes only after its Resume",
  );
  for (const owner of ["before", "busy", "failed", "gone", "release", "held"]) {
    const key = boot.offered.find((o: string) => o.startsWith(owner + "="));
    assert.ok(key.includes(seed.items[`${owner}:wake`]), owner);
  }
  assert.deepEqual(Object.keys(boot.deferred).sort(), [
    "held",
    "peeked",
    "release",
  ]);
  for (const owner of ["held", "peeked", "release"])
    assert.ok(
      boot.deferred[owner].includes(seed.items[`${owner}:deferred`]),
      `${owner}: its deferred fact rides the next turn`,
    );

  // Everything was delivered or committed, and every owner is stopped again
  // before this restart: nothing is left to repeat.
  const reboot = await runPhase("reboot");
  assert.deepEqual(reboot.restore, { restored: 0, forgotten: 0 });
  assert.deepEqual(reboot.offered, []);
  assert.deepEqual(reboot.deferred, {});
}, 180_000);
