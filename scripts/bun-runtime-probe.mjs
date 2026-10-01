/**
 * Server code the packaged Bun runtime must run the way Node runs it, driven
 * directly because a booted server reaches none of it on demand: git through
 * the spawn broker (its cancel and its group kill), the in-process fallback,
 * a watcher subscribed with a git-derived ignore set, the SQLite paths that
 * depend on the `node:sqlite` shim, the package proxy's env reaching
 * children but never the server's own fetch, and pi's OAuth flows.
 *
 * Not run from a checkout. `test-bun-server-bundle.mjs` bundles it with the
 * server's own plugins and runs it with the packaged Bun, once per mode:
 * `broker`, and `in-process` under `ASSISTANT_SPAWN_BROKER=0`.
 */
import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../app/server/src/config.ts";
import { backgroundWorkStore } from "../app/server/src/db/backgroundWorkStore.ts";
import {
  getDb,
  inDbTransaction,
  withDbTransaction,
} from "../app/server/src/db/index.ts";
import {
  addLink,
  memoizedOnLinks,
  outgoingByType,
} from "../app/server/src/db/links.ts";
import { sessionStore } from "../app/server/src/db/sessionStore.ts";
import { GitCommandError, git } from "../app/server/src/gitExec.ts";
import { updateGithubSettings } from "../app/server/src/githubSettings.ts";
import { importLegacyJsonStore } from "../app/server/src/legacyJsonStoreImport.ts";
import {
  packageProxyEnvironment,
  startPackageProxyIfEnabled,
  stopPackageProxy,
} from "../app/server/src/packageProxy/packageProxy.ts";
import watcher from "../app/server/src/parcelWatcher.ts";
import { modelRuntimeForProfile } from "../app/server/src/piSdk/models.ts";
import {
  brokerExecFile,
  spawnBrokerPidForTests,
} from "../app/server/src/spawnBroker.ts";
import { childProcessEnv } from "../app/server/src/subprocessEnv.ts";
import { treeIgnoreForTests } from "../app/server/src/worktrees/worktreeWatcher.ts";

const mode = process.argv[2];
if (mode !== "broker" && mode !== "in-process")
  throw new Error(`Unknown probe mode: ${mode}`);
const scratch = join(DATA_DIR, `probe-${mode}`);
mkdirSync(scratch, { recursive: true });

function assert(value, message) {
  if (!value) throw new Error(message);
}

const sleep = (ms) =>
  new Promise((resolve) => globalThis.setTimeout(resolve, ms));

async function until(predicate, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what}.`);
    await sleep(20);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `/proc/<pid>/stat` fields after the command name: state, ppid, pgrp. */
function processGroup(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
}

const sh = (script, signal) =>
  brokerExecFile({
    file: "sh",
    args: ["-c", script],
    cwd: scratch,
    env: process.env,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
    ...(signal ? { signal } : {}),
  });

const identity = [
  "-c",
  "user.name=Bun Probe",
  "-c",
  "user.email=probe@invalid",
];

async function makeRepo(name, files) {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  await git(["init", "-q", "-b", "main"], root);
  await git(["add", "-A"], root);
  await git([...identity, "commit", "-q", "-m", "probe"], root);
  return root;
}

/** Start `sh` in the background, recording the pid its exec'd sleep keeps. */
function sleeperScript(pidFile) {
  return `echo $$ > ${JSON.stringify(pidFile)}; exec sleep 30`;
}

async function checkGit() {
  const brokerPid = await spawnBrokerPidForTests();
  const parent = Number((await sh("echo $PPID")).stdout.trim());
  if (mode === "broker") {
    assert(brokerPid, "The spawn broker did not start under Bun.");
    assert(
      realpathSync(readlinkSync(`/proc/${brokerPid}/exe`)) ===
        realpathSync(process.execPath),
      "The spawn broker is not the packaged Bun executable.",
    );
    assert(
      processGroup(brokerPid) === brokerPid,
      "The spawn broker does not lead its own process group.",
    );
    assert(parent === brokerPid, "A brokered child was not the broker's.");
  } else {
    assert(brokerPid === undefined, "ASSISTANT_SPAWN_BROKER=0 started one.");
    assert(parent === process.pid, "The in-process fallback did not spawn.");
  }

  const repo = await makeRepo("git", { "README.md": "probe\n" });
  const head = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();
  assert(/^[0-9a-f]{40}$/.test(head), `git rev-parse returned ${head}.`);
  let failed;
  try {
    await git(["rev-parse", "--verify", "no-such-ref"], repo);
  } catch (error) {
    failed = error;
  }
  assert(
    failed instanceof GitCommandError && failed.result.code === 128,
    "A failing git call did not report its exit status.",
  );

  // Cancelling a request kills its child.
  const cancelPid = join(scratch, "cancel.pid");
  const controller = new globalThis.AbortController();
  const cancelled = sh(sleeperScript(cancelPid), controller.signal);
  await until(() => existsSync(cancelPid), "the cancellable child");
  const cancelledPid = Number(readFileSync(cancelPid, "utf8"));
  controller.abort();
  const outcome = await cancelled;
  assert(
    outcome.error?.code === "ABORT_ERR",
    `A cancelled request answered ${JSON.stringify(outcome.error)}.`,
  );
  await until(() => !alive(cancelledPid), "the cancelled child to exit");

  if (mode !== "broker") return;

  // A broker that dies takes its whole process group with it, grandchildren
  // included: git runs the alias through a shell whose exec'd sleep outlives
  // git itself otherwise.
  const groupPid = join(scratch, "group.pid");
  const lost = git(
    ["-c", `alias.probe-wait=!${sleeperScript(groupPid)}`, "probe-wait"],
    repo,
  ).then(
    () => undefined,
    (error) => error,
  );
  await until(() => existsSync(groupPid), "the brokered grandchild");
  const grandchild = Number(readFileSync(groupPid, "utf8"));
  assert(
    processGroup(grandchild) === brokerPid,
    "A brokered grandchild left the broker's process group.",
  );
  process.kill(brokerPid, "SIGKILL");
  const error = await lost;
  assert(
    error instanceof GitCommandError && error.failureKind === "execution",
    `A request lost with its broker answered ${error}.`,
  );
  await until(() => !alive(grandchild), "the broker's group to be killed");
  const restarted = await spawnBrokerPidForTests();
  assert(
    restarted && restarted !== brokerPid,
    "The spawn broker did not restart after it died.",
  );
  assert(
    (await git(["rev-parse", "HEAD"], repo)).stdout.trim() === head,
    "git through the restarted broker failed.",
  );
}

async function checkWatcher() {
  const root = realpathSync(
    await makeRepo("watched", {
      ".gitignore": "build/\nnested/cache/\n",
      "src/a.txt": "a\n",
      "nested/keep/k.txt": "k\n",
    }),
  );
  mkdirSync(join(root, "build"), { recursive: true });
  mkdirSync(join(root, "nested", "cache"), { recursive: true });
  writeFileSync(join(root, "build", "seed.txt"), "seed\n");
  writeFileSync(join(root, "nested", "cache", "seed.txt"), "seed\n");
  const ignore = await treeIgnoreForTests(root);
  for (const expected of [".git", "build", "nested/cache"])
    assert(
      ignore.includes(expected),
      `The derived ignore set lacks ${expected}: ${ignore}`,
    );
  assert(
    !ignore.includes("src") && !ignore.includes("nested"),
    `The derived ignore set covers watched source: ${ignore}`,
  );

  const seen = [];
  const subscription = await watcher.subscribe(
    root,
    (error, events) => {
      if (!error) seen.push(...events.map((event) => event.path));
    },
    { ignore },
  );
  // The ignored writes come first and a watched barrier last. One
  // subscription's events arrive in the order the kernel queued them, so an
  // ignored event that was going to arrive has arrived by the barrier's.
  const barrier = join(root, "src", "barrier.txt");
  try {
    writeFileSync(join(root, "build", "out.txt"), "ignored\n");
    writeFileSync(join(root, "nested", "cache", "c.txt"), "ignored\n");
    writeFileSync(join(root, "src", "a.txt"), "changed\n");
    writeFileSync(join(root, "nested", "keep", "k.txt"), "changed\n");
    writeFileSync(barrier, "barrier\n");
    await until(
      () =>
        seen.includes(barrier) &&
        seen.includes(join(root, "src", "a.txt")) &&
        seen.includes(join(root, "nested", "keep", "k.txt")),
      "watcher events for the watched files",
    );
  } finally {
    await subscription.unsubscribe();
  }
  const leaked = seen.filter(
    (path) =>
      path.startsWith(join(root, "build")) ||
      path.startsWith(join(root, "nested", "cache")),
  );
  assert(leaked.length === 0, `Ignored paths reported events: ${leaked}`);
}

function checkSqlite() {
  const db = getDb();
  // Nesting must see the caller's transaction (#370, #376).
  withDbTransaction(() => {
    assert(db.isTransaction, "isTransaction is false inside a transaction.");
    inDbTransaction(() => undefined);
  });
  assert(!db.isTransaction, "isTransaction stayed true after COMMIT.");

  // #369: a commit from another connection moves PRAGMA data_version.
  let builds = 0;
  const read = memoizedOnLinks("session", () => {
    builds += 1;
    return outgoingByType("session", "context");
  });
  read();
  read();
  assert(builds === 1, `A memo hit rebuilt the projection (${builds}).`);
  const external = `probe-external-${mode}`;
  const other = new DatabaseSync(join(DATA_DIR, "app.sqlite3"));
  try {
    other
      .prepare(
        `INSERT INTO links (from_type, from_id, relation, to_type, to_id, created_at_ms)
         VALUES ('session', ?, 'context', 'task', '1', ?)`,
      )
      .run(external, Date.now());
  } finally {
    other.close();
  }
  assert(read().has(external), "Another connection's commit was not read.");
  assert(builds === 2, "Another connection's commit did not invalidate.");
  const rolledBack = `probe-rollback-${mode}`;
  try {
    withDbTransaction(() => {
      addLink({ type: "session", id: rolledBack }, "context", {
        type: "task",
        id: "1",
      });
      assert(read().has(rolledBack), "An open transaction's edge is unread.");
      throw new Error("roll back");
    });
  } catch (error) {
    if (error.message !== "roll back") throw error;
  }
  assert(!read().has(rolledBack), "A rolled-back value was memoized.");

  // #370: the legacy import commits rows and its record in one transaction,
  // and rolls both back when the file changes under it.
  const legacyFile = join(scratch, "legacy.json");
  const rowsOf = () =>
    db
      .prepare("SELECT COUNT(*) AS n FROM links WHERE from_id LIKE ?")
      .get(`probe-legacy-${mode}-%`).n;
  let rewrites = 1;
  writeFileSync(legacyFile, JSON.stringify(["a", "b"]));
  const changing = importLegacyJsonStore(legacyFile, (parsed) => ({
    records: parsed.length,
    invalid: 0,
    duplicates: 0,
    write() {
      for (const id of parsed)
        addLink(
          { type: "session", id: `probe-legacy-${mode}-${id}` },
          "context",
          { type: "task", id: "1" },
        );
      // Rewrite the file mid-transaction until the attempts run out.
      writeFileSync(legacyFile, JSON.stringify(["a", "b", `${rewrites++}`]));
      return parsed.length;
    },
  }));
  assert(
    changing.kind === "failed" && rowsOf() === 0,
    `A changing legacy file committed rows (${JSON.stringify(changing)}).`,
  );
  const imported = importLegacyJsonStore(legacyFile, (parsed) => ({
    records: parsed.length,
    invalid: 0,
    duplicates: 0,
    write() {
      for (const id of parsed)
        addLink(
          { type: "session", id: `probe-legacy-${mode}-${id}` },
          "context",
          { type: "task", id: "1" },
        );
      return parsed.length;
    },
  }));
  assert(
    imported.kind === "imported" && imported.imported === 3 && rowsOf() === 3,
    `The legacy import did not commit (${JSON.stringify(imported)}).`,
  );
  assert(!existsSync(legacyFile), "The imported legacy file was not renamed.");

  // #376: the session delete is one transaction, rolled back as a whole.
  const owner = `probe-owner-${mode}`;
  sessionStore.upsert({
    id: owner,
    scope: "user",
    harness: "claude-sdk",
    agentType: "developer",
  });
  const item = backgroundWorkStore.reserveItem({
    ownerSessionId: owner,
    backend: "host-process",
    kind: "shell",
    label: "probe",
    sourceRequestId: `probe-${mode}`,
    lifetimeMs: 60_000,
    settingsGeneration: 1,
    bootEpoch: "probe",
    ownerLimit: 10,
  });
  backgroundWorkStore.terminalize({ itemId: item.id, state: "completed" });
  db.exec(
    `CREATE TEMP TRIGGER probe_fail_delete BEFORE UPDATE OF deleted_at_ms
     ON session_index WHEN OLD.id = '${owner}'
     BEGIN SELECT RAISE(ABORT, 'probe session write failure'); END`,
  );
  let refused;
  try {
    backgroundWorkStore.deleteOwnerSession(owner);
  } catch (error) {
    refused = error;
  } finally {
    db.exec("DROP TRIGGER probe_fail_delete");
  }
  assert(
    String(refused).includes("probe session write failure"),
    `The injected delete failure did not surface: ${refused}`,
  );
  assert(
    sessionStore.get(owner)?.id === owner &&
      backgroundWorkStore.getItem(item.id)?.label === "probe",
    "A failed session delete left a partial tombstone.",
  );
  const deleted = backgroundWorkStore.deleteOwnerSession(owner);
  assert(
    deleted.session === "deleted" && deleted.itemIds[0] === item.id,
    `The session delete answered ${JSON.stringify(deleted)}.`,
  );
  assert(
    sessionStore.get(owner) === undefined &&
      backgroundWorkStore.getItem(item.id) === undefined,
    "The session delete did not tombstone its history.",
  );
}

function checkSyncSpawnEnvironment() {
  // The harness starts this process with both set; the server's boot scrub
  // deletes variables the same way.
  delete process.env.PA_PROBE_SCRUBBED;
  process.env.PA_PROBE_ADDED = "added";
  const script = 'echo "${PA_PROBE_SCRUBBED:-none} ${PA_PROBE_ADDED:-none}"';
  for (const [name, output] of [
    ["execFileSync", () => execFileSync("sh", ["-c", script])],
    ["spawnSync", () => spawnSync("sh", ["-c", script]).stdout],
    ["execSync", () => execSync(script)],
    [
      "execFileSync with env: null",
      () => execFileSync("sh", ["-c", script], { env: null }),
    ],
    [
      "spawnSync with env: null",
      () => spawnSync("sh", ["-c", script], { env: null }).stdout,
    ],
    ["execSync with env: null", () => execSync(script, { env: null })],
  ]) {
    const seen = String(output()).trim();
    assert(
      seen === "none added",
      `${name} did not start its child with the current environment: ${seen}`,
    );
  }
}

/**
 * Bun's fetch and node:http honour HTTP(S)_PROXY in `process.env`, so the
 * package proxy must publish its bundle to children only. The proxy answers
 * plain HTTP with 501 for every host: a request to an `.invalid` host that
 * reached it gets that reply, and a direct one fails to resolve.
 */
async function checkPackageProxyEnvironment() {
  updateGithubSettings({
    enabled: true,
    token: "bun-probe-token",
    packageProxyEnabled: true,
  });
  const before = { ...process.env };
  const status = await startPackageProxyIfEnabled();
  assert(status.running, `The package proxy did not start: ${status.reason}`);
  const bundle = packageProxyEnvironment() ?? {};
  for (const key of Object.keys(bundle))
    assert(
      process.env[key] === before[key],
      `The package proxy set ${key} on the server's own process.env.`,
    );

  const target = "http://pa-package-proxy-probe.invalid/";
  const reachedProxy = (status, body) =>
    status === 501 && body.includes("only CONNECT");
  const viaFetch = await globalThis
    .fetch(target, {
      signal: globalThis.AbortSignal.timeout(10_000),
    })
    .then(async (reply) => reachedProxy(reply.status, await reply.text()))
    .catch(() => false);
  assert(!viaFetch, "The server's own fetch went through the package proxy.");
  const viaHttp = await new Promise((resolve) => {
    const request = httpGet(target, (reply) => {
      let body = "";
      reply.setEncoding("utf8");
      reply.on("data", (chunk) => (body += chunk));
      reply.on("end", () => resolve(reachedProxy(reply.statusCode, body)));
    });
    request.on("error", () => resolve(false));
    request.setTimeout(10_000, () => request.destroy());
  });
  assert(
    !viaHttp,
    "The server's own node:http went through the package proxy.",
  );

  // The control: a packaged-Bun child given the child env does reach it, so
  // the two refusals above are not a proxy that never answers. Asynchronous:
  // the proxy answers from this process's event loop.
  const control = await brokerExecFile({
    file: process.execPath,
    args: [
      "-e",
      `fetch(${JSON.stringify(target)}).then(async r => console.log(r.status, await r.text()), () => console.log("direct"))`,
    ],
    cwd: scratch,
    env: childProcessEnv(),
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
    signal: globalThis.AbortSignal.timeout(20_000),
  });
  const [controlStatus, ...controlBody] = control.stdout.trim().split(" ");
  assert(
    reachedProxy(Number(controlStatus), controlBody.join(" ")),
    `A child with the child env did not reach the package proxy: ${control.stdout}${control.stderr}`,
  );
  const seen = await git(
    ["-c", "alias.pa-env=!printenv HTTPS_PROXY", "pa-env"],
    scratch,
  );
  assert(
    seen.stdout.trim() === bundle.HTTPS_PROXY,
    "git did not get the package proxy's env bundle.",
  );
  await stopPackageProxy();
}

/**
 * pi loads OAuth flows through a variable `import()` of a sibling file that
 * the bundle does not have; `piSdk/models.ts` registers them statically. The
 * seeded ChatGPT credential (test-bun-server-bundle.mjs) derives its auth
 * offline, so a missing flow is the only way this fails.
 */
async function checkPiOAuthFlows() {
  const runtime = await modelRuntimeForProfile();
  const auth = await runtime.getAuth("openai-codex");
  assert(
    auth?.auth?.apiKey === "bun-probe-access",
    `pi could not derive openai-codex OAuth auth: ${JSON.stringify(auth)}`,
  );
}

await checkGit();
await checkPackageProxyEnvironment();
if (mode === "broker") {
  await checkWatcher();
  checkSqlite();
  checkSyncSpawnEnvironment();
  await checkPiOAuthFlows();
}
console.log(`Bun runtime probe (${mode}) passed.`);
process.exit(0);
