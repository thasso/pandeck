/**
 * Background completions owed to a stopped session survive a restart: each
 * phase below is a SEPARATE Node process on the same database, so nothing but
 * SQLite carries a fact from one to the next.
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
 * One process lifetime. It wires delivery the way `index.ts` does — the real
 * outbox, policy and boot restore — with a recording offer in place of a model.
 */
const script = `
  const phase = process.argv[1];
  const hold = await import(${JSON.stringify(url("./automaticTurnHold.ts"))});
  const { sessionStore } = await import(${JSON.stringify(url("./db/sessionStore.ts"))});
  const { backgroundWorkStore } = await import(${JSON.stringify(url("./db/backgroundWorkStore.ts"))});
  const { BackgroundCompletionDelivery } = await import(${JSON.stringify(url("./backgroundWork/completionDelivery.ts"))});
  const notices = await import(${JSON.stringify(url("./backgroundCompletionNotices.ts"))});
  const { reconcileBackgroundWorkOnBoot } = await import(${JSON.stringify(url("./backgroundWorkBoot.ts"))});
  const offered = [];
  const delivery = new BackgroundCompletionDelivery({
    drainPeers: async () => {},
    held: hold.automaticTurnsHeld,
    disposition: notices.completionDisposition,
    outbox: notices.backgroundDeliveryOutbox,
    offer: async (sessionId, _offer, key) => {
      offered.push(key);
      // The unheld owner is busy, so its fact is still owed at exit.
      return sessionId === "unheld-owner" ? "busy" : "delivered";
    },
  });
  const finished = (owner, label, stop) => {
    const item = backgroundWorkStore.reserveItem({
      ownerSessionId: owner, backend: "host-process", kind: "shell", label,
      sourceRequestId: label, lifetimeMs: 60000, settingsGeneration: 1,
      bootEpoch: "seed", ownerLimit: 100,
    });
    if (stop) {
      backgroundWorkStore.markRunning({ itemId: item.id });
      backgroundWorkStore.requestStop({ itemId: item.id, reason: "asked", sourceRequestId: label + "-stop" });
    }
    return backgroundWorkStore.terminalize({ itemId: item.id, state: stop ? "stopped" : "completed" });
  };
  const out = { phase };
  if (phase === "seed") {
    for (const id of ["held-owner", "unheld-owner"])
      sessionStore.upsert({ id, scope: "user", harness: "pi", agentType: "developer" });
    hold.holdAutomaticTurns("held-owner");
    const woken = finished("held-owner", "woken job", false);
    const deferred = finished("held-owner", "deferred job", true);
    const unheld = finished("unheld-owner", "unheld job", false);
    for (const item of [woken, deferred, unheld])
      delivery.enqueue(item.ownerSessionId, notices.completionNoticeOf(item, false));
    await delivery.drain("held-owner");
    await delivery.drain("unheld-owner");
    Object.assign(out, { woken: woken.id, deferred: deferred.id, unheld: unheld.id });
  } else {
    reconcileBackgroundWorkOnBoot();
    if (phase === "reboot") hold.holdAutomaticTurns("held-owner");
    out.restore = notices.restoreHeldBackgroundDelivery(delivery);
    out.heldAtBoot = hold.automaticTurnsHeld("held-owner");
    await delivery.requestDrain("held-owner");
    out.offeredWhileHeld = [...offered];
    hold.resumeAutomaticTurns("held-owner");
    await delivery.requestDrain("held-owner");
    await delivery.requestDrain("unheld-owner");
    const deferred = delivery.peekDeferredContext("held-owner");
    out.deferredBlock = deferred?.block ?? null;
    deferred?.commit();
  }
  out.offered = offered;
  console.log("RESULT " + JSON.stringify(out));
  process.exit(0);
`;

async function runPhase(phase: string): Promise<Record<string, unknown>> {
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
  return JSON.parse(line.slice("RESULT ".length)) as Record<string, unknown>;
}

test("a completion owed to a stopped session is delivered exactly once after a restart and Resume", async () => {
  const seed = await runPhase("seed");
  // Only the unheld owner was offered (and was busy); the stopped one never.
  const seeded = seed.offered as string[];
  assert.ok(seeded.length > 0);
  assert.ok(
    seeded.every((key) => key.includes(String(seed.unheld))),
    "nothing offered to the stopped session",
  );

  const boot = await runPhase("boot");
  assert.deepEqual(
    boot.restore,
    { restored: 2, forgotten: 1 },
    "the stopped session's two facts come back; the unheld session's is forgotten",
  );
  assert.equal(boot.heldAtBoot, true, "the hold survived the restart");
  assert.deepEqual(boot.offeredWhileHeld, [], "nothing offered before Resume");
  const offered = boot.offered as string[];
  assert.equal(offered.length, 1, "delivered once after Resume");
  assert.ok(offered[0]!.includes(String(seed.woken)));
  assert.equal(
    offered.some((key) => key.includes(String(seed.unheld))),
    false,
    "a forgotten fact is never announced",
  );
  assert.ok(
    String(boot.deferredBlock).includes(String(seed.deferred)),
    "the deferred fact rides the next turn",
  );

  // Stopped again before another restart: nothing owed is left to repeat.
  const reboot = await runPhase("reboot");
  assert.deepEqual(reboot.restore, { restored: 0, forgotten: 0 });
  assert.deepEqual(reboot.offered, []);
  assert.equal(reboot.deferredBlock, null);
}, 180_000);
