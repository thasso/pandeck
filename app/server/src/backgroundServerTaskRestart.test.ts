/**
 * A server task is never resumed after a restart, yet its owner always hears
 * how it ended: a fact recorded during the deployment drain, and a row boot
 * ends, each owe a retained wake that the next boot restores. Each phase is a
 * SEPARATE Node process on the same temporary database, wired the way
 * `index.ts` wires delivery; only the backend port, the clock and the turn are
 * fakes.
 *   pnpm --filter @assistant/server test src/backgroundServerTaskRestart.test.ts
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, test } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "background-server-task-restart-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const url = (path: string) => new URL(path, import.meta.url).href;

/**
 * Owners, all idle:
 *  crashed  Its watch was running when the process died without a drain.
 *  graced   Its watch finished on its own inside the drain grace.
 *  drained  Its watch was still running after the grace; the drain stopped it.
 */
const script = `
  const phase = process.argv[1];
  if (!process.env.DATA_DIR?.startsWith(${JSON.stringify(tmpdir())}))
    throw new Error("refusing to run outside a temporary DATA_DIR");
  const hold = await import(${JSON.stringify(url("./automaticTurnHold.ts"))});
  const { sessionStore } = await import(${JSON.stringify(url("./db/sessionStore.ts"))});
  const { backgroundWorkStore } = await import(${JSON.stringify(url("./db/backgroundWorkStore.ts"))});
  const { backgroundDeliveryOutboxStore } = await import(${JSON.stringify(url("./db/backgroundDeliveryOutboxStore.ts"))});
  const { ScheduledBackgroundDelivery: BackgroundCompletionDelivery } = await import(${JSON.stringify(url("./test/backgroundDelivery.ts"))});
  const { BackgroundWorkSupervisor } = await import(${JSON.stringify(url("./backgroundWork/supervisor.ts"))});
  const { stageSessionArtifact, sessionArtifactFile } = await import(${JSON.stringify(url("./mcp/toolGroups/packRuntime.ts"))});
  const { updateSettings } = await import(${JSON.stringify(url("./settings.ts"))});
  const notices = await import(${JSON.stringify(url("./backgroundCompletionNotices.ts"))});
  const { reconcileBackgroundWorkOnBoot } = await import(${JSON.stringify(url("./backgroundWorkBoot.ts"))});
  const owners = ["crashed", "graced", "drained"];
  const offered = [];
  const delivery = new BackgroundCompletionDelivery({
    held: hold.automaticTurnsHeld,
    disposition: notices.completionDisposition,
    outbox: notices.backgroundDeliveryOutbox,
    offer: async (sessionId, offer, _key, attempt) => {
      offered.push({ sessionId, block: offer.contextBlock });
      handled(sessionId, attempt);
      return "delivered";
    },
  });
  let runs = 0;
  const handled = (sessionId, attempt) => {
    runs += 1;
    const runId = "run-" + process.pid + "-" + runs;
    attempt.reserve();
    attempt.exposed("entry-" + runs, runId);
    attempt.finished(undefined);
    notices.settleBackgroundHandling(sessionId, { runId, stopReason: "end", abortRequested: false });
  };

  let launches = 0;
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
  // Acknowledges every Stop: an aborted server task always unwinds.
  const port = {
    backend: "server-task",
    launch: async () => { launches += 1; return { launched: true }; },
    stop: async () => ({ acknowledged: true }),
    stopAll: async (request) => ({
      acknowledgedItemIds: backgroundWorkStore
        .listItems({ ownerSessionId: request.ownerSessionId, state: "active", limit: 50 })
        .map((item) => item.id),
      unconfirmedItemIds: [],
    }),
  };
  const supervisor = new BackgroundWorkSupervisor({
    ports: [port],
    clock,
    completionRecorded: (item) => notices.enqueueCompletionNotice(delivery, item, false),
  });
  const admit = async (id) => {
    const admission = supervisor.admit({
      ownerSessionId: id, backend: "server-task", kind: "check-watch",
      label: "GitHub PR checks acme/app#" + id, sourceRequestId: "watch:" + id,
      requestedLifetimeMs: 90000,
    });
    if (!admission.admitted) throw new Error("not admitted: " + id + ": " + admission.message);
    return supervisor.launch(admission);
  };
  const out = { phase, items: {} };
  if (phase === "crash") {
    updateSettings({ backgroundWork: { enabled: true, ownerSessionCap: 20, taskLifetimeMinutes: 60, claudeEmptyHostGraceSeconds: 30 } });
    for (const id of owners)
      sessionStore.upsert({ id, scope: "user", harness: "pi", agentType: "developer", title: "restart " + id });
    out.items.crashed = (await admit("crashed")).id;
    // The process dies here: no drain, nothing terminal.
  } else if (phase === "drain") {
    reconcileBackgroundWorkOnBoot();
    const graced = await admit("graced");
    const drained = await admit("drained");
    out.items = { graced: graced.id, drained: drained.id };
    const draining = supervisor.drain();
    const bytes = new TextEncoder().encode(JSON.stringify({ observation: { stopReason: "checks_finished" } }));
    const artifact = stageSessionArtifact("graced", {
      name: "check-watch-result.json", mimeType: "application/json", kind: "file",
      label: "result", sourceTool: "github_watch_pull_request_checks", bytes,
    });
    supervisor.outputCaptured({
      itemId: graced.id, eventId: graced.id + ":output",
      evidence: { artifactId: artifact.id, originalBytes: bytes.byteLength, capturedBytes: bytes.byteLength, truncated: false, text: true },
    });
    supervisor.completed({ itemId: graced.id, state: "completed", outcomeSummary: "Checks finished: success, 3 checks on abc1234", eventId: graced.id + ":result" });
    await advanceTo(now + 10000);
    await draining;
    out.artifactPath = sessionArtifactFile("graced", artifact.id).path;
  } else {
    reconcileBackgroundWorkOnBoot();
    out.restore = notices.restoreOwedBackgroundDelivery(delivery);
    for (const id of owners) await delivery.drain(id);
    await settle();
    out.blocks = Object.fromEntries(offered.map((o) => [o.sessionId, o.block]));
  }
  out.states = Object.fromEntries(
    backgroundWorkStore.listItems({ state: "all", limit: 50 }).map((item) => [item.ownerSessionId, [item.state, item.terminalReason ?? null]]),
  );
  out.outbox = backgroundDeliveryOutboxStore.list().map((row) => [row.sessionId, row.disposition, row.retained]).sort();
  out.offered = offered.map((o) => o.sessionId).sort();
  out.launches = launches;
  console.log("RESULT " + JSON.stringify(out));
  process.exit(0);
`;

async function runPhase(phase: string): Promise<Record<string, any>> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script, phase],
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

test("a server task's restart facts wake their owners once, and nothing is re-run", async () => {
  assert.ok(process.env.ASSISTANT_CONFIG?.startsWith(tmpdir()));
  const crash = await runPhase("crash");
  assert.deepEqual(crash.states, { crashed: ["running", null] });

  const drain = await runPhase("drain");
  assert.deepEqual(drain.states, {
    crashed: ["lost", "server-restart"],
    graced: ["completed", null],
    drained: ["stopped", "stopped-for-deployment"],
  });
  assert.deepEqual(drain.offered, [], "delivery is closed while draining");
  assert.deepEqual(drain.outbox, [
    ["crashed", "wake", true],
    ["drained", "wake", true],
    ["graced", "wake", true],
  ]);

  const boot = await runPhase("boot");
  assert.deepEqual(boot.restore, { restored: 3, forgotten: 0, interrupted: 0 });
  assert.deepEqual(boot.offered, ["crashed", "drained", "graced"]);
  for (const owner of ["crashed", "drained"])
    assert.match(
      boot.blocks[owner],
      /A PA server restart stopped this task; nothing resumed it\./,
    );
  // A real result keeps its own words and its output.
  assert.doesNotMatch(boot.blocks.graced, /server restart/);
  assert.match(boot.blocks.graced, /Checks finished: success/);
  assert.ok(boot.blocks.graced.includes(drain.artifactPath));
  assert.equal(boot.launches, 0, "restart resumes nothing");
  assert.deepEqual(boot.outbox, [], "each fact is retired once handled");

  const reboot = await runPhase("reboot");
  assert.deepEqual(reboot.restore, {
    restored: 0,
    forgotten: 0,
    interrupted: 0,
  });
  assert.deepEqual(reboot.offered, []);
}, 180_000);
