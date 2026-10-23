/**
 * Handling a background fact survives NEW processes without replaying it.
 * Each phase is a separate Node process on one database, wired the way
 * `index.ts` wires delivery, with only the provider scripted; nothing but
 * SQLite and the session logs carries anything from one phase to the next.
 *   pnpm --filter @assistant/server test src/backgroundHandlingRestart.test.ts
 *
 *   seed    Facts are delivered; their turns fail, are stopped, succeed, or
 *           are still running when the process dies.
 *   boot    A new process: nothing is offered on its own. Recover is refused
 *           for the stopped session, handles one fact, fails for another;
 *           one cut-off fact is dismissed.
 *   reboot  Another new process: what is still owed is still owed, and a
 *           Recover handles it. No job or turn ran again anywhere.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, test } from "vitest";

const root = mkdtempSync(join(tmpdir(), "background-handling-restart-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sandbox = {
  data: join(root, "data"),
  cwd: join(root, "cwd"),
  home: join(root, "home"),
  tmp: join(root, "tmp"),
  cache: join(root, "cache"),
  legacy: join(root, "no-legacy-pi-agent"),
  config: join(root, "app.json"),
  gitconfig: join(root, "gitconfig"),
};
for (const dir of [sandbox.data, sandbox.cwd, sandbox.home, sandbox.tmp])
  mkdirSync(dir, { recursive: true });
writeFileSync(
  sandbox.config,
  JSON.stringify({
    dataDir: sandbox.data,
    publicBaseUrl: "https://assistant.example.invalid",
  }),
);
writeFileSync(
  sandbox.gitconfig,
  "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n",
);

const url = (path: string) => new URL(path, import.meta.url).href;
const tsx = fileURLToPath(
  new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
);

const script = `
  const phase = process.argv[1];
  const root = ${JSON.stringify(root)};
  // Nothing may leave the sandbox: no network, no foreign data directory.
  globalThis.fetch = () => Promise.reject(new Error("network access is denied"));
  const config = await import(${JSON.stringify(url("./config.ts"))});
  for (const [name, path] of [["DATA_DIR", config.DATA_DIR], ["CWD", config.CWD], ["HOME", process.env.HOME], ["TMPDIR", process.env.TMPDIR]])
    if (!path.startsWith(root)) throw new Error(name + " escaped the sandbox: " + path);
  const { updateSettings, getSettings } = await import(${JSON.stringify(url("./settings.ts"))});
  updateSettings({ memory: { ...getSettings().memory, learningMode: "off" } });
  const hold = await import(${JSON.stringify(url("./automaticTurnHold.ts"))});
  const { sessionStore } = await import(${JSON.stringify(url("./db/sessionStore.ts"))});
  const { getDb } = await import(${JSON.stringify(url("./db/index.ts"))});
  const { backgroundWorkStore } = await import(${JSON.stringify(url("./db/backgroundWorkStore.ts"))});
  const { BackgroundCompletionDelivery } = await import(${JSON.stringify(url("./backgroundWork/completionDelivery.ts"))});
  const notices = await import(${JSON.stringify(url("./backgroundCompletionNotices.ts"))});
  const { sessionRuntime } = await import(${JSON.stringify(url("./session/runtimeInstance.ts"))});
  const { setDeferredBackgroundContextProvider, promptRuntimeSession } = await import(${JSON.stringify(url("./session/runtimePrompt.ts"))});
  const { subscribeSessionRunEnded } = await import(${JSON.stringify(url("./session/runtime/liveSession.ts"))});

  const owners = ["fail", "stop", "ok", "many", "deferred", "crash"];
  const mode = Object.fromEntries(owners.map((o) => [o, "end"]));
  const texts = Object.fromEntries(owners.map((o) => [o, []]));
  const open = [];
  const drivers = new Map();
  for (const id of owners) {
    const adapter = {
      provider: "scripted",
      capabilities: { fork: "none", compact: false, steer: true, attachments: false },
      subscribe: () => () => {},
      getBinding: () => ({ provider: "scripted", nativeId: "native-" + id }),
      prompt: (text) => {
        texts[id].push(text);
        if (mode[id] === "end") return Promise.resolve({ stopReason: "end" });
        if (mode[id] === "error") return Promise.resolve({ stopReason: "error", errorMessage: "provider unavailable" });
        return new Promise((resolve) => open.push({ id, resolve }));
      },
      abort: () => {
        for (const turn of open.filter((t) => t.id === id)) {
          open.splice(open.indexOf(turn), 1);
          turn.resolve({ stopReason: "aborted" });
        }
      },
      setModel: () => {}, setReasoning: () => {}, dispose: () => {},
    };
    drivers.set(id, {
      id, key: id, sessionId: id, harness: "pi", agentType: "assistant", sessionFile: undefined,
      get isRunning() { return sessionRuntime.get(id)?.isRunning ?? false; },
      canSteer: true, contextInfo: () => ({}), broadcastState: () => {},
      createRuntimeAdapter: () => adapter,
    });
  }
  const acquired = [];
  const driverFor = async (id) => {
    acquired.push(id);
    return drivers.get(id);
  };
  const delivery = new BackgroundCompletionDelivery({
    disposition: notices.completionDisposition,
    outbox: notices.backgroundDeliveryOutbox,
    offer: notices.offerBackgroundCompletion(driverFor),
  });
  const { installDeliveryTestScheduler } = await import(${JSON.stringify(url("./test/deliveryScheduler.ts"))});
  installDeliveryTestScheduler({ background: delivery, live: (id) => drivers.get(id), acquire: driverFor });
  setDeferredBackgroundContextProvider((id) => delivery.claimDeferredContext(id));
  subscribeSessionRunEnded((id, outcome) => notices.settleBackgroundHandling(id, outcome));

  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
  };
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
    return backgroundWorkStore.terminalize({
      itemId: item.id, state: stop ? "stopped" : "completed",
      outcomeSummary: "ORIGINAL-OUTCOME-" + owner + "-" + label,
    });
  };
  const rows = () => Object.fromEntries(owners.map((o) => [o,
    getDb().prepare("SELECT phase, interruption FROM background_delivery_outbox WHERE session_id=? ORDER BY created_at_ms, rowid").all(o)
      .map((r) => r.phase + (r.interruption ? ":" + r.interruption : ""))]));
  const jobs = () => getDb().prepare("SELECT id, state, revision FROM background_work_items ORDER BY id").all().map((r) => r.id + ":" + r.state);
  const out = { phase, items: {} };

  if (phase === "seed") {
    for (const id of owners)
      sessionStore.upsert({ id, scope: "user", harness: "pi", agentType: "assistant", title: "restart " + id });
    for (const id of owners) sessionRuntime.createSession(id, drivers.get(id).createRuntimeAdapter());
    const owe = (owner, label, stop = false) => {
      const item = finished(owner, label, stop);
      out.items[owner + ":" + label] = item.id;
      notices.enqueueCompletionNotice(delivery, item, false);
    };
    // The handling turn fails.
    mode.fail = "error";
    owe("fail", "wake");
    // The user stops the handling turn.
    mode.stop = "manual";
    owe("stop", "wake");
    // A clean turn handles it.
    owe("ok", "wake");
    // One batch of three, whose turn fails.
    mode.many = "error";
    hold.holdAutomaticTurns("many");
    for (const label of ["a", "b", "c"]) owe("many", label);
    hold.resumeAutomaticTurns("many");
    await delivery.requestDrain("many");
    // A deferred fact rides the user's own turn, which fails; a later healthy
    // turn of theirs neither carries nor discharges it.
    owe("deferred", "quiet", true);
    mode.deferred = "error";
    await promptRuntimeSession(drivers.get("deferred"), "please continue", { clientRequestId: "human-1" }).catch(() => {});
    mode.deferred = "end";
    await promptRuntimeSession(drivers.get("deferred"), "anything else?", { clientRequestId: "human-2" });
    // Still running when the process dies.
    mode.crash = "manual";
    owe("crash", "wake");
    await settle();
    hold.holdAutomaticTurns("stop");
    await sessionRuntime.abort("stop");
    await settle();
    out.rows = rows();
    out.texts = Object.fromEntries(owners.map((o) => [o, texts[o].length]));
    out.deferredCarried = texts.deferred.map((t) => t.includes(out.items["deferred:quiet"]));
    out.jobs = jobs();
    console.log("RESULT " + JSON.stringify(out));
    // Dies with the crash owner's turn still open: no close, no settlement.
    process.exit(0);
  }

  out.restore = notices.restoreOwedBackgroundDelivery(delivery);
  for (const id of owners) await delivery.drain(id);
  await settle();
  out.automatic = Object.fromEntries(owners.map((o) => [o, texts[o].length]));
  out.rowsAtBoot = rows();
  out.jobsAtBoot = jobs();
  const recover = async (id) => {
    const result = await notices.recoverBackgroundHandling(delivery, id, driverFor);
    if ("done" in result) { await result.done; return "ran"; }
    return result.refused;
  };
  if (phase === "boot") {
    acquired.length = 0;
    out.stopRecover = await recover("stop");
    out.stopAcquired = acquired.includes("stop");
    out.failRecover = await recover("fail");
    out.failText = texts.fail.at(-1) ?? "";
    mode.many = "error";
    out.manyRecover = await recover("many");
    out.dismissed = notices.dismissBackgroundHandling("crash", notices.unhandledBackgroundBatch("crash"));
  } else {
    out.deferredRecover = await recover("deferred");
    out.deferredText = texts.deferred.at(-1) ?? "";
  }
  await settle();
  out.rows = rows();
  out.texts = Object.fromEntries(owners.map((o) => [o, texts[o].length]));
  out.jobs = jobs();
  console.log("RESULT " + JSON.stringify(out));
  process.exit(0);
`;

async function runPhase(phase: string): Promise<Record<string, any>> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", tsx, "--input-type=module", "-e", script, phase],
    {
      cwd: sandbox.cwd,
      // An explicit environment, not the developer's: nothing inherited can
      // point a phase at real data, config, credentials or a Git identity.
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.NODE_COMPILE_CACHE
          ? { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE }
          : {}),
        DATA_DIR: sandbox.data,
        ASSISTANT_CWD: sandbox.cwd,
        ASSISTANT_CONFIG: sandbox.config,
        ASSISTANT_LEGACY_PI_AGENT_DIR: sandbox.legacy,
        HOME: sandbox.home,
        TMPDIR: sandbox.tmp,
        XDG_CACHE_HOME: sandbox.cache,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: sandbox.gitconfig,
      },
      timeout: 90_000,
    },
  );
  const line = stdout
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("RESULT "));
  assert.ok(line, `phase ${phase} reported nothing:\n${stdout}`);
  return JSON.parse(line.slice("RESULT ".length)) as Record<string, any>;
}

test("a fact whose handling did not finish stays owed across new processes, is recovered only by the user, and nothing is replayed", async () => {
  const seed = await runPhase("seed");
  assert.deepEqual(seed.rows, {
    fail: ["interrupted:failed"],
    stop: ["interrupted:stopped"],
    ok: [],
    many: ["interrupted:failed", "interrupted:failed", "interrupted:failed"],
    deferred: ["interrupted:failed"],
    crash: ["handling"],
  });
  assert.deepEqual(seed.texts, {
    fail: 1,
    stop: 1,
    ok: 1,
    many: 1,
    deferred: 2,
    crash: 1,
  });
  assert.deepEqual(
    seed.deferredCarried,
    [true, false],
    "the failed turn carried it; the healthy one after it did not",
  );

  const boot = await runPhase("boot");
  assert.deepEqual(boot.restore, {
    restored: 0,
    forgotten: 0,
    interrupted: 1,
  });
  assert.deepEqual(
    boot.automatic,
    { fail: 0, stop: 0, ok: 0, many: 0, deferred: 0, crash: 0 },
    "a new process offers nothing on its own",
  );
  assert.deepEqual(boot.rowsAtBoot.crash, ["interrupted:restart"]);
  assert.deepEqual(boot.jobsAtBoot, seed.jobs, "no job started or changed");
  assert.equal(boot.stopRecover, "The session is stopped; resume it first.");
  assert.equal(boot.stopAcquired, false, "a held session is not acquired");
  assert.equal(boot.failRecover, "ran");
  assert.match(boot.failText, /background_work_recovery/);
  assert.match(boot.failText, new RegExp(seed.items["fail:wake"]));
  assert.doesNotMatch(
    boot.failText,
    /ORIGINAL-OUTCOME/,
    "a reference, never the original block",
  );
  assert.equal(boot.manyRecover, "ran");
  assert.equal(boot.dismissed, 1);
  assert.deepEqual(boot.rows, {
    fail: [],
    stop: ["interrupted:stopped"],
    ok: [],
    many: ["interrupted:failed", "interrupted:failed", "interrupted:failed"],
    deferred: ["interrupted:failed"],
    crash: [],
  });
  assert.deepEqual(boot.texts, {
    fail: 1,
    stop: 0,
    ok: 0,
    many: 1,
    deferred: 0,
    crash: 0,
  });

  const reboot = await runPhase("reboot");
  assert.deepEqual(reboot.restore, {
    restored: 0,
    forgotten: 0,
    interrupted: 0,
  });
  assert.deepEqual(reboot.automatic, {
    fail: 0,
    stop: 0,
    ok: 0,
    many: 0,
    deferred: 0,
    crash: 0,
  });
  assert.deepEqual(reboot.rowsAtBoot, boot.rows, "still owed, unchanged");
  assert.equal(reboot.deferredRecover, "ran");
  assert.match(reboot.deferredText, new RegExp(seed.items["deferred:quiet"]));
  assert.doesNotMatch(reboot.deferredText, /ORIGINAL-OUTCOME/);
  assert.deepEqual(reboot.rows.deferred, []);
  assert.deepEqual(reboot.rows.stop, ["interrupted:stopped"]);
  assert.deepEqual(reboot.jobs, seed.jobs, "no job started or changed");
}, 240_000);
