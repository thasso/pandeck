/**
 * Server code the packaged Bun runtime must run the way Node runs it, driven
 * directly because a booted server reaches none of it on demand: checkout git
 * through the in-process Worker and the spawn broker (its cancel, its exit
 * receipt, its group kill, the receipt on broker death, exact UTF-16 text),
 * the in-process fallback, served-file bytes read through the Worker's file
 * methods, served-file requests whose client leaves early,
 * a watcher subscribed with a git-derived ignore set, the SQLite paths that
 * depend on the `node:sqlite` shim, the package proxy's env reaching
 * children but never the server's own fetch, pi's OAuth flows, and an
 * Initiative map laid out by elkjs in the bundled layout worker.
 *
 * Not run from a checkout. `test-bun-server-bundle.mjs` bundles it with the
 * server's own plugins and runs it with the packaged Bun, once per mode:
 * `broker`, and `in-process` under `ASSISTANT_SPAWN_BROKER=0`.
 */
import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, get as httpGet } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
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
import {
  handleFileGrantRequest,
  mintDocumentGrant,
} from "../app/server/src/directFileGrants.ts";
import { handleDirectFileRequest } from "../app/server/src/directFileHttp.ts";
import {
  fileReadsCountsForTests,
  holdFileForTests,
} from "../app/server/src/fileReads.ts";
import {
  GitCommandError,
  git,
  gitBoundedStdout,
  gitWithInputOptional,
} from "../app/server/src/gitExec.ts";
import { readInitiativeMap } from "../app/server/src/initiativeLayout.ts";
import { stopInitiativeLayoutWorker } from "../app/server/src/initiativeLayoutRunner.ts";
import { createInitiative } from "../app/server/src/initiatives.ts";
import { updateGithubSettings } from "../app/server/src/githubSettings.ts";
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
import {
  openServedFile,
  statServedFile,
} from "../app/server/src/servedFileAccess.ts";
import { childProcessEnv } from "../app/server/src/subprocessEnv.ts";
import { createTask, updateTask } from "../app/server/src/tasks.ts";
import { MAX_FRAME_PAYLOAD_BYTES } from "../app/server/src/workerProtocol/codec.ts";
import {
  ensureInProcessWorker,
  inProcessWorkerFileHandlesForTests,
  inProcessWorkerServedMethodForTests,
  writeAsInProcessWorkerForTests,
} from "../app/server/src/workers/inProcessWorker.ts";
import { treeIgnoreForTests } from "../app/server/src/worktrees/worktreeWatcher.ts";
import { checkWorkerFileOpenEnd } from "./worker-file-open-end-probe.ts";

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

/** A process's `/proc` state letter; `gone` once reaped. */
function procState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  } catch {
    return "gone";
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

/**
 * Checkout git crosses the in-process Worker: a bounded read cut inside a
 * surrogate pair keeps the lone high surrogate (UTF-16LE on the wire), and an
 * aborted git settles only once its child has exited — a stand-in `git` that
 * handles SIGTERM writes for a while, then `done`, and the caller sees the
 * rejection only after that.
 */
async function checkWorkerGit(repo) {
  const blob = await gitWithInputOptional(
    ["hash-object", "-w", "--stdin"],
    repo,
    "\u{1F600}abc",
  );
  const cut = await gitBoundedStdout(
    ["cat-file", "blob", blob.stdout.trim()],
    repo,
    1,
  );
  assert(
    cut.patch.length === 1 &&
      cut.patch.charCodeAt(0) === 0xd83d &&
      cut.totalChars === 5 &&
      cut.truncated,
    `A cut surrogate pair came back as ${JSON.stringify(cut)}.`,
  );

  const dir = join(scratch, "standin");
  mkdirSync(join(dir, "bin"), { recursive: true });
  const log = join(dir, "log");
  writeFileSync(
    join(dir, "bin", "git"),
    [
      "#!/bin/sh",
      `log='${log}'`,
      'on_term() { echo term >> "$log"; sleep 0.5; echo done >> "$log"; exit 0; }',
      "trap on_term TERM",
      'echo started >> "$log"',
      "while :; do sleep 0.05; done",
    ].join("\n"),
  );
  chmodSync(join(dir, "bin", "git"), 0o755);
  const controller = new globalThis.AbortController();
  const run = git(["standin"], repo, controller.signal, {
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
  }).then(
    () => undefined,
    (error) => error,
  );
  const logged = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  await until(() => logged().includes("started"), "the stand-in git");
  controller.abort();
  const error = await run;
  assert(
    error instanceof GitCommandError,
    `An aborted checkout git answered ${error}.`,
  );
  assert(
    logged().includes("done"),
    `An aborted checkout git settled before its child exited: ${logged()}`,
  );
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readServed(file, start, end) {
  const chunks = [];
  for await (const chunk of file.createReadStream({ start, end }))
    chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Served files cross the in-process Worker as bytes: a binary file outside
 * `DATA_DIR` comes back exact, whole and in a range across a chunk edge, in
 * more than one read; a request naming another Worker is refused; and a handle
 * whose connection ended fails without touching the one that replaced it.
 */
async function checkWorkerFiles() {
  const chunk = MAX_FRAME_PAYLOAD_BYTES;
  const size = 3 * chunk + 7;
  const bytes = Buffer.alloc(size);
  for (let at = 0; at < size; at += 1) bytes[at] = (at * 151 + 7) & 0xff;
  const outside = mkdtempSync(join(tmpdir(), `bun-probe-files-${mode}-`));
  const path = join(outside, "served.bin");
  writeFileSync(path, bytes);

  const reads = () => inProcessWorkerServedMethodForTests("files.read");
  const before = reads();
  assert(
    (await statServedFile(path)).size === size,
    "A served stat lost the size.",
  );
  const file = await openServedFile(path, { stat: false });
  const whole = await readServed(file, 0, size - 1);
  const start = chunk - 5;
  const end = 2 * chunk + 3;
  const range = await readServed(file, start, end);
  await file.close();
  assert(
    sha256(whole) === sha256(bytes),
    "A served file came back changed through the Worker.",
  );
  assert(
    range.equals(bytes.subarray(start, end + 1)),
    "A served range across a chunk edge came back changed.",
  );
  assert(reads() - before >= 6, "Served bytes did not cross the Worker.");

  let refused;
  try {
    await ensureInProcessWorker().request("files.stat", {
      json: { location: { workerId: "elsewhere", path } },
    });
  } catch (error) {
    refused = error;
  }
  assert(
    refused?.code === "wrong_worker",
    `A file request for another Worker answered ${refused}.`,
  );

  const stale = await openServedFile(path, { stat: false });
  const ending = ensureInProcessWorker();
  writeAsInProcessWorkerForTests(new Uint8Array(8));
  await ending.ended;
  // The replacement handle exists before the stale one is used or closed, and
  // the new connection's table may hold the very id the stale one carries.
  const fresh = await openServedFile(path, { stat: false });
  const sent = () =>
    ["files.read", "files.close"].map((method) =>
      inProcessWorkerServedMethodForTests(method),
    );
  const untouched = sent();
  let failed;
  try {
    await readServed(stale, 0, 10);
  } catch (error) {
    failed = error;
  }
  assert(
    /The Worker connection ended/.test(String(failed)),
    `A handle from an ended connection answered ${failed}.`,
  );
  await stale.close();
  assert(
    sent().join() === untouched.join(),
    "A stale handle's read or close reached the replacement connection.",
  );
  const again = await readServed(fresh, 0, size - 1);
  await fresh.close();
  assert(
    sha256(again) === sha256(bytes),
    "A handle opened before a stale close came back changed after it.",
  );
  rmSync(outside, { recursive: true, force: true });
}

/**
 * A client that leaves a served-file request stops its reads under Bun too,
 * which reports the disconnect on the request and its socket but never closes
 * the response. On both routes, a client gone before the handler runs, or while
 * its open is held, costs at most one chunk read and no more than one close of
 * what was opened; one gone mid-body ends the handler before the file's end,
 * with its file closed once; a client that stays gets every byte.
 */
async function checkServedFileCancellation() {
  const size = 4 * MAX_FRAME_PAYLOAD_BYTES;
  const bytes = Buffer.alloc(size);
  for (let at = 0; at < size; at += 1) bytes[at] = (at * 31 + 3) & 0xff;
  const outside = mkdtempSync(join(tmpdir(), `bun-probe-cancel-${mode}-`));
  const path = join(outside, "served.bin");
  writeFileSync(path, bytes);
  const longChunks = 32;
  const long = join(outside, "long.bin");
  writeFileSync(long, Buffer.alloc(longChunks * MAX_FRAME_PAYLOAD_BYTES, 5));
  const routes = {
    direct: [`/api/files${path}`, `/api/files${long}`],
    grant: [
      (await mintDocumentGrant(path, "file", "inline")).url,
      (await mintDocumentGrant(long, "file", "inline")).url,
    ],
  };

  let arrived;
  const server = createServer((req, res) => arrived(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const handle = (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    return url.pathname.startsWith("/api/file-grants/")
      ? handleFileGrantRequest(req, res, url)
      : handleDirectFileRequest(req, res, url, {});
  };
  /** The request as the server sees it, once its client has sent it. */
  const send = (url) => {
    const seen = new Promise((resolve) => {
      arrived = (req, res) => resolve({ req, res });
    });
    const chunks = [];
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(
        `GET ${url} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
      ),
    );
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => chunks.push(chunk));
    const received = new Promise((resolve) =>
      socket.on("close", () => resolve(Buffer.concat(chunks))),
    );
    return { socket, seen, received };
  };
  /** Ends the client, and resolves once the server has seen it go. */
  const leave = async (socket, req) => {
    const gone = new Promise((resolve) => req.once("close", resolve));
    socket.destroy();
    await gone;
  };
  const counts = () =>
    ["files.open", "files.read", "files.close"].map((method) =>
      inProcessWorkerServedMethodForTests(method),
    );
  const settles = (handled, what) =>
    Promise.race([
      handled.then(() => true),
      sleep(5000).then(() => false),
    ]).then((settled) =>
      assert(settled, `${what}: the handler never settled.`),
    );
  /** What one abandoned request cost, and that it left nothing open. */
  const abandoned = async (what, before, received) => {
    const [opens, reads, closes] = counts().map((n, at) => n - before[at]);
    console.log(
      `Served-file cancellation (${mode}), ${what}: opens=${opens} reads=${reads} closes=${closes}.`,
    );
    assert(reads <= 1, `${what}: ${reads} chunk reads for a client gone.`);
    assert(
      opens === closes && opens <= 1,
      `${what}: ${opens} opens closed ${closes} times.`,
    );
    assert(
      (await received).byteLength === 0,
      `${what}: a client gone got bytes.`,
    );
    assert(
      inProcessWorkerFileHandlesForTests() === 0 &&
        fileReadsCountsForTests().liveDescriptors === 0,
      `${what}: a file was left open.`,
    );
  };

  for (const [route, [url, longUrl]] of Object.entries(routes)) {
    // A client that stays gets the whole file: nothing reads as abandoned.
    let before = counts();
    let request = send(url);
    let { req, res } = await request.seen;
    await settles(handle(req, res), `${route} kept`);
    const response = await request.received;
    const split = response.indexOf("\r\n\r\n");
    assert(
      /^HTTP\/1\.1 200 /.test(response.subarray(0, split).toString()) &&
        sha256(response.subarray(split + 4)) === sha256(bytes),
      `${route}: a client that stayed did not get the whole file.`,
    );
    const [, reads] = counts().map((n, at) => n - before[at]);
    assert(reads === 4, `${route}: a kept request made ${reads} reads.`);

    // Gone before the handler runs.
    before = counts();
    request = send(url);
    ({ req, res } = await request.seen);
    await leave(request.socket, req);
    await settles(handle(req, res), `${route} gone before the handler`);
    await abandoned(
      `${route} gone before the handler`,
      before,
      request.received,
    );

    // Gone while the open is held, the handler having started at once.
    before = counts();
    const held = holdFileForTests(path, "after-open");
    request = send(url);
    ({ req, res } = await request.seen);
    const handled = handle(req, res);
    await held.reached;
    await leave(request.socket, req);
    held.release();
    await held.disposed;
    await settles(handled, `${route} gone during the open`);
    await abandoned(`${route} gone during the open`, before, request.received);

    // Gone mid-body: the client leaves at its first bytes.
    before = counts();
    request = send(longUrl);
    ({ req, res } = await request.seen);
    const streaming = handle(req, res);
    await new Promise((resolve) => request.socket.once("data", resolve));
    await leave(request.socket, req);
    await settles(streaming, `${route} gone mid-body`);
    const [opens, partial, closes] = counts().map((n, at) => n - before[at]);
    console.log(
      `Served-file cancellation (${mode}), ${route} gone mid-body: opens=${opens} reads=${partial} closes=${closes}.`,
    );
    assert(
      opens === 1 && closes === 1 && partial < longChunks,
      `${route} gone mid-body: ${opens} opens, ${partial} reads of ${longChunks}, ${closes} closes.`,
    );
    assert(
      inProcessWorkerFileHandlesForTests() === 0 &&
        fileReadsCountsForTests().liveDescriptors === 0,
      `${route} gone mid-body: a file was left open.`,
    );
  }
  await new Promise((resolve) => server.close(resolve));
  rmSync(outside, { recursive: true, force: true });
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

  await checkWorkerGit(repo);
  await checkWorkerFiles();
  await checkWorkerFileOpenEnd();
  await checkServedFileCancellation();

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

  await checkBrokerDeathReceipt(repo);
}

/**
 * On broker death, an exit-receipt request waits for the broker's process
 * group to exit, which it observes with signal 0 to the negative pgid. Bun
 * must report an empty group as ESRCH and a live one without throwing, and a
 * checkout git lost with its broker must reject only once its stand-in child
 * is gone or a zombie — with the Worker connection kept and with it ending.
 */
async function checkBrokerDeathReceipt(repo) {
  const solo = spawn("true", [], { detached: true, stdio: "ignore" });
  await new Promise((resolve) => solo.once("exit", resolve));
  let code;
  try {
    process.kill(-solo.pid, 0);
  } catch (error) {
    code = error?.code;
  }
  assert(code === "ESRCH", `Signal 0 to an empty group threw ${code}.`);
  const live = await spawnBrokerPidForTests();
  process.kill(-live, 0);

  const dir = join(scratch, "broker-death");
  mkdirSync(join(dir, "bin"), { recursive: true });
  const pidFile = join(dir, "pid");
  writeFileSync(
    join(dir, "bin", "git"),
    [
      "#!/bin/sh",
      `echo $$ > '${pidFile}'`,
      "trap '' TERM",
      "while :; do sleep 0.05; done",
    ].join("\n"),
  );
  chmodSync(join(dir, "bin", "git"), 0o755);
  for (const endConnection of [false, true, false, true]) {
    writeFileSync(pidFile, "");
    let state;
    const run = git(["standin"], repo, undefined, {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    }).then(
      () => undefined,
      (error) => {
        state = procState(Number(readFileSync(pidFile, "utf8")));
        return error;
      },
    );
    await until(() => readFileSync(pidFile, "utf8") !== "", "the stand-in");
    const child = Number(readFileSync(pidFile, "utf8"));
    const broker = await spawnBrokerPidForTests();
    assert(
      processGroup(child) === broker,
      "The stand-in left the broker's process group.",
    );
    if (endConnection) writeAsInProcessWorkerForTests(new Uint8Array(8));
    process.kill(broker, "SIGKILL");
    const error = await run;
    assert(
      error instanceof GitCommandError && error.failureKind === "execution",
      `A checkout git lost with its broker answered ${error}.`,
    );
    assert(
      ["gone", "Z", "X"].includes(state),
      `A checkout git lost with its broker rejected while its child was ${state}.`,
    );
  }
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

/**
 * elkjs's worker script takes its web-worker path wherever `self` exists, and
 * Bun defines it, so `new ELK()` threw under Bun. The bundled layout worker
 * hides `self` in its own thread; this lays out a small map through it, with
 * an outside blocker, and checks the server thread kept its `self`.
 */
async function checkInitiativeLayout() {
  const user = { source: { createdBy: "user" } };
  const epic = createTask({ ...user, title: "Probe epic", projectId: "probe" });
  const first = createTask({ ...user, title: "Probe 1", parentId: epic.id });
  const second = createTask({ ...user, title: "Probe 2", parentId: epic.id });
  const outside = createTask({ ...user, title: "Probe outside" });
  updateTask(second.id, {
    addLinks: [
      { type: "blocked-by", taskId: first.id },
      { type: "blocked-by", taskId: outside.id },
    ],
  });
  const id = String(
    createInitiative({ title: "Probe map", taskIds: [epic.id] }).initiative.id,
  );
  const read = await readInitiativeMap(id);
  assert(
    read.layout && read.layoutError === undefined,
    `The Initiative map was not laid out: ${read.layoutError}`,
  );
  const at = (taskId) => read.layout.nodes.find((node) => node.id === taskId);
  assert(
    read.layout.nodes.length === 4 && read.layout.edges.length === 2,
    `Unexpected map: ${JSON.stringify(read.layout)}`,
  );
  assert(
    at(first.id).x < at(second.id).x,
    "The map does not read left to right.",
  );
  for (const edge of read.layout.edges)
    assert(
      edge.points.every(
        (point, i) =>
          i === 0 ||
          point.x === edge.points[i - 1].x ||
          point.y === edge.points[i - 1].y,
      ),
      `A route is not orthogonal: ${JSON.stringify(edge.points)}`,
    );
  assert(typeof self === "object", "The server thread lost its `self`.");
  stopInitiativeLayoutWorker();
}

await checkGit();
await checkPackageProxyEnvironment();
if (mode === "broker") {
  await checkWatcher();
  checkSqlite();
  checkSyncSpawnEnvironment();
  await checkPiOAuthFlows();
  await checkInitiativeLayout();
}
console.log(`Bun runtime probe (${mode}) passed.`);
process.exit(0);
