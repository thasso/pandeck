/**
 * Server code the packaged Bun runtime must run the way Node runs it, driven
 * directly because a booted server reaches none of it on demand: checkout git
 * through the in-process Worker and the spawn broker (its cancel, its exit
 * receipt, its group kill, the receipt on broker death, exact UTF-16 text),
 * the in-process fallback, served-file bytes read through the Worker's file
 * methods, served-file requests whose client leaves early, the worktree
 * surfaces' and checkout workflows' reads against Bun's own `fs`,
 * a checkout watch through the Worker with a git-derived ignore set, lost
 * with its connection and made again on the next, the SQLite paths that
 * depend on the `node:sqlite` shim, the package proxy's env reaching
 * children but never the server's own fetch, pi's OAuth flows, and an
 * Initiative map laid out by elkjs in the bundled layout worker. First of all,
 * that a child's managed stdio never closes a descriptor number something
 * else reused (Bun 1.3.13 did, at GC), and that `maxBuffer` bounds each
 * stream's length on overflow as Node does.
 *
 * The checkout lifecycle methods run against native `fs` and base code on a
 * twin fixture, and the process stop against a tree whose every pid is known.
 *
 * Not run from a checkout. `test-bun-server-bundle.mjs` bundles it with the
 * server's own plugins and runs it with the packaged Bun, once per mode:
 * `broker`, and `in-process` under `ASSISTANT_SPAWN_BROKER=0`.
 */
import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createServer, get as httpGet } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInThisContext } from "node:vm";
import {
  checkoutFailureOf,
  checkoutPathExists,
  inspectCheckoutPath,
  readCheckoutDir,
  readCheckoutFile,
  readCheckoutLink,
} from "../app/server/src/checkoutFileAccess.ts";
import {
  runCommitWorkflow,
  setCommitMessageGeneratorForTests,
} from "../app/server/src/commitWorkflow.ts";
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
  failFileForTests,
  fileFaultArmedForTests,
  fileReadsCountsForTests,
  holdFileForTests,
} from "../app/server/src/fileReads.ts";
import {
  GitCommandError,
  clearRepoLockKeysForTests,
  git,
  gitBoundedStdout,
  gitWithInputOptional,
  repoLockKey,
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
import { modelRuntimeForProfile } from "../app/server/src/piSdk/models.ts";
import {
  brokerExecFile,
  spawnBrokerPidForTests,
} from "../app/server/src/spawnBroker.ts";
import {
  openServedFile,
  statServedFile,
} from "../app/server/src/servedFileAccess.ts";
import { checkoutWatchOn } from "../app/server/src/checkoutWatchAccess.ts";
import { checkoutLifecycleOn } from "../app/server/src/checkoutLifecycle.ts";
import { errorText } from "../app/server/src/errors.ts";
import {
  removeManagedTree,
  restoreOwnerAccess,
  scanTreeResidue,
} from "../app/server/src/managedTreeRemoval.ts";
import {
  LIFECYCLE_METHODS,
  encodeLifecycleLocation,
  encodeRemoveTree,
} from "../app/server/src/workerProtocol/lifecycleMethods.ts";
import { childProcessEnv } from "../app/server/src/subprocessEnv.ts";
import { createTask, updateTask } from "../app/server/src/tasks.ts";
import { MAX_FRAME_PAYLOAD_BYTES } from "../app/server/src/workerProtocol/codec.ts";
import { WorkerMethodError } from "../app/server/src/workerProtocol/connection.ts";
import { isWorkerFailure } from "../app/server/src/workers/fileClient.ts";
import {
  answerNextInProcessWorkerCallForTests,
  ensureInProcessWorker,
  inProcessWorkerEpochForTests,
  inProcessWorkerFileHandlesForTests,
  inProcessWorkerServedMethodForTests,
  inProcessWorkerWatchesForTests,
  writeAsInProcessWorkerForTests,
} from "../app/server/src/workers/inProcessWorker.ts";
import { recordWatchDeliveriesForTests } from "../app/server/src/workers/watchDeliveries.ts";
import { DEFAULT_WORKER_SIDE } from "../app/server/src/workers/placement.ts";
import { treeIgnoreForTests } from "../app/server/src/worktrees/worktreeWatcher.ts";
import {
  getWorktreeFileContent,
  getWorktreeFileRaw,
} from "../app/server/src/worktrees/worktreeDiff.ts";
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

/**
 * The fd-reuse check's body: ONE source, evaluated here with this process's
 * `require` and handed to a separate Bun through `-e`, so the shapes cannot
 * drift. Each iteration starts a detached `sh` with managed pipes, destroys
 * them and kills its group, then opens a FIFO four times, likely into the
 * numbers just freed. After a GC, each fd must still name the FIFO it was
 * opened on: Bun 1.3.13 closed a dead child's stdio numbers at GC, whatever
 * had reused them since (Task-1231).
 *
 * Only numeric pids outlive an iteration. Keeping the ChildProcess or its
 * streams reachable keeps them from being collected, which hides exactly the
 * defect this looks for.
 */
const FD_REUSE_SOURCE = String.raw`(async function fdReuseCheck(require, dir, iterations, track) {
  const { spawn, spawnSync } = require("node:child_process");
  const fs = require("node:fs");
  const { join } = require("node:path");
  // O_CLOEXEC on Linux; node:fs does not export it.
  const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | 0o2000000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const groups = new Set();
  const killGroup = (pid) => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (_) {}
  };
  let reused = 0;
  const lost = [];
  try {
    for (let i = 0; i < iterations; i += 1) {
      const fds = [];
      try {
        const child = spawn("sh", ["-c", "read _; sleep 600"], {
          detached: true,
          stdio: ["pipe", "ignore", "ignore", "pipe", "pipe", "pipe"],
        });
        const pid = child.pid;
        groups.add(pid);
        track(pid);
        for (const stream of child.stdio) if (stream && stream.on) stream.on("error", () => {});
        const event = (name) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Timed out waiting for sh " + pid + " to " + name + ".")),
              5000,
            );
            child.once(name, () => {
              clearTimeout(timer);
              resolve();
            });
          });
        const exited = event("exit");
        const closed = event("close");
        // Awaited in turn: a timeout on one must not leave the other unhandled.
        closed.catch(() => {});
        await sleep(20);
        const managed = child.stdio
          .map((stream) =>
            [stream && stream.fd, stream && stream._handle && stream._handle.fd,
              stream && stream._socket && stream._socket._handle && stream._socket._handle.fd]
              .find(Number.isInteger),
          )
          .filter(Number.isInteger);
        for (const stream of child.stdio) if (stream && stream.destroy) stream.destroy();
        killGroup(pid);
        const fifo = join(dir, "fifo-" + i);
        const made = spawnSync("mkfifo", ["-m", "600", fifo]);
        if (made.status !== 0) throw new Error("mkfifo failed: " + String(made.stderr));
        for (let n = 0; n < 4; n += 1) fds.push(fs.openSync(fifo, flags));
        const before = fds.map((fd) => fs.fstatSync(fd));
        if (fds.some((fd) => managed.includes(fd))) reused += 1;
        fs.unlinkSync(fifo);
        await exited;
        await closed;
        await sleep(100);
        if (globalThis.Bun) globalThis.Bun.gc(true);
        await sleep(100);
        const gone = [];
        fds.forEach((fd, at) => {
          try {
            const now = fs.fstatSync(fd);
            if (now.dev !== before[at].dev || now.ino !== before[at].ino)
              gone.push({ fd, code: "reused by another file" });
          } catch (error) {
            gone.push({ fd, code: (error && error.code) || String(error) });
          }
        });
        if (gone.length) lost.push({ iteration: i, managed, fds, lost: gone });
      } finally {
        for (const fd of fds)
          try {
            fs.closeSync(fd);
          } catch (_) {}
      }
    }
  } finally {
    // A late "sleep 600" may still have started inside a killed group.
    for (const pid of groups) killGroup(pid);
  }
  return { iterations, reused, lost };
})`;

const FD_REUSE_ITERATIONS = 10;

/** The check in this process: the server's own spawns, direct or in-process. */
async function fdReuseInline(dir, track) {
  const check = runInThisContext(FD_REUSE_SOURCE);
  return check(createRequire(import.meta.url), dir, FD_REUSE_ITERATIONS, track);
}

/**
 * The check in a separate packaged Bun launched as `spawnBroker.ts` launches
 * the broker: detached, without `NODE_OPTIONS`. It reports each `sh` pid as it
 * starts, so a child that never answers leaves nothing behind either.
 */
async function fdReuseInBrokerShapedChild(dir, track) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const script =
    `${FD_REUSE_SOURCE}(require, ${JSON.stringify(dir)}, ${FD_REUSE_ITERATIONS}, ` +
    `(pid) => process.stdout.write(JSON.stringify({ pid }) + "\\n")).then(` +
    `(result) => { process.stdout.write(JSON.stringify({ result }) + "\\n"); process.exit(0); }, ` +
    `(error) => { console.error(error); process.exit(1); });`;
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["pipe", "pipe", "inherit"],
    env,
    detached: true,
  });
  const pid = child.pid;
  track(pid);
  let result;
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    pending += data;
    for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
      const line = JSON.parse(pending.slice(0, at));
      pending = pending.slice(at + 1);
      if (line.pid) track(line.pid);
      if (line.result) result = line.result;
    }
  });
  const code = await new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(
      () =>
        reject(new Error("The broker-shaped fd check did not finish in 30s.")),
      30_000,
    );
    child.once("close", (exitCode, signal) => {
      globalThis.clearTimeout(timer);
      resolve(exitCode ?? signal);
    });
  });
  child.stdin.destroy();
  assert(code === 0, `The broker-shaped fd check exited with ${code}.`);
  assert(result, "The broker-shaped fd check printed no result.");
  return result;
}

/**
 * Every shape for this mode runs before any fails, so a broken runtime
 * reports all of them. A check without one reused number proves nothing.
 */
async function checkManagedStdioFdReuse() {
  const groups = new Set();
  const track = (pid) => groups.add(pid);
  const shapes = [["inline", fdReuseInline]];
  if (mode === "broker") shapes.push(["child", fdReuseInBrokerShapedChild]);
  const failures = [];
  try {
    for (const [shape, run] of shapes) {
      const label = `Managed-stdio fd reuse (${mode}, ${shape})`;
      const dir = mkdtempSync(join(scratch, `fd-reuse-${shape}-`));
      try {
        const { iterations, reused, lost } = await run(dir, track);
        if (lost.length)
          failures.push(
            `${label}: ${lost.length} of ${iterations} iterations lost a descriptor: ${JSON.stringify(lost)}`,
          );
        else if (reused === 0)
          failures.push(
            `${label}: no iteration reused a managed fd number, so nothing was proven.`,
          );
        else
          console.log(
            `${label}: ${iterations} iterations, ${reused} reused, 0 lost.`,
          );
      } catch (error) {
        failures.push(`${label}: ${error?.stack ?? error}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    for (const pid of groups)
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The group is gone already.
      }
  }
  assert(failures.length === 0, failures.join("\n"));
}

/**
 * On overflow, each stream comes back with exactly `maxBuffer` of its length
 * (Node's and Bun 1.3.13's bound; Bun 1.4.2 alone overshoots it), whichever
 * stream overflowed and in either encoding, with the other stream empty.
 */
async function checkMaxBufferBound() {
  const maxBuffer = 1024 * 1024;
  for (const [stream, encoding, script] of [
    ["stdout", "utf8", "yes | head -c 2097152"],
    ["stdout", "buffer", "head -c 2097152 /dev/zero"],
    ["stderr", "utf8", "yes | head -c 2097152 >&2"],
    ["stderr", "buffer", "head -c 2097152 /dev/zero >&2"],
  ]) {
    const result = await brokerExecFile({
      file: "sh",
      args: ["-c", script],
      cwd: scratch,
      env: process.env,
      maxBuffer,
      encoding,
    });
    const other = stream === "stdout" ? "stderr" : "stdout";
    assert(
      result.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
        result[stream].length === maxBuffer &&
        result[other].length === 0,
      `The ${encoding} ${stream} overflow answered ${JSON.stringify({
        error: result.error,
        stdout: result.stdout.length,
        stderr: result.stderr.length,
      })}, not exactly ${maxBuffer} on ${stream}.`,
    );
  }
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

const served = (method) => inProcessWorkerServedMethodForTests(method);

/** Runs `run`, requiring each named method to have crossed the Worker. */
async function crossing(methods, what, run) {
  const before = methods.map(served);
  const result = await run();
  methods.forEach((method, at) =>
    assert(served(method) > before[at], `${what}: no ${method} crossed.`),
  );
  return result;
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected a rejection.");
}

/**
 * The worktree surfaces' checkout reads cross the in-process Worker and
 * answer as Bun's own `fs` does on the same paths, re-observing the
 * verifier's baseline in place (`docs/workers.md`, "Checkout files"). A
 * mismatch is a contract question, never a value to adopt.
 */
async function checkWorkerCheckoutReads() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `bun-probe-checkout-${mode}-`)),
  );
  const row = {
    id: "bun-probe-checkout",
    projectId: "bun-probe",
    path: root,
    mainRepoRoot: root,
    branch: "main",
    baseBranch: "main",
    baseCommit: "",
    status: "active",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  };
  try {
    await git(["init", "-q", "-b", "main"], root);
    writeFileSync(join(root, "three"), "abc");
    writeFileSync(join(root, "empty"), "");
    await git(["add", "three", "empty"], root);
    await git([...identity, "commit", "-q", "-m", "probe"], root);
    const outside = mkdtempSync(join(tmpdir(), `bun-probe-outside-${mode}-`));
    writeFileSync(join(outside, "secret"), "SECRET");
    symlinkSync(join(outside, "secret"), join(root, "escape"));
    mkdirSync(join(root, "dir"));
    symlinkSync(join(root, "dir"), join(root, "dir-link"));
    symlinkSync(join(root, "three"), join(root, "three-link"));

    // Existence, as `existsSync` answers it.
    const locked = join(root, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "inside"), "x");
    const unreadable = process.getuid?.() !== 0;
    if (unreadable) chmodSync(locked, 0o000);
    try {
      for (const path of [
        join(root, "three"),
        join(root, "missing"),
        join(root, "three", "child"),
        ...(unreadable ? [join(locked, "inside")] : []),
      ]) {
        const answer = await crossing(["files.exists"], path, () =>
          checkoutPathExists(root, path),
        );
        assert(
          answer === existsSync(path),
          `exists(${path}) answered ${answer}, Bun's existsSync ${existsSync(path)}.`,
        );
      }
    } finally {
      chmodSync(locked, 0o755);
    }

    // Identity digits, both ways on a link.
    const link = join(root, "three-link");
    for (const [follow, oracle] of [
      [true, statSync(link, { bigint: true })],
      [false, lstatSync(link, { bigint: true })],
    ]) {
      const inspection = await crossing(["files.inspect"], link, () =>
        inspectCheckoutPath(root, link, { follow }),
      );
      for (const field of ["dev", "ino", "size", "mtimeNs"])
        assert(
          inspection[field] === String(oracle[field]),
          `inspect(follow=${follow}).${field} is ${inspection[field]}, Bun's ${oracle[field]}.`,
        );
    }

    // Absence (an answered ENOENT) exactly where Bun's non-throwing stat
    // answers undefined; where it throws, the same code as a filesystem
    // failure. Bun throws ENOTDIR, which Node reads as absent (E2).
    /** What Bun's `statSync(path, {throwIfNoEntry:false})` answers. */
    const bunStat = (path) => {
      try {
        return statSync(path, { throwIfNoEntry: false, bigint: true })
          ? "stats"
          : "absent";
      } catch (error) {
        return `throws ${error.code}`;
      }
    };
    for (const path of [
      join(root, "missing"),
      join(root, "three", "child"),
      join(root, "three"),
    ]) {
      const error = await crossing(["files.inspect"], path, () =>
        inspectCheckoutPath(root, path, { follow: true }).then(
          () => undefined,
          (failure) => failure,
        ),
      );
      const answered =
        error === undefined
          ? "stats"
          : checkoutFailureOf(error) !== "filesystem"
            ? `not a filesystem failure: ${error}`
            : error.code === "ENOENT"
              ? "absent"
              : `throws ${error.code}`;
      assert(
        answered === bunStat(path),
        `inspect(${path}) answered ${answered}, Bun's statSync ${bunStat(path)}.`,
      );
    }
    // Base's identity stats `path` and `path/.git` and throws what they throw;
    // with no identity and no repository, the key is the path.
    clearRepoLockKeysForTests();
    for (const path of [join(root, "missing"), join(root, "three")]) {
      const base =
        [path, join(path, ".git")]
          .map(bunStat)
          .find((answer) => answer.startsWith("throws")) ?? path;
      const answered = await repoLockKey(path).then(
        (key) => key,
        (error) =>
          checkoutFailureOf(error) === "filesystem"
            ? `throws ${error.code}`
            : `not a filesystem failure: ${error}`,
      );
      assert(
        answered === base,
        `repoLockKey(${path}) answered ${answered}, Bun's base ${base}.`,
      );
    }

    // Dirent kinds: a directory link is not a directory.
    const listing = await crossing(["files.readdir"], "readdir", () =>
      readCheckoutDir(root, root),
    );
    const oracleListing = readdirSync(root, { withFileTypes: true }).map(
      (entry) => ({ name: entry.name, directory: entry.isDirectory() }),
    );
    assert(
      JSON.stringify(listing) === JSON.stringify(oracleListing),
      `readdir answered ${JSON.stringify(listing)}, Bun's ${JSON.stringify(oracleListing)}.`,
    );

    // The repo key for a main checkout and a linked worktree.
    const linked = join(outside, "linked");
    await git(["worktree", "add", "-q", linked], root);
    const common = realpathSync(join(root, ".git"));
    for (const cwd of [root, linked]) {
      clearRepoLockKeysForTests();
      const key = await crossing(
        ["files.inspect", "files.realpath"],
        `repoLockKey(${cwd})`,
        () => repoLockKey(cwd),
      );
      assert(key === common, `repoLockKey(${cwd}) is ${key}, not ${common}.`);
    }

    // Whole and capped reads equal both oracle readers.
    const sizes = {
      three: 3,
      empty: 0,
      "300k": 300 * 1024,
      "64m": 64 * 1024 * 1024,
    };
    for (const [name, size] of Object.entries(sizes)) {
      const path = join(root, name);
      if (!existsSync(path)) {
        const bytes = Buffer.alloc(size);
        for (let at = 0; at < size; at += 1) bytes[at] = (at * 151 + 7) & 0xff;
        writeFileSync(path, bytes);
      }
      const read = await crossing(
        ["files.open", "files.read", "files.close"],
        name,
        () => readCheckoutFile(root, path),
      );
      for (const oracle of [await readFile(path), readFileSync(path)])
        assert(
          read.length === oracle.length && sha256(read) === sha256(oracle),
          `A ${name} checkout read differs from Bun's readFile.`,
        );
    }
    const cap = 512 * 1024;
    const capped = await readCheckoutFile(root, join(root, "64m"), cap + 1);
    const prefix = readFileSync(join(root, "64m")).subarray(0, cap + 1);
    assert(
      capped.length === cap + 1 && sha256(capped) === sha256(prefix),
      "A capped checkout read is not the oracle's first cap + 1 bytes.",
    );

    // A directory: both oracles refuse EISDIR, the Worker answers it, the
    // file surface is empty and raw is not found.
    for (const oracle of [
      () => readFile(join(root, "dir")),
      async () => readFileSync(join(root, "dir")),
    ]) {
      const refused = await rejection(oracle());
      assert(
        refused.code === "EISDIR",
        `Bun read a directory as ${refused.code}.`,
      );
    }
    const answeredCode = async (run) => {
      let code;
      answerNextInProcessWorkerCallForTests(
        "files.read",
        async (payload, signal, real) => {
          const answer = await real(payload, signal);
          code = answer.json?.error?.code;
          return answer;
        },
      );
      const result = await run();
      return { result, code };
    };
    const directoryText = await answeredCode(() =>
      getWorktreeFileContent(row, "dir"),
    );
    assert(
      directoryText.code === "EISDIR" &&
        directoryText.result.content === "" &&
        !directoryText.result.binary,
      `A directory read answered ${directoryText.code} and ${JSON.stringify(directoryText.result.content)}.`,
    );
    const directoryRaw = await answeredCode(() =>
      rejection(getWorktreeFileRaw(row, "dir")),
    );
    assert(
      directoryRaw.code === "EISDIR" &&
        directoryRaw.result.message === "File not found.",
      `A directory raw read answered ${directoryRaw.code} and ${directoryRaw.result}.`,
    );

    // No descriptor stat: an armed stat fault stays armed.
    const unstatted = join(root, "three");
    failFileForTests(unstatted, { phase: "stat", code: "EIO" });
    const stats = fileReadsCountsForTests().descriptorStats;
    const whole = await readCheckoutFile(root, unstatted);
    assert(whole.toString() === "abc", "An unstatted read lost its bytes.");
    assert(
      fileFaultArmedForTests(unstatted) &&
        fileReadsCountsForTests().descriptorStats === stats,
      "A checkout read stat its descriptor.",
    );

    // Read until 0: bytes appended after the open are included.
    const growing = join(root, "growing");
    writeFileSync(growing, "abc");
    const held = holdFileForTests(growing, "after-open");
    const pending = readCheckoutFile(root, growing);
    await held.reached;
    appendFileSync(growing, "def");
    held.release();
    assert(
      (await pending).toString() === "abcdef",
      "A grown file was cut at its opening size.",
    );

    // E1 (2): a FIFO with a writer answers ESPIPE, mapped as a read failure.
    const fifo = join(root, "fifo");
    execFileSync("mkfifo", [fifo]);
    const writeOnceRead = async () => {
      await until(() => {
        try {
          const fd = openSync(
            fifo,
            fsConstants.O_WRONLY | fsConstants.O_NONBLOCK,
          );
          writeSync(fd, "x");
          closeSync(fd);
          return true;
        } catch (error) {
          if (error.code !== "ENXIO") throw error;
          return false;
        }
      }, "a reader on the FIFO");
    };
    for (const [surface, run, mapped] of [
      [
        "file",
        () => getWorktreeFileContent(row, "fifo"),
        (r) => r.content === "" && !r.binary,
      ],
      [
        "raw",
        () => rejection(getWorktreeFileRaw(row, "fifo")),
        (r) => r.message === "File not found.",
      ],
    ]) {
      const answered = answeredCode(run);
      await writeOnceRead();
      const { result, code } = await answered;
      assert(
        code === "ESPIPE" && mapped(result),
        `A FIFO ${surface} read answered ${code}.`,
      );
    }

    // A malformed answer and a coded refusal reject the surface, branded.
    answerNextInProcessWorkerCallForTests("files.open", async () => ({
      json: { opened: { handle: 0 } },
    }));
    const malformed = await rejection(getWorktreeFileContent(row, "three"));
    assert(
      isWorkerFailure(malformed),
      `A malformed open answered ${malformed}.`,
    );
    answerNextInProcessWorkerCallForTests("files.open", async () => {
      throw new WorkerMethodError("wrong_worker", "Not here.");
    });
    const refusedOpen = await rejection(getWorktreeFileContent(row, "three"));
    assert(
      isWorkerFailure(refusedOpen) && refusedOpen.code === "wrong_worker",
      `A refused open answered ${refusedOpen}.`,
    );

    // An escaping link is the server's verdict.
    const escaped = await crossing(["files.realpath"], "escape", () =>
      rejection(getWorktreeFileRaw(row, "escape")),
    );
    assert(
      escaped.message === "Invalid file path.",
      `An escaping link answered ${escaped}.`,
    );
    await git(["worktree", "remove", "--force", linked], root);
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** `IN_PROGRESS_MARKERS` (`workflow/operationTriage.ts`), every marker read. */
const OPERATION_MARKERS = [
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
];

/** What a sync `fs` call throws, as code and exact message; or `answers`. */
function syncFailure(call) {
  try {
    call();
    return "answers";
  } catch (error) {
    return `${error.code}: ${error.message}`;
  }
}

/** The same for a checkout read, which must fail as a filesystem failure. */
async function readFailure(what, methods, read) {
  const error = await crossing(methods, what, () =>
    read().then(
      () => undefined,
      (failure) => failure,
    ),
  );
  if (error === undefined) return "answers";
  assert(
    checkoutFailureOf(error) === "filesystem",
    `${what} failed outside the filesystem: ${error}`,
  );
  return `${error.code}: ${error.message}`;
}

/**
 * Base's untracked summaries (main 0fc22f5, `commitWorkflow.ts`), verbatim
 * over Bun's sync `fs`: the oracle for the commit agent's prompt.
 */
function baseUntrackedSummaries(repoRoot, files) {
  const MAX_UNTRACKED_FILE_CHARS = 12_000;
  const MAX_UNTRACKED_TOTAL_CHARS = 60_000;
  const errorText = (err) => (err instanceof Error ? err.message : String(err));
  const isProbablyText = (buffer) => {
    if (buffer.includes(0)) return false;
    try {
      new globalThis.TextDecoder("utf-8", { fatal: true }).decode(buffer);
      return true;
    } catch {
      return false;
    }
  };
  const summaries = [];
  let remaining = MAX_UNTRACKED_TOTAL_CHARS;
  for (const path of files.slice(0, 80)) {
    const absolute = join(repoRoot, path);
    try {
      if (lstatSync(absolute).isSymbolicLink()) {
        summaries.push({
          path,
          included: true,
          content: readlinkSync(absolute),
        });
        continue;
      }
      const buffer = readFileSync(absolute);
      if (buffer.length === 0) {
        summaries.push({ path, included: true, content: "" });
        continue;
      }
      if (buffer.length > 256_000) {
        summaries.push({
          path,
          included: false,
          reason: `large file (${buffer.length} bytes)`,
        });
        continue;
      }
      if (!isProbablyText(buffer.subarray(0, Math.min(buffer.length, 8192)))) {
        summaries.push({
          path,
          included: false,
          reason: `binary or non-UTF-8 file (${buffer.length} bytes)`,
        });
        continue;
      }
      const max = Math.min(MAX_UNTRACKED_FILE_CHARS, Math.max(0, remaining));
      const content = buffer.toString("utf8");
      const truncated = content.length > max;
      const shown = truncated
        ? `${content.slice(0, max)}\n[TRUNCATED ${content.length - max} characters]`
        : content;
      remaining -= shown.length;
      summaries.push({ path, included: true, content: shown });
    } catch (err) {
      summaries.push({
        path,
        included: false,
        reason: `could not read: ${errorText(err)}`,
      });
    }
  }
  if (files.length > 80) {
    summaries.push({
      path: `... ${files.length - 80} more untracked files`,
      included: false,
      reason: "not listed",
    });
  }
  if (summaries.length === 0) return "";
  return summaries
    .map((item) => {
      if (!item.included)
        return `Untracked file: ${item.path}\n[content omitted: ${item.reason ?? "not included"}]`;
      return [
        `Untracked file: ${item.path}`,
        "```",
        item.content ?? "",
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

/**
 * The checkout workflows' reads (commit, merge, sync, fetch, rebase repair,
 * triage) cross the in-process Worker and answer as base's synchronous `fs`
 * does under Bun on the same paths: an untracked path's kind and mode, a
 * link's text, a failure's code and message, every operation marker in a
 * main checkout and a linked worktree, and the commit agent's untracked
 * summaries end to end (`docs/workers.md`, "Checkout files"). A mismatch is
 * a contract question, never a value to adopt.
 */
async function checkWorkerWorkflowReads() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `bun-probe-workflow-${mode}-`)),
  );
  const at = (name) => join(root, name);
  try {
    await git(["init", "-q", "-b", "main"], root);
    writeFileSync(at("tracked"), "tracked\n");
    await git(["add", "tracked"], root);
    await git([...identity, "commit", "-q", "-m", "probe"], root);
    writeFileSync(at("plain"), "plain\n");
    chmodSync(at("plain"), 0o644);
    writeFileSync(at("run.sh"), "#!/bin/sh\n");
    chmodSync(at("run.sh"), 0o755);
    writeFileSync(at("empty"), "");
    mkdirSync(at("dir"));
    mkdirSync(at("nested"));
    await git(["init", "-q", "-b", "main"], at("nested"));
    writeFileSync(at("nested/inner"), "inner\n");
    symlinkSync("plain", at("link"));
    symlinkSync("missing-target", at("dangling"));
    symlinkSync("zielé-ü", at("non-ascii"));
    symlinkSync(Buffer.from([0x62, 0x61, 0x64, 0xff]), at("bad-utf8"));
    execFileSync("mkfifo", [at("fifo")]);

    // Kind and mode, from the one lstat, as Bun's lstatSync has them.
    const kindOf = (stats) =>
      stats.isFile()
        ? "file"
        : stats.isDirectory()
          ? "directory"
          : stats.isSymbolicLink()
            ? "symlink"
            : "other";
    for (const name of [
      "plain",
      "run.sh",
      "empty",
      "dir",
      "nested/",
      "link",
      "fifo",
    ]) {
      const path = at(name);
      const inspection = await crossing(["files.inspect"], name, () =>
        inspectCheckoutPath(root, path, { follow: false, mode: true }),
      );
      const oracle = lstatSync(path, { bigint: true });
      assert(
        inspection.kind === kindOf(oracle) &&
          inspection.mode === String(oracle.mode),
        `inspect(${name}) is ${inspection.kind} ${inspection.mode}, Bun's lstatSync ${kindOf(oracle)} ${oracle.mode}.`,
      );
    }

    // Link text, decoded as Bun's readlinkSync decodes it.
    for (const name of ["link", "dangling", "non-ascii", "bad-utf8"]) {
      const target = await crossing(["files.readlink"], name, () =>
        readCheckoutLink(root, at(name)),
      );
      assert(
        target === readlinkSync(at(name)),
        `readlink(${name}) is ${JSON.stringify(target)}, Bun's ${JSON.stringify(readlinkSync(at(name)))}.`,
      );
    }

    // Failures: the code and the exact message base's sync call throws.
    const failures = [
      [
        "readlink of a file",
        ["files.readlink"],
        "plain",
        readCheckoutLink,
        readlinkSync,
      ],
      [
        "readlink of a missing path",
        ["files.readlink"],
        "missing",
        readCheckoutLink,
        readlinkSync,
      ],
      [
        "lstat of a missing path",
        ["files.inspect"],
        "missing",
        (root, path) =>
          inspectCheckoutPath(root, path, { follow: false, mode: true }),
        lstatSync,
      ],
      [
        "lstat under a file",
        ["files.inspect"],
        "plain/child",
        (root, path) =>
          inspectCheckoutPath(root, path, { follow: false, mode: true }),
        lstatSync,
      ],
      [
        "read of nested/",
        ["files.open", "files.read"],
        "nested/",
        readCheckoutFile,
        readFileSync,
      ],
      [
        "read of a missing path",
        ["files.open"],
        "missing",
        readCheckoutFile,
        readFileSync,
      ],
    ];
    for (const [what, methods, name, read, oracle] of failures) {
      const answered = await readFailure(what, methods, () =>
        read(root, at(name)),
      );
      const base = syncFailure(() => oracle(at(name)));
      assert(
        base !== "answers" && answered === base,
        `${what} answered ${answered}, Bun's sync call ${base}.`,
      );
    }

    // Every marker, absent and present, in a main checkout and a linked one.
    const linked = `${root}-linked`;
    await git(["worktree", "add", "-q", "-b", "linked", linked], root);
    try {
      for (const cwd of [root, linked]) {
        const gitDir = (
          await git(["rev-parse", "--absolute-git-dir"], cwd)
        ).stdout.trim();
        for (const marker of OPERATION_MARKERS) {
          const path = join(gitDir, marker);
          for (const present of [false, true]) {
            if (present && marker.startsWith("rebase-")) mkdirSync(path);
            else if (present) writeFileSync(path, "");
            const answer = await crossing(["files.exists"], path, () =>
              checkoutPathExists(cwd, path),
            );
            assert(
              answer === existsSync(path) && answer === present,
              `exists(${path}) answered ${answer}, Bun's existsSync ${existsSync(path)}.`,
            );
          }
          rmSync(path, { recursive: true, force: true });
        }
      }
    } finally {
      await git(["worktree", "remove", "--force", linked], root);
    }

    // The commit agent's untracked summaries, end to end.
    rmSync(at("fifo"));
    rmSync(at("dir"), { recursive: true });
    writeFileSync(at("binary"), Buffer.from([0x61, 0x00, 0x62]));
    writeFileSync(at("large"), "x".repeat(256_001));
    let prompt;
    setCommitMessageGeneratorForTests(async (text) => {
      prompt = text;
      return {
        status: "commit",
        subject: "Probe",
        body: [],
        blockers: [],
        warnings: [],
      };
    });
    let result;
    try {
      result = await crossing(
        [
          "files.inspect",
          "files.readlink",
          "files.open",
          "files.read",
          "files.close",
          "files.exists",
        ],
        "a commit dry run",
        () => runCommitWorkflow({ source: "tool", cwd: root, dryRun: true }),
      );
    } finally {
      setCommitMessageGeneratorForTests(null);
    }
    assert(
      result.status === "dry-run",
      `The commit dry run ended ${result.status}: ${result.error}`,
    );
    const untracked = (
      await git(["ls-files", "--others", "--exclude-standard", "-z"], root)
    ).stdout
      .split("\0")
      .filter(Boolean);
    assert(untracked.includes("nested/"), `ls-files listed ${untracked}.`);
    const expected = baseUntrackedSummaries(root, untracked);
    assert(
      typeof prompt === "string" && prompt.includes(expected),
      `The commit agent's untracked summaries differ from Bun's base:\n${expected}\n--- prompt ---\n${prompt}`,
    );
    assert(
      inProcessWorkerFileHandlesForTests() === 0,
      "The commit dry run left a Worker file handle open.",
    );
    console.log(
      `Worker workflow reads (${mode}): kinds, modes, link texts, failures, ${OPERATION_MARKERS.length} markers in two checkouts and ${untracked.length} untracked summaries match Bun's fs.`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** What is at `path`, depth first: relative path, kind, mode, text or bytes. */
function treeSnapshot(path) {
  const entries = [];
  const visit = (at, relative) => {
    let stat;
    try {
      stat = lstatSync(at);
    } catch (error) {
      entries.push(`${relative} ${error.code}`);
      return;
    }
    const mode = (stat.mode & 0o7777).toString(8);
    if (stat.isSymbolicLink()) {
      entries.push(`${relative} link ${readlinkSync(at)}`);
    } else if (stat.isFile()) {
      let content;
      try {
        content = readFileSync(at, "utf8");
      } catch (error) {
        content = error.code;
      }
      entries.push(`${relative} file ${mode} ${content}`);
    } else if (stat.isDirectory()) {
      entries.push(`${relative} dir ${mode}`);
      let names;
      try {
        names = readdirSync(at).sort();
      } catch (error) {
        entries.push(`${relative} unlistable ${error.code}`);
        return;
      }
      for (const name of names)
        visit(join(at, name), relative === "." ? name : `${relative}/${name}`);
    } else entries.push(`${relative} other ${mode}`);
  };
  visit(path, ".");
  return entries;
}

/**
 * A lifecycle fixture under `root`: `tree/` and an `outside/` target that a
 * link in the tree points at. `locked` adds a 0o500 and a 0o000 directory, each
 * holding a file; `missing` has no tree at all.
 */
function lifecycleFixture(root, shape) {
  const tree = join(root, "tree");
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret"), "OUTSIDE");
  chmodSync(join(outside, "secret"), 0o640);
  chmodSync(outside, 0o750);
  if (shape === "missing") return tree;
  mkdirSync(join(tree, "sub"), { recursive: true });
  writeFileSync(join(tree, "file"), "file");
  writeFileSync(join(tree, "sub", "file"), "nested");
  symlinkSync(outside, join(tree, "outside-link"));
  if (shape === "locked")
    for (const [name, mode] of [
      ["read-only", 0o500],
      ["no-access", 0o000],
    ]) {
      mkdirSync(join(tree, name));
      writeFileSync(join(tree, name, "file"), name);
      chmodSync(join(tree, name), mode);
    }
  return tree;
}

/** `/proc/<pid>/stat`'s ppid, or undefined once gone. */
function parentPid(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return undefined;
  }
}

const running = (pid) => !["gone", "Z"].includes(procState(pid));

/** `/proc/<pid>/stat`'s start time, which tells a reused pid from its first owner. */
function startTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/** `/proc/<pid>/comm`, or undefined once gone. */
function commOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * What `ownedProcessTree` needs of the host, so a model can stand in for it.
 * `stat` takes state, parent, group, session and start time from a single
 * read of `/proc/<pid>/stat`, so they all describe one process.
 */
const liveProcessHost = {
  spawn,
  kill: (pid, signal) => process.kill(pid, signal),
  pids: () =>
    readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map(Number),
  stat: (pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return {
        state: fields[0],
        parent: Number(fields[1]),
        group: Number(fields[2]),
        session: Number(fields[3]),
        start: fields[19],
      };
    } catch {
      return undefined;
    }
  },
  // The witness's reads; each throws the failure with its code.
  readText: (path) => readFileSync(path, "utf8"),
  list: (path) => readdirSync(path),
  link: (path) => readlinkSync(path),
};

/** Per-process `/proc` failures that mean the process, task or descriptor is gone. */
const VANISHED = new Set(["ENOENT", "ESRCH"]);
/** Refused observations: never "empty", whoever the process belongs to. */
const DENIED = new Set(["EACCES", "EPERM"]);
const PF_KTHREAD = 0x00200000n;
const codeOf = (error) =>
  typeof error?.code === "string" ? error.code : "UNCLASSIFIED";

/** `/proc/<pid>/stat`'s state, flags, thread count and start, or undefined when it does not parse. */
function parseStat(text) {
  const fields = text
    .slice(text.lastIndexOf(")") + 2)
    .trim()
    .split(" ");
  const [state, flags, threads, start] = [0, 6, 17, 19].map((i) => fields[i]);
  if (!/^[A-Za-z]$/.test(state ?? "")) return undefined;
  if (![flags, threads, start].every((field) => /^\d+$/.test(field ?? "")))
    return undefined;
  return {
    state,
    flags: BigInt(flags),
    threads: Number(threads),
    start: BigInt(start),
  };
}

/**
 * One read-only scan for holders of the gate sockets `inodes`: "empty" only
 * when no process holds one, nothing observed is unknown, `/proc` is this
 * process's unhidden view at both ends, and no task was created meanwhile
 * (the global fork counter is unchanged), so every process alive at the end
 * was listed and read. A process can count as not holding only by being gone
 * (ENOENT/ESRCH), started before the tree's leader, a kernel thread, or read
 * without a gate socket; any other failure, a refused read included, is
 * unknown. Its pids are for diagnosis only: nothing is signalled or released
 * on them.
 */
function gateHolders(host, inodes, leaderStart) {
  const want = new Set(inodes.map((inode) => `socket:[${inode}]`));
  const scan = { kind: "unknown", holders: [], unknown: [], reason: undefined };
  const fail = (reason) => Object.assign(scan, { kind: "unknown", reason });
  /** The reason `/proc` is not this process's whole view, if it is not. */
  const view = () => {
    try {
      if (host.link("/proc/self") !== String(process.pid))
        return "/proc/self is not this process";
      const mounts = host
        .readText("/proc/self/mountinfo")
        .split("\n")
        .map((line) => line.split(" - "))
        .filter(
          ([mount, fs]) =>
            mount?.split(" ")[4] === "/proc" && fs?.split(" ")[0] === "proc",
        );
      if (mounts.length === 0) return "no proc mount at /proc";
      for (const [, fs] of mounts) {
        const hidepid = /(?:^|,)hidepid=([^,\s]+)/.exec(fs.split(" ")[2])?.[1];
        if (hidepid !== undefined && hidepid !== "0" && hidepid !== "off")
          return `/proc is mounted with hidepid=${hidepid}`;
      }
      return undefined;
    } catch (error) {
      return `the /proc view could not be read (${codeOf(error)})`;
    }
  };
  const forks = () => {
    const count = /^processes (\d+)$/m.exec(host.readText("/proc/stat"))?.[1];
    if (count === undefined)
      throw Object.assign(new Error("unparsed"), { code: "UNPARSED" });
    return count;
  };
  /** "held", "gone", "clear", "excluded", or the unknown observation. */
  const classify = (pid) => {
    const unknown = (path, code) => ({ pid, path, code });
    let stat;
    try {
      stat = parseStat(host.readText(`/proc/${pid}/stat`));
    } catch (error) {
      const code = codeOf(error);
      return VANISHED.has(code) ? "gone" : unknown(`${pid}/stat`, code);
    }
    if (!stat) return unknown(`${pid}/stat`, "UNPARSED");
    if (stat.flags & PF_KTHREAD || stat.start < leaderStart) return "excluded";
    // A task in state Z or X has dropped its descriptors; any other task's
    // table is read, each task's own once the process has more than one.
    let tables = [{ dir: `/proc/${pid}/fd`, state: stat.state }];
    if (stat.threads > 1) {
      let tids;
      try {
        tids = host.list(`/proc/${pid}/task`);
      } catch (error) {
        const code = codeOf(error);
        return VANISHED.has(code) ? "gone" : unknown(`${pid}/task`, code);
      }
      tables = [];
      for (const tid of tids) {
        let task;
        try {
          task = parseStat(host.readText(`/proc/${pid}/task/${tid}/stat`));
        } catch (error) {
          const code = codeOf(error);
          if (VANISHED.has(code)) continue;
          return unknown(`${pid}/task/${tid}/stat`, code);
        }
        if (!task) return unknown(`${pid}/task/${tid}/stat`, "UNPARSED");
        tables.push({ dir: `/proc/${pid}/task/${tid}/fd`, state: task.state });
      }
    }
    let denied;
    for (const { dir, state } of tables) {
      if (state === "Z" || state === "X") continue;
      let fds;
      try {
        fds = host.list(dir);
      } catch (error) {
        const code = codeOf(error);
        if (VANISHED.has(code)) continue;
        if (!DENIED.has(code)) return unknown(dir.slice(6), code);
        denied ??= unknown(dir.slice(6), code);
        continue;
      }
      for (const fd of fds) {
        let target;
        try {
          target = host.link(`${dir}/${fd}`);
        } catch (error) {
          const code = codeOf(error);
          if (VANISHED.has(code)) continue;
          if (!DENIED.has(code)) return unknown(`${dir.slice(6)}/${fd}`, code);
          denied ??= unknown(`${dir.slice(6)}/${fd}`, code);
          continue;
        }
        if (want.has(target)) return "held";
      }
    }
    return denied ?? "clear";
  };

  const before = view();
  if (before) return fail(before);
  let first, names;
  try {
    first = forks();
    names = host.list("/proc");
  } catch (error) {
    return fail(`/proc could not be listed (${codeOf(error)})`);
  }
  if (!names.includes(String(process.pid)))
    return fail("/proc does not list this process");
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const found = classify(Number(name));
    if (found === "held") scan.holders.push(Number(name));
    else if (typeof found === "object") scan.unknown.push(found);
  }
  let last;
  try {
    last = forks();
  } catch (error) {
    return fail(`/proc/stat could not be read (${codeOf(error)})`);
  }
  const after = view();
  if (after) return fail(after);
  if (last !== first) return fail("tasks were created during the scan");
  scan.kind =
    scan.holders.length > 0
      ? "held"
      : scan.unknown.length > 0
        ? "unknown"
        : "empty";
  return scan;
}

/** The running children of `parent`, by `/proc` ppid. */
function childrenOf(parent) {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => parentPid(pid) === parent && running(pid));
}

/**
 * The O5 process tree: the probe's direct child `sh`, in `cwd`, starts each
 * of `children` in the background and then blocks reading its stdin. Detached,
 * the direct child leads a session and process group of its own, which its
 * children inherit (no job control). Detaching changes no parentage, and the
 * Worker's stop selects by ancestry and cwd, not by group.
 *
 * Nothing runs before it is owned. The direct child forks nothing until it
 * reads `start`, which is written only once it is proven to be the probe's
 * own child and the inodes of its gate sockets (fds 3 on, one per child) are
 * read. Child i gets gate i as its fd 3 and holds it, through `read go <&3 &&
 * exec`, for as long as it runs; it starts its work only on `go`, which
 * `acquire` writes once child i's pid file names a member it has claimed.
 *
 * `acquire` records the group's members only while the direct child provably
 * still holds its number: it is seen, with the start time it had when spawned,
 * after the members were read. `observe` only narrows the members read, for
 * tests. Tests acquire in their readiness polls, before any child is ready.
 *
 * `stop` closes the gates, so ungated children end on EOF, and the direct
 * child's stdin, so that, if it still runs, it SIGKILLs its own group (`kill
 * 0`): no group number is ever signalled from here. The probe itself signals
 * only claimed members, by pid and start time, for when the direct child died
 * first. The tree has ended once `gateHolders` reads it empty and no claimed
 * member runs; that scan only observes. Every stdio stream must then have
 * closed, so its errors are in; any failure rejects the stop with all of them.
 */
function ownedProcessTree(
  cwd,
  children,
  args,
  host = liveProcessHost,
  { completionMs = 5000 } = {},
) {
  const gates = children.map((_, i) => 3 + i);
  const direct = host.spawn(
    "sh",
    [
      "-c",
      [
        "read _ || exit",
        ...children.map(
          ({ script }, i) =>
            `${script} 3<&${3 + i} ${gates
              .filter((fd) => fd !== 3)
              .map((fd) => `${fd}<&-`)
              .join(" ")} &`,
        ),
        "read _",
        "kill -KILL 0",
      ].join("\n"),
      "sh",
      ...args,
    ],
    {
      cwd,
      stdio: ["pipe", "ignore", "ignore", ...gates.map(() => "pipe")],
      detached: true,
    },
  );
  const errors = [];
  const streams = [...(direct.stdio ?? [])].filter(Boolean);
  const unclosed = new Set(streams);
  const closed = streams.map(
    (stream) =>
      new Promise((resolve) => {
        stream.on("error", (error) => errors.push(error));
        stream.once("close", () => {
          unclosed.delete(stream);
          resolve();
        });
      }),
  );
  const exited = new Promise((resolve) => {
    direct.once("exit", resolve);
    direct.once("error", resolve);
  });
  /** The start time of `pid` while it runs. */
  const startOf = (pid) => {
    const stat = host.stat(pid);
    return stat && stat.state !== "Z" ? stat.start : undefined;
  };
  // Read in the step that spawned it, before it could have been reaped.
  const leaderStart =
    direct.pid === undefined ? undefined : host.stat(direct.pid)?.start;
  /** Whether the direct child, live or a zombie, still holds its pid and so its group's number. */
  const leads = () => {
    if (
      direct.pid === undefined ||
      direct.exitCode !== null ||
      direct.signalCode !== null
    )
      return false;
    const stat = host.stat(direct.pid);
    return (
      stat?.start === leaderStart &&
      stat.parent === process.pid &&
      stat.session === direct.pid
    );
  };
  // Node and Bun make each "pipe" stdio a Unix socketpair, so the direct
  // child's end reads as `socket:[inode]`; anything else leaves it unproven.
  const inodes = gates.map((fd) => {
    try {
      return /^socket:\[(\d+)\]$/.exec(
        host.link(`/proc/${direct.pid}/fd/${fd}`),
      )?.[1];
    } catch {
      return undefined;
    }
  });
  // Read after the inodes, so they are the direct child's.
  const proven =
    leaderStart !== undefined &&
    /^\d+$/.test(leaderStart) &&
    inodes.every(Boolean) &&
    leads();
  if (proven)
    try {
      direct.stdin.write("start\n");
    } catch (error) {
      errors.push(error);
    }
  // Unproven, the direct child was never sent `start`, so it forked nothing
  // and no process can hold a gate: there is no tree to scan for.
  const witness = () =>
    proven
      ? gateHolders(host, inodes, BigInt(leaderStart))
      : { kind: "empty", holders: [], unknown: [] };
  let phase = "running";
  /** Each member ever claimed, by pid: its start time. */
  const claimed = new Map();
  /** The children sent `go`. */
  const released = new Set();
  /** Claim the group's running members and release the children they are; false, doing nothing, once its number may not be the tree's or the tree is stopping. */
  const acquire = ({ observe = () => true } = {}) => {
    if (phase !== "running" || !proven) return false;
    const members = [];
    for (const pid of host.pids()) {
      if (!observe(pid)) continue;
      const stat = host.stat(pid);
      if (stat?.group === direct.pid && stat.state !== "Z")
        members.push([pid, stat.start]);
    }
    if (!leads()) return false;
    for (const [pid, start] of members) claimed.set(pid, start);
    children.forEach(({ pidFile }, i) => {
      if (released.has(i) || pidFile === undefined) return;
      let pid;
      try {
        pid = Number(host.readText(pidFile));
      } catch {
        return;
      }
      const start = claimed.get(pid);
      if (start === undefined || startOf(pid) !== start) return;
      if (phase !== "running") return;
      released.add(i);
      try {
        direct.stdio[3 + i].end("go\n");
      } catch (error) {
        errors.push(error);
      }
    });
    return true;
  };
  const end = async () => {
    for (const stream of streams)
      try {
        stream.destroy();
      } catch (error) {
        errors.push(error);
      }
    if (direct.pid !== undefined) {
      await exited;
      for (const [pid, start] of claimed)
        if (startOf(pid) === start)
          try {
            host.kill(pid, "SIGKILL");
          } catch (error) {
            if (error?.code !== "ESRCH") errors.push(error);
          }
      let last;
      try {
        await until(
          () => {
            last = witness();
            return (
              last.kind === "empty" &&
              [...claimed].every(([pid, start]) => startOf(pid) !== start)
            );
          },
          "the probe's process tree to end",
          completionMs,
        );
      } catch {
        errors.push(
          new Error(
            `The process tree's end could not be observed: ${JSON.stringify({
              kind: last?.kind,
              reason: last?.reason,
              holders: last?.holders,
              unknown: last?.unknown,
              claimed: [...claimed]
                .filter(([pid, start]) => startOf(pid) === start)
                .map(([pid]) => pid),
            })}.`,
            { cause: last },
          ),
        );
      }
    }
    // A stream's errors all come before its `close`; `closed` flags do not
    // wait for them.
    let timer;
    await Promise.race([
      Promise.all(closed),
      new Promise(
        (resolve) => (timer = globalThis.setTimeout(resolve, completionMs)),
      ),
    ]);
    globalThis.clearTimeout(timer);
    if (unclosed.size > 0)
      errors.push(
        new Error(
          `The process tree's stdio ${streams
            .flatMap((stream, i) => (unclosed.has(stream) ? [i] : []))
            .join(", ")} did not close.`,
        ),
      );
    if (errors.length > 0)
      throw new AggregateError(errors, "Stopping the process tree failed.");
  };
  let stopping;
  return {
    direct,
    acquire,
    leads,
    /** The tree's scan, read-only, for tests. */
    witness,
    /** A copy of the claimed members, for tests. */
    claimed: () => new Map(claimed),
    /**
     * End the tree as above; the first call stops acquiring and releasing,
     * and every call shares the one run.
     */
    stop: () => {
      if (phase === "running") {
        phase = "stopping";
        stopping = end();
      }
      return stopping;
    },
  };
}

/**
 * Reads each pid file anew on every call, so a later child's pid is known
 * whatever an earlier one did; `ready()` holds once every file names a
 * process that has exec'd `sleep`.
 */
function pidFileReadiness(pidFiles) {
  const pids = {};
  const ready = () => {
    for (const [name, file] of Object.entries(pidFiles)) {
      let pid;
      try {
        pid = Number(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      if (pid > 0) pids[name] = pid;
    }
    return Object.keys(pidFiles).every(
      (name) => pids[name] !== undefined && commOf(pids[name]) === "sleep\n",
    );
  };
  return { pids, ready };
}

/** O5's three children, gated: a sleeper and a TERM-ignoring one in `tree`, one in `outside` (`$1`). */
const o5Children = (tree, outside) => [
  {
    script: `sh -c 'echo $$ > sleeper.pid; read go <&3 && exec sleep 600'`,
    pidFile: join(tree, "sleeper.pid"),
  },
  {
    script: `sh -c 'trap "" TERM; echo $$ > ignorer.pid; read go <&3 && exec sleep 600'`,
    pidFile: join(tree, "ignorer.pid"),
  },
  {
    script: `sh -c 'cd "$1"; echo $$ > outside.pid; read go <&3 && exec sleep 600' sh "$1"`,
    pidFile: join(outside, "outside.pid"),
  },
];

/**
 * O5's cleanup when the tree never becomes ready, or loses its direct child.
 * The first child's exec fails after `go`, it exits before writing a pid file,
 * or it never writes one and stays gated, while its later siblings run, so the
 * tree is not ready and its stop must still end every process in it. The
 * direct child is SIGKILLed once all three run and are claimed, before any
 * was claimed, or once only the first was (the others unobserved), and the
 * stop must still end its children while signalling only claimed ones. One
 * child runs an execute-only copy of `sleep`, so its descriptors cannot be
 * read: its stop must not end until it does. The probe watches every process
 * of the tree itself and, should the stop leak one, SIGKILLs it by pid and
 * start time before failing.
 */
async function checkProcessTreeCleanup(base) {
  const firsts = {
    "exec failed": (tree) => ({
      script: `sh -c 'echo $$ > sleeper.pid; read go <&3 && exec ./no-such-sleep 600'`,
      pidFile: join(tree, "sleeper.pid"),
    }),
    "no pid file": (tree) => ({
      script: `sh -c 'exit 3'`,
      pidFile: join(tree, "sleeper.pid"),
    }),
    "never ready": () => ({ script: `sh -c 'read go <&3 && exec sleep 600'` }),
    unreadable: (tree) => ({
      script: `sh -c 'echo $$ > sleeper.pid; read go <&3 && exec ./sleep 600'`,
      pidFile: join(tree, "sleeper.pid"),
    }),
  };
  for (const variant of [
    "exec failed",
    "no pid file",
    "never ready",
    "leader gone",
    "leader gone unclaimed",
    "leader gone partly claimed",
    "unreadable",
  ]) {
    const fixture = join(base, `O5-cleanup-${variant.replaceAll(" ", "-")}`);
    const tree = lifecycleFixture(fixture, "plain");
    const outside = join(fixture, "outside");
    const children = o5Children(tree, outside);
    if (firsts[variant]) children[0] = firsts[variant](tree);
    if (variant === "unreadable") {
      const sleep = process.env.PATH.split(":")
        .map((dir) => join(dir, "sleep"))
        .find((path) => existsSync(path));
      copyFileSync(realpathSync(sleep), join(tree, "sleep"));
      chmodSync(join(tree, "sleep"), 0o111);
    }
    // Records every signal the tree sends; one to a held pid waits until
    // the test delivers it, to the same pid and start time.
    const sent = [];
    const held = new Set();
    const queued = [];
    const host = {
      ...liveProcessHost,
      kill: (pid, signal) => {
        sent.push(pid);
        if (held.has(pid)) queued.push([pid, signal]);
        else liveProcessHost.kill(pid, signal);
      },
    };
    const owned = ownedProcessTree(tree, children, [outside], host);
    const watched = new Map();
    const watch = (pid) => {
      const start = startTime(pid);
      if (start !== undefined && !watched.has(pid)) watched.set(pid, start);
    };
    const deliver = () => {
      for (const [pid, signal] of queued.splice(0))
        if (running(pid) && startTime(pid) === watched.get(pid))
          process.kill(pid, signal);
    };
    const pidOf = (i) => {
      try {
        return Number(readFileSync(children[i].pidFile, "utf8")) || undefined;
      } catch {
        return undefined;
      }
    };
    const unreadable = (pid) => {
      try {
        readdirSync(`/proc/${pid}/fd`);
        return false;
      } catch (error) {
        return error.code === "EACCES";
      }
    };
    const sorted = (pids) => [...pids].sort((x, y) => x - y).join();
    try {
      watch(owned.direct.pid);
      const loseLeader = async () => {
        const gone = new Promise((resolve) =>
          owned.direct.once("exit", resolve),
        );
        assert(owned.leads(), "The direct child no longer leads its group.");
        process.kill(owned.direct.pid, "SIGKILL");
        await gone;
      };
      if (
        variant === "leader gone unclaimed" ||
        variant === "leader gone partly claimed"
      ) {
        // All three wait at their gates, none claimed or released.
        await until(() => {
          const scan = owned.witness();
          scan.holders.forEach(watch);
          return [0, 1, 2].every(pidOf) && scan.holders.length === 4;
        }, `the ${variant} tree's gated children`);
        const [first, second, third] = [0, 1, 2].map(pidOf);
        if (variant === "leader gone partly claimed") {
          assert(
            owned.acquire({
              observe: (pid) => pid !== second && pid !== third,
            }),
            "The tree could not be acquired.",
          );
          await until(
            () => commOf(first) === "sleep\n",
            "the claimed child's sleep",
          );
          const claimed = owned.claimed();
          assert(
            claimed.has(first) && !claimed.has(second) && !claimed.has(third),
            `The unobserved children were claimed: ${[...claimed.keys()]}.`,
          );
        }
        await loseLeader();
        assert(
          !owned.acquire() &&
            [first, second, third].every(running) &&
            [second, third].every((pid) => commOf(pid) === "sh\n"),
          "The direct child's end took its children, released one, or left its group claimable.",
        );
        await owned.stop();
        assert(
          sorted(sent) ===
            sorted(variant === "leader gone unclaimed" ? [] : [first]),
          `The ${variant} tree's stop signalled ${sent}.`,
        );
      } else if (variant === "unreadable") {
        await until(() => {
          owned.acquire();
          return (
            unreadable(pidOf(0)) &&
            [1, 2].every((i) => commOf(pidOf(i)) === "sleep\n")
          );
        }, "the tree's unreadable sleeper");
        const pids = [0, 1, 2].map(pidOf);
        pids.forEach(watch);
        // One the host's other forks do not overlap.
        let scan;
        await until(
          () => (scan = owned.witness()).reason === undefined,
          "a scan of the unreadable tree",
        );
        assert(
          scan.kind !== "empty" &&
            !scan.holders.includes(pids[0]) &&
            scan.unknown.some(
              ({ pid, code }) => pid === pids[0] && code === "EACCES",
            ) &&
            sorted(scan.holders) ===
              sorted([owned.direct.pid, ...pids.slice(1)]),
          `The unreadable sleeper was read as ${JSON.stringify(scan)}.`,
        );
        await loseLeader();
        held.add(pids[0]);
        let settled = false;
        const stop = owned.stop().finally(() => (settled = true));
        await until(() => {
          const left = owned.witness();
          return (
            sorted(sent) === sorted(pids) &&
            left.holders.length === 0 &&
            left.unknown.map(({ pid }) => pid).join() === String(pids[0])
          );
        }, "the unreadable sleeper to be all that is left");
        assert(!settled, "The stop ended while an unreadable sleeper ran.");
        deliver();
        await stop;
        assert(
          sorted(sent) === sorted(pids),
          `The unreadable tree's stop signalled ${sent}.`,
        );
      } else {
        // Settled: exactly the expected sleepers run as the direct child's
        // children, each exec'd into `sleep`, and are claimed; a gated child
        // that never wrote a pid file holds its gate.
        const sleepers = variant === "leader gone" ? [0, 1, 2] : [1, 2];
        const gated = variant === "never ready" ? 1 : 0;
        let settled;
        await until(() => {
          const acquired = owned.acquire();
          const scan = owned.witness();
          scan.holders.forEach(watch);
          const live = childrenOf(owned.direct.pid);
          settled = scan.holders;
          return (
            acquired &&
            live.length === sleepers.length + gated &&
            sleepers.every((i) => live.includes(pidOf(i))) &&
            sleepers.every((i) => commOf(pidOf(i)) === "sleep\n") &&
            scan.holders.length === 1 + sleepers.length + gated
          );
        }, `the ${variant} tree's sleepers`);
        sleepers.forEach((i) => watch(pidOf(i)));
        // The settled tree's: a failed exec's child may have exited since.
        assert(
          settled.every((pid) => processGroup(pid) === owned.direct.pid),
          `The ${variant} tree does not run in its direct child's own group.`,
        );
        if (variant === "leader gone") {
          await loseLeader();
          assert(
            sleepers.every((i) => running(pidOf(i))) && !owned.acquire(),
            "The direct child's end took its children, or left its group claimable.",
          );
        }
        await owned.stop();
        // Without the direct child's own `kill 0`, exactly its sleepers;
        // after it, at most a claimed member that has not yet died of it.
        const claimed = owned.claimed();
        assert(
          variant === "leader gone"
            ? sorted(sent) === sorted(sleepers.map(pidOf))
            : sent.every((pid) => claimed.has(pid) && pid !== owned.direct.pid),
          `The ${variant} tree's stop signalled ${sent}.`,
        );
      }
      const leaked = [...watched.keys()].filter(running);
      assert(
        leaked.length === 0,
        `Stopping the ${variant} tree left ${leaked} running.`,
      );
      // A scan the host's other forks overlap is unknown, not a holder.
      await until(() => {
        const left = owned.witness();
        assert(
          left.kind !== "held",
          `Stopping the ${variant} tree left gate holders: ${JSON.stringify(left)}.`,
        );
        return left.kind === "empty";
      }, `the ${variant} tree's gates to be unheld`);
    } finally {
      deliver();
      for (const [pid, start] of watched)
        if (running(pid) && startTime(pid) === start)
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Gone since.
          }
      await owned.stop();
    }
  }
}

/**
 * A model of what `ownedProcessTree` needs of the host: a process table with
 * each process's descriptors, the `/proc` reads its scan makes, the signals
 * the probe sends, and a direct child (pid 100, leading group and session
 * 100, start 10) whose reaping the caller drives. Its stdin and gates are
 * fake streams: `start` forks one child per gate (pids 101 on, starts 11 on),
 * each holding its gate's socket (inodes 9001 on); `go` releases a child;
 * closing its gate ends a child not released (on `eof()` when `deferEof`);
 * closing the stdin ends the group, as `kill 0` would, while the direct child
 * still runs. A signal to a `held` pid is recorded and not delivered. No real
 * process is started or signalled.
 */
function modelProcessHost({
  gates = 2,
  leaderKills = true,
  refused = [],
  held = [],
  deferEof = false,
} = {}) {
  const failure = (code) => Object.assign(new Error(code), { code });
  const member = (start, { parent = 100, group = 100, fds = [] } = {}) => ({
    state: "S",
    parent,
    group,
    session: group,
    start,
    flags: 0,
    fds,
    deny: {},
  });
  const inodes = Array.from({ length: gates }, (_, i) => 9001 + i);
  const table = new Map([
    [100, member("10", { parent: process.pid, fds: inodes })],
  ]);
  const model = {
    table,
    member,
    inodes,
    signals: [],
    groupKills: [],
    files: new Map(),
    reads: [],
    released: new Set(),
    pendingEof: [],
    forks: 0,
    scans: 0,
    self: String(process.pid),
    listSelf: true,
    mountinfo: "22 1 0:5 / /proc rw,nosuid - proc proc rw\n",
    onRead: undefined,
    spawnFailure: undefined,
    /** Apply the gate closes held by `deferEof`. */
    eof: () => model.pendingEof.splice(0).forEach((pid) => table.delete(pid)),
  };
  let started = false;
  const stream = (effects) => {
    const fake = Object.assign(new EventEmitter(), {
      closes: 0,
      write: (text) => (effects.write?.(text), true),
      end: (text) => effects.write?.(text),
      destroy: () => {
        fake.closes++;
        if (fake.throwOnDestroy) throw fake.throwOnDestroy;
        if (fake.closes > 1) return;
        effects.close?.();
        const emit = () => {
          if (fake.error) fake.emit("error", fake.error);
          fake.emit("close");
        };
        if (fake.holdClose) fake.release = emit;
        else globalThis.queueMicrotask(emit);
      },
    });
    return fake;
  };
  const stdin = stream({
    write: (text) => {
      if (text !== "start\n" || started || table.get(100)?.state !== "S")
        return;
      started = true;
      inodes.forEach((inode, i) => {
        model.forks++;
        table.set(101 + i, member(String(11 + i), { fds: [inode] }));
      });
    },
    close: () => {
      if (direct.signalCode !== null || table.get(100)?.state !== "S") return;
      if (leaderKills && started) {
        model.groupKills.push(100);
        for (const [pid, stat] of table)
          if (stat.group === 100 && pid !== 100) table.delete(pid);
      }
      table.get(100).state = "Z";
    },
  });
  const gateStreams = inodes.map((_, i) =>
    stream({
      write: (text) => text === "go\n" && model.released.add(i),
      close: () => {
        const child = table.get(101 + i);
        if (model.released.has(i) || child?.start !== String(11 + i)) return;
        if (deferEof) model.pendingEof.push(101 + i);
        else table.delete(101 + i);
      },
    }),
  );
  const direct = Object.assign(new EventEmitter(), {
    pid: 100,
    exitCode: null,
    signalCode: null,
    stdin,
    stdio: [stdin, null, null, ...gateStreams],
  });
  const entry = (pid, tid) => {
    const entryOf = table.get(Number(pid));
    if (!entryOf) throw failure("ENOENT");
    if (tid === undefined) return entryOf;
    const task = (entryOf.tasks ?? [{ tid: Number(pid), ...entryOf }]).find(
      (task) => task.tid === Number(tid),
    );
    if (!task) throw failure("ENOENT");
    return { ...entryOf, tasks: undefined, ...task };
  };
  const denied = (entryOf, read) => {
    if (entryOf.deny[read]) throw failure(entryOf.deny[read]);
  };
  const fdList = (task) => {
    if (task.state === "Z") throw failure("EACCES");
    return task.fds.map((_, n) => String(3 + n));
  };
  const statText = (pid, task) =>
    task.raw ??
    `${pid} (m) ${task.state} ${task.parent} ${task.group} ${task.session} 0 -1 ${task.flags} 0 0 0 0 0 0 0 0 20 0 ${task.tasks?.length ?? 1} 0 ${task.start} 0`;
  const read = (path) => {
    model.reads.push(path);
    model.onRead?.(path);
  };
  return Object.assign(model, {
    direct,
    gates: gateStreams,
    /** Reap the direct child, as Node would once it ended. */
    reap(signalCode = "SIGKILL") {
      table.delete(100);
      direct.signalCode = signalCode;
      direct.emit("exit", null, signalCode);
    },
    host: {
      spawn: () => {
        if (model.spawnFailure) throw model.spawnFailure;
        return direct;
      },
      kill: (pid, signal) => {
        model.signals.push([pid, signal]);
        if (refused.includes(pid)) throw failure("EPERM");
        if (table.get(pid)?.state !== "S") throw failure("ESRCH");
        if (!held.includes(pid)) table.delete(pid);
      },
      pids: () => [...table.keys()],
      stat: (pid) => table.get(pid),
      readText: (path) => {
        read(path);
        if (path === "/proc/stat") return `cpu 0\nprocesses ${model.forks}\n`;
        if (path === "/proc/self/mountinfo") return model.mountinfo;
        if (model.files.has(path)) return model.files.get(path);
        const [, pid, tid] =
          /^\/proc\/(\d+)(?:\/task\/(\d+))?\/stat$/.exec(path) ?? [];
        if (!pid) throw failure("ENOENT");
        const task = entry(pid, tid);
        denied(table.get(Number(pid)), "stat");
        return statText(pid, task);
      },
      list: (path) => {
        read(path);
        if (path === "/proc") {
          model.scans++;
          return [...table.keys(), ...(model.listSelf ? [process.pid] : [])]
            .map(String)
            .concat("self", "stat");
        }
        const [, pid, tasks, tid] =
          /^\/proc\/(\d+)(\/task)?(?:\/(\d+))?(?:\/fd)?$/.exec(path) ?? [];
        if (!pid) throw failure("ENOENT");
        const entryOf = entry(pid);
        if (tasks && tid === undefined) {
          denied(entryOf, "task");
          return (entryOf.tasks ?? [{ tid: Number(pid) }]).map(({ tid }) =>
            String(tid),
          );
        }
        denied(entryOf, "fd");
        return fdList(entry(pid, tid ?? pid));
      },
      link: (path) => {
        read(path);
        if (path === "/proc/self") return model.self;
        const [, pid, tid, fd] =
          /^\/proc\/(\d+)(?:\/task\/(\d+))?\/fd\/(\d+)$/.exec(path) ?? [];
        if (!pid) throw failure("ENOENT");
        const entryOf = entry(pid);
        denied(entryOf, "link");
        const inode = entry(pid, tid ?? pid).fds[Number(fd) - 3];
        if (inode === undefined) throw failure("ENOENT");
        return `socket:[${inode}]`;
      },
    },
  });
}

/** A model tree whose start was written, its children's pid files listed under /model. */
function modelTree(options = {}, completionMs = 300) {
  const model = modelProcessHost(options);
  const children = model.inodes.map((_, i) => ({
    script: `child ${i}`,
    pidFile: `/model/${i}.pid`,
  }));
  const owned = ownedProcessTree("/", children, [], model.host, {
    completionMs,
  });
  /** Write every child's pid file. */
  const ready = () =>
    model.inodes.forEach((_, i) =>
      model.files.set(`/model/${i}.pid`, String(101 + i)),
    );
  return { model, owned, ready };
}

/**
 * The tree's stop signals only what it owns, on a model host: never a group
 * or process that took over a number of the tree's once the direct child was
 * reaped, whether the stop repeats one that ended the tree or comes first
 * after the direct child died; never a child it did not claim, or one whose
 * pid changed hands; concurrent stops share one run that acquires and
 * releases nothing more; and a failure anywhere fails the stop, after every
 * other step ran, with all errors, the same for a repeat.
 */
async function checkProcessTreeOwnership() {
  const sorted = (signals) => JSON.stringify([...signals].sort());
  const scansAfter = async (model, count, what) => {
    const from = model.scans;
    await until(() => model.scans >= from + count, what);
  };
  const pending = (promise) => {
    const state = { settled: false };
    promise.then(
      () => (state.settled = true),
      () => (state.settled = true),
    );
    return state;
  };

  // Recycled after the first cleanup.
  {
    const { model, owned, ready } = modelTree();
    ready();
    assert(owned.acquire(), "A model tree could not be acquired.");
    assert(model.released.size === 2, "A ready model tree was not released.");
    const first = owned.stop();
    assert(
      sorted(model.groupKills) === "[100]" && model.signals.length === 0,
      "A model tree's stop did not end its group from the direct child.",
    );
    model.reap();
    await first;
    model.table.set(100, model.member("50", { parent: 1 }));
    model.table.set(102, model.member("51"));
    model.table.set(103, model.member("52"));
    await owned.stop();
    assert(
      !owned.acquire() &&
        model.signals.length === 0 &&
        model.groupKills.length === 1 &&
        [100, 102, 103].every((pid) => model.table.has(pid)),
      `A repeated stop reached the recycled group: ${sorted(model.signals)}.`,
    );
  }

  // The direct child died, and its group's number and a child's pid were
  // reused, before a first stop.
  {
    const { model, owned, ready } = modelTree();
    ready();
    assert(owned.acquire(), "A model tree could not be acquired.");
    model.reap("SIGTERM");
    model.table.get(101).parent = 1;
    model.table.set(100, model.member("60", { parent: 1 }));
    model.table.set(102, model.member("61", { parent: 1 }));
    model.table.set(103, model.member("62"));
    assert(!owned.acquire(), "A recycled group number was claimable.");
    await owned.stop();
    assert(
      sorted(model.signals) === sorted([[101, "SIGKILL"]]) &&
        model.groupKills.length === 0 &&
        [100, 102, 103].every((pid) => model.table.has(pid)),
      `A stop after the direct child died signalled ${sorted(model.signals)}.`,
    );
  }

  // Concurrent stops, the direct child's reaping held: one run, and nothing
  // acquired or released after the first.
  {
    const { model, owned, ready } = modelTree();
    const stops = [owned.stop(), owned.stop()];
    const state = pending(stops[0]);
    ready();
    await Promise.resolve();
    assert(
      stops[0] === stops[1] &&
        !state.settled &&
        !owned.acquire() &&
        model.released.size === 0 &&
        model.groupKills.length === 1 &&
        model.signals.length === 0 &&
        model.gates.every((gate) => gate.closes === 1),
      "Concurrent stops did not share one run.",
    );
    model.reap();
    await Promise.all(stops);
    assert(
      model.groupKills.length === 1 && model.signals.length === 0,
      `Concurrent stops signalled ${sorted(model.signals)}.`,
    );
  }

  // The direct child's own group kill failed: the claimed children still
  // running are signalled by pid and start time.
  {
    const { model, owned, ready } = modelTree({ leaderKills: false });
    ready();
    assert(owned.acquire(), "A model tree could not be acquired.");
    const stop = owned.stop();
    model.reap("SIGKILL");
    await stop;
    assert(
      sorted(model.signals) ===
        sorted([
          [101, "SIGKILL"],
          [102, "SIGKILL"],
        ]),
      `A stop whose group kill failed signalled ${sorted(model.signals)}.`,
    );
  }

  // A refused signal: the other claimed child is still signalled, the stop
  // waits for the refused one in vain and fails, and a repeat fails the same
  // way with no further signal.
  {
    const { model, owned, ready } = modelTree({ refused: [101] });
    ready();
    assert(owned.acquire(), "A model tree could not be acquired.");
    model.reap("SIGTERM");
    const failed = await rejection(owned.stop());
    const repeated = await rejection(owned.stop());
    assert(
      failed instanceof AggregateError &&
        failed.errors[0]?.code === "EPERM" &&
        failed.errors[1]?.cause?.holders.join() === "101" &&
        failed.errors.length === 2 &&
        repeated === failed &&
        sorted(model.signals) ===
          sorted([
            [101, "SIGKILL"],
            [102, "SIGKILL"],
          ]),
      `A refused signal stopped as ${failed?.errors?.map(String)} after ${sorted(model.signals)}.`,
    );
  }

  // A direct child that never spawned: its stdio is still closed, and
  // nothing is claimed or signalled. One that failed to spawn at all throws.
  {
    const model = modelProcessHost();
    model.direct.pid = undefined;
    const owned = ownedProcessTree("/", [{}, {}], [], model.host);
    await owned.stop();
    assert(
      !owned.acquire() &&
        model.signals.length === 0 &&
        model.groupKills.length === 0 &&
        model.direct.stdio
          .filter(Boolean)
          .every(
            (stream) =>
              stream.closes === 1 && stream.listenerCount("error") === 1,
          ),
      "A tree that never spawned signalled something or kept its stdio.",
    );
    model.spawnFailure = Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
    let thrown;
    try {
      ownedProcessTree("/", [], [], model.host);
    } catch (error) {
      thrown = error;
    }
    assert(thrown === model.spawnFailure, "A failed spawn did not throw.");
  }

  // The direct child dies before any child is claimed: nothing is released
  // or signalled, and the stop waits for the gated children's EOF.
  {
    const { model, owned } = modelTree({ deferEof: true });
    model.reap();
    assert(
      !owned.acquire() && model.table.has(101) && model.table.has(102),
      "An unclaimed tree's children were claimed or gone.",
    );
    const stop = owned.stop();
    const state = pending(stop);
    await scansAfter(model, 3, "the unclaimed tree's scans");
    assert(
      !state.settled && model.signals.length === 0,
      "An unclaimed tree's stop ended before its gated children.",
    );
    model.eof();
    await stop;
    assert(model.signals.length === 0, "An unclaimed tree was signalled.");
  }

  // The direct child dies while only the first child was observed: only it
  // is claimed and signalled, and the stop waits for the others' EOF.
  {
    const { model, owned, ready } = modelTree({ gates: 3, deferEof: true });
    ready();
    assert(
      owned.acquire({ observe: (pid) => pid === 101 }),
      "A model tree could not be acquired.",
    );
    const claimed = owned.claimed();
    assert(
      [...claimed.keys()].join() === "101" &&
        [...model.released].join() === "0",
      `An observed snapshot claimed ${[...claimed.keys()]}.`,
    );
    model.reap();
    const stop = owned.stop();
    const state = pending(stop);
    await scansAfter(model, 3, "the partly claimed tree's scans");
    assert(
      !state.settled && sorted(model.signals) === sorted([[101, "SIGKILL"]]),
      `A partly claimed tree's stop signalled ${sorted(model.signals)}.`,
    );
    model.eof();
    await stop;
  }

  // Stale exit flags while `/proc` shows another process under the number:
  // nothing is claimed, released or signalled.
  {
    const { model, owned, ready } = modelTree();
    ready();
    model.table.get(100).start = "99";
    assert(
      !owned.acquire() && model.released.size === 0,
      "A changed direct child was claimed.",
    );
    const stop = owned.stop();
    model.reap();
    await stop;
    assert(
      model.signals.length === 0,
      "A changed direct child's tree was signalled.",
    );
  }

  // A child's pid is reused before its pid file names it, or after its
  // claim: it is neither released nor signalled.
  {
    const { model, owned, ready } = modelTree({ leaderKills: false });
    assert(owned.acquire(), "A model tree could not be acquired.");
    model.table.set(101, model.member("70", { group: 300 }));
    ready();
    assert(
      owned.acquire() && [...model.released].join() === "1",
      `A reused pid was released: ${[...model.released]}.`,
    );
    model.table.set(102, model.member("80", { group: 300 }));
    const stop = owned.stop();
    model.reap();
    await stop;
    assert(
      model.signals.length === 0,
      `Reused pids were signalled: ${sorted(model.signals)}.`,
    );
  }

  // Stopping fails, after every step ran, when a gate's close throws, a
  // gate reports an error, or one's error comes only with its late close;
  // the stop waits for that close, and a repeat fails the same way.
  {
    const { model, owned, ready } = modelTree({
      leaderKills: false,
      held: [101],
    });
    ready();
    assert(owned.acquire(), "A model tree could not be acquired.");
    const thrown = new Error("destroy");
    model.gates[0].throwOnDestroy = thrown;
    model.gates[1].error = Object.assign(new Error("EPIPE"), { code: "EPIPE" });
    model.direct.stdin.holdClose = true;
    model.direct.stdin.error = Object.assign(new Error("ELATE"), {
      code: "ELATE",
    });
    const stop = owned.stop();
    const state = pending(stop);
    model.reap();
    // The stop scans while the held child runs; the first scan after it is
    // gone reads empty, and the stop goes on to wait for the late close.
    await scansAfter(model, 1, "the failing tree's scans");
    model.table.delete(101);
    await scansAfter(model, 1, "the failing tree's last scan");
    assert(
      !state.settled &&
        model.direct.stdin.release !== undefined &&
        sorted(model.signals) ===
          sorted([
            [101, "SIGKILL"],
            [102, "SIGKILL"],
          ]),
      "A stop ended before a late close, or skipped a signal.",
    );
    model.direct.stdin.release();
    const failed = await rejection(stop);
    const repeated = await rejection(owned.stop());
    const codes = failed?.errors?.map((error) => error.code ?? error.message);
    assert(
      failed instanceof AggregateError &&
        failed.errors.includes(thrown) &&
        codes.includes("EPIPE") &&
        codes.includes("ELATE") &&
        repeated === failed &&
        model.signals.length === 2,
      `A failing stop rejected with ${codes}.`,
    );
  }

  await checkGateHolders();
}

/**
 * The tree's scan counts a process as not holding a gate only when it is
 * gone, older than the tree, a kernel thread, or read without one. A refused
 * or failed read, a changed or hidden `/proc`, or a task created meanwhile
 * keeps it from reading empty; a zombie's tasks hold nothing, and a living
 * task of one is read. Nothing it reports is signalled.
 */
async function checkGateHolders() {
  const scanOf = (setup) => {
    const { model, owned } = modelTree();
    for (const pid of [100, 101, 102]) model.table.delete(pid);
    setup(model);
    return owned.witness();
  };
  const subject = (model, change = {}) => {
    const entryOf = Object.assign(
      model.member("20", { group: 200, fds: [9001] }),
      change,
    );
    model.table.set(200, entryOf);
    return entryOf;
  };
  const expect = (what, scan, kind, extra = () => true) =>
    assert(
      scan.kind === kind && extra(scan),
      `${what} scanned as ${JSON.stringify(scan)}.`,
    );
  const unknownCode = (code) => (scan) =>
    scan.unknown.length === 1 && scan.unknown[0].code === code;

  expect(
    "A readable holder",
    scanOf((m) => subject(m)),
    "held",
  );
  expect(
    "No holder",
    scanOf(() => {}),
    "empty",
  );
  for (const [read, code] of [
    ["fd", "EACCES"],
    ["fd", "EPERM"],
    ["link", "EACCES"],
    ["stat", "EIO"],
    ["fd", "EMFILE"],
    ["task", "EIO"],
  ])
    expect(
      `A holder whose ${read} read failed with ${code}`,
      scanOf((m) => {
        const entryOf = subject(m, { deny: { [read]: code } });
        if (read === "task")
          entryOf.tasks = [
            { tid: 200, ...entryOf },
            { tid: 201, ...entryOf },
          ];
      }),
      "unknown",
      unknownCode(code),
    );
  expect(
    "An unparsed stat",
    scanOf((m) => subject(m, { raw: "200 (m) S" })),
    "unknown",
    unknownCode("UNPARSED"),
  );
  for (const [read, code] of [
    ["stat", "ENOENT"],
    ["fd", "ESRCH"],
    ["link", "ENOENT"],
  ])
    expect(
      `A holder gone at its ${read} read (${code})`,
      scanOf((m) => subject(m, { deny: { [read]: code } })),
      "empty",
    );
  // Refused reads are unknown whoever the process is; only age and kernel
  // threads exclude one, and nothing reads a process's credentials.
  {
    let reads;
    expect(
      "An unrelated unreadable process",
      scanOf((m) => {
        subject(m, { group: 0, session: 0, fds: [], deny: { fd: "EACCES" } });
        reads = m.reads;
      }),
      "unknown",
      unknownCode("EACCES"),
    );
    assert(
      !reads.some((path) => path.endsWith("/status")),
      "The scan read a process's credentials.",
    );
  }
  expect(
    "An unreadable process older than the tree",
    scanOf((m) => subject(m, { start: "9", deny: { fd: "EACCES" } })),
    "empty",
  );
  expect(
    "An unreadable process as old as the tree",
    scanOf((m) => subject(m, { start: "10", deny: { fd: "EACCES" } })),
    "unknown",
  );
  expect(
    "An unreadable kernel thread",
    scanOf((m) => subject(m, { flags: 0x00200000, deny: { fd: "EACCES" } })),
    "empty",
  );
  expect(
    "A zombie",
    scanOf((m) => subject(m, { state: "Z", fds: [] })),
    "empty",
  );
  expect(
    "A zombie leader with a living task holding a gate",
    scanOf((m) => {
      const entryOf = subject(m, { state: "Z", fds: [] });
      entryOf.tasks = [
        { tid: 200, state: "Z", fds: [] },
        { tid: 201, state: "S", fds: [9001] },
      ];
    }),
    "held",
    (scan) => scan.holders.join() === "200",
  );
  // A task created during the scan, or a pid replaced meanwhile.
  {
    const { model, owned } = modelTree();
    for (const pid of [100, 101, 102]) model.table.delete(pid);
    subject(model, { fds: [] });
    let churn = true;
    model.onRead = (path) => {
      if (churn && path === "/proc/200/stat") {
        model.forks++;
        churn = false;
      }
    };
    expect("A scan during a fork", owned.witness(), "unknown");
    expect("The scan after it", owned.witness(), "empty");
    let replaced = true;
    model.onRead = (path) => {
      if (replaced && path === "/proc/200/stat") {
        model.forks++;
        model.table.set(200, model.member("30", { group: 200 }));
        replaced = false;
      }
    };
    expect("A scan whose pid was replaced", owned.witness(), "unknown");
  }
  // `/proc` that is not this process's whole view, at either end.
  for (const [what, change] of [
    ["a foreign /proc/self", (m) => (m.self = "1")],
    ["no proc mount", (m) => (m.mountinfo = "")],
    ...["1", "2", "4", "noaccess", "invisible", "ptraceable"].map((value) => [
      `hidepid=${value}`,
      (m) =>
        (m.mountinfo = `22 1 0:5 / /proc rw - proc proc rw,hidepid=${value}\n`),
    ]),
    ["a listing without this process", (m) => (m.listSelf = false)],
    [
      "an unreadable /proc/stat",
      (m) =>
        (m.onRead = (path) => {
          if (path === "/proc/stat")
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }),
    ],
    [
      "a remount during the scan",
      (m) =>
        (m.onRead = (path) => {
          if (path === "/proc/200/stat")
            m.mountinfo = "22 1 0:5 / /proc rw - proc proc rw,hidepid=2\n";
        }),
    ],
  ])
    expect(
      `A scan with ${what}`,
      scanOf((m) => {
        subject(m, { fds: [] });
        change(m);
      }),
      "unknown",
    );

  // An unreadable claimed child: the stop waits, signalling nothing more,
  // until it is gone; while it stays, the stop fails naming it.
  for (const leaves of [true, false]) {
    const { model, owned, ready } = modelTree({
      leaderKills: false,
      held: [101],
    });
    ready();
    assert(owned.acquire(), "A model tree could not be acquired.");
    model.table.get(101).deny.fd = "EACCES";
    const stop = owned.stop();
    const state = { settled: false };
    stop.then(
      () => (state.settled = true),
      () => (state.settled = true),
    );
    model.reap();
    if (leaves) {
      const from = model.scans;
      await until(
        () => model.scans >= from + 3,
        "the unreadable child's scans",
      );
      assert(
        !state.settled &&
          JSON.stringify(model.signals) ===
            JSON.stringify([
              [101, "SIGKILL"],
              [102, "SIGKILL"],
            ]),
        "A stop ended while an unreadable child ran.",
      );
      model.table.delete(101);
      await stop;
    } else {
      const failed = await rejection(stop);
      const witness = failed?.errors?.at(-1)?.cause;
      assert(
        failed instanceof AggregateError &&
          failed.errors.length === 1 &&
          witness?.kind === "unknown" &&
          witness.unknown[0]?.pid === 101 &&
          witness.unknown[0]?.code === "EACCES" &&
          model.signals.length === 2,
        `An unreadable child's stop ended as ${failed}.`,
      );
    }
  }

  // Holders and unknown processes the scan reports are never signalled:
  // only the claimed child is.
  {
    const { model, owned, ready } = modelTree({ leaderKills: false });
    ready();
    assert(
      owned.acquire({ observe: (pid) => pid !== 102 }),
      "A model tree could not be acquired.",
    );
    model.table.set(300, model.member("30", { group: 300, fds: [9002] }));
    model.table.set(
      301,
      Object.assign(model.member("31", { group: 301 }), {
        deny: { fd: "EACCES" },
      }),
    );
    const stop = owned.stop();
    model.reap();
    const failed = await rejection(stop);
    assert(
      failed instanceof AggregateError &&
        JSON.stringify(model.signals) === JSON.stringify([[101, "SIGKILL"]]),
      `A stop signalled what its scan reported: ${JSON.stringify(model.signals)}.`,
    );
  }
}

/** `value` with every object's keys sorted, so key order is no difference. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/**
 * The checkout lifecycle methods answer under Bun as native `fs` and base
 * code do (`docs/workers.md`, "Checkout lifecycle"). Each filesystem case
 * builds two identical fixtures, runs the reference on A and the in-process
 * Worker's method on B, and compares the answer or failure, what remains of
 * the tree and the outside target, each normalized for its fixture's root.
 * The process stop runs against a tree the probe builds with a pid file per
 * process, so the expected signal sets come from the construction alone.
 */
async function checkWorkerLifecycle() {
  const uid = process.getuid?.();
  const base = realpathSync(mkdtempSync(join(scratch, "lifecycle-")));
  const lifecycle = checkoutLifecycleOn(DEFAULT_WORKER_SIDE);
  let owned;

  /** `run` on a fixture's tree: its answer or failure, then what remains. */
  const observe = async (root, run) => {
    let outcome;
    try {
      outcome = { answer: canonical(await run(join(root, "tree"))) };
    } catch (error) {
      outcome = {
        failure: {
          code: error?.code ?? null,
          message: error?.message ?? String(error),
          ...(checkoutFailureOf(error) === "worker" ? { worker: true } : {}),
        },
      };
    }
    const observed = JSON.stringify({
      ...outcome,
      tree: treeSnapshot(join(root, "tree")),
      outside: treeSnapshot(join(root, "outside")),
    });
    return observed.split(root).join("<fixture>");
  };
  const differential = async (name, shape, method, reference, onWorker) => {
    const a = join(base, `${name}-a`);
    const b = join(base, `${name}-b`);
    lifecycleFixture(a, shape);
    lifecycleFixture(b, shape);
    const expected = await observe(a, reference);
    const answered = await crossing([method], name, () => observe(b, onWorker));
    assert(
      answered === expected,
      `lifecycle ${name}: the Worker answered\n${answered}\nthe reference\n${expected}`,
    );
  };
  const done = () => "done";

  try {
    // O1: mkdir, recursive, as `mkdirSync` makes it.
    for (const [name, target] of [
      ["new", "new/deeper"],
      ["existing-dir", "sub"],
      ["existing-file", "file"],
      ["below-file", "file/below"],
    ])
      await differential(
        `O1-${name}`,
        "plain",
        LIFECYCLE_METHODS.mkdir,
        (tree) => (mkdirSync(join(tree, target), { recursive: true }), "done"),
        (tree) => lifecycle.mkdir(join(tree, target)).then(done),
      );
    console.log("lifecycle O1 ok");

    // O2: the removal ladder's first stage, as base `removeManagedTree`.
    await differential(
      "O2",
      "locked",
      LIFECYCLE_METHODS.removeTree,
      (tree) => removeManagedTree(tree),
      (tree) => lifecycle.removeTree(tree, "initial"),
    );
    console.log("lifecycle O2 ok");

    // O3: the residue scan, as base `scanTreeResidue`.
    await differential(
      "O3",
      "plain",
      LIFECYCLE_METHODS.scanResidue,
      (tree) => scanTreeResidue(tree),
      (tree) => lifecycle.scanResidue(tree),
    );
    console.log("lifecycle O3 ok");

    // O4: a failed create's discard and the managed clone's delete, as
    // base's `rmSync` (with its retries and owner repair) and `rm`.
    for (const shape of ["locked", "missing"]) {
      await differential(
        `O4-discard-${shape}`,
        shape,
        LIFECYCLE_METHODS.discardTree,
        (tree) => {
          try {
            rmSync(tree, {
              recursive: true,
              force: true,
              maxRetries: 10,
              retryDelay: 200,
            });
            return {};
          } catch (error) {
            restoreOwnerAccess(tree);
            return { failed: errorText(error) };
          }
        },
        (tree) => lifecycle.discardTree(tree),
      );
      await differential(
        `O4-remove-all-${shape}`,
        shape,
        LIFECYCLE_METHODS.removeAll,
        (tree) => rm(tree, { recursive: true, force: true }).then(done),
        (tree) => lifecycle.removeAll(tree).then(done),
      );
    }
    console.log("lifecycle O4 ok");

    await checkProcessTreeOwnership();
    console.log("lifecycle O5 ownership ok");
    await checkProcessTreeCleanup(base);
    console.log("lifecycle O5 cleanup ok");

    // O5's tree: the probe's direct child `sh` in B starts a sleeper and a
    // TERM-ignoring sleeper in B and one outside it, each exec'd so its pid
    // file names the process itself, then waits on all three.
    const fixture = join(base, "O5-b");
    const tree = lifecycleFixture(fixture, "plain");
    const outside = join(fixture, "outside");
    owned = ownedProcessTree(tree, o5Children(tree, outside), [outside]);
    const { direct } = owned;
    const { pids, ready } = pidFileReadiness({
      sleeper: join(tree, "sleeper.pid"),
      ignorer: join(tree, "ignorer.pid"),
      outside: join(outside, "outside.pid"),
    });
    await until(
      () => owned.acquire() && ready(),
      "the process tree's sleepers",
    );
    assert(
      parentPid(direct.pid) === process.pid &&
        Object.values(pids).every((pid) => parentPid(pid) === direct.pid),
      "The process tree is not the probe's child and grandchildren.",
    );
    assert(
      [direct.pid, ...Object.values(pids)].every(
        (pid) => processGroup(pid) === direct.pid,
      ),
      "The process tree does not run in its direct child's own group.",
    );

    // O6: a request for another Worker is refused before any effect.
    const before = JSON.stringify(treeSnapshot(tree));
    const elsewhere = { workerId: "elsewhere", path: tree };
    for (const [method, payload] of [
      [
        LIFECYCLE_METHODS.mkdir,
        encodeLifecycleLocation({ ...elsewhere, path: join(tree, "refused") }),
      ],
      [LIFECYCLE_METHODS.scanResidue, encodeLifecycleLocation(elsewhere)],
      [LIFECYCLE_METHODS.removeTree, encodeRemoveTree(elsewhere, "initial")],
      [LIFECYCLE_METHODS.discardTree, encodeLifecycleLocation(elsewhere)],
      [LIFECYCLE_METHODS.removeAll, encodeLifecycleLocation(elsewhere)],
      [LIFECYCLE_METHODS.stopProcesses, encodeLifecycleLocation(elsewhere)],
    ]) {
      const refused = await rejection(
        ensureInProcessWorker().request(method, payload),
      );
      assert(
        refused?.code === "wrong_worker",
        `A ${method} for another Worker answered ${refused}.`,
      );
    }
    assert(
      JSON.stringify(treeSnapshot(tree)) === before,
      "A refused lifecycle request changed the checkout.",
    );
    assert(
      [direct.pid, ...Object.values(pids)].every(running),
      "A refused stop signalled a process.",
    );
    console.log("lifecycle O6 ok");

    // O5: TERM reaches exactly the two grandchildren in B, KILL the one that
    // ignores it; the direct child and the outside sleeper get nothing.
    const stop = await crossing([LIFECYCLE_METHODS.stopProcesses], "O5", () =>
      lifecycle.stopProcesses(tree),
    );
    const sorted = (list) => [...list].sort((x, y) => x - y).join();
    assert(
      sorted(stop.terminated) === sorted([pids.sleeper, pids.ignorer]) &&
        sorted(stop.killed) === sorted([pids.ignorer]),
      `The stop signalled ${JSON.stringify(stop)}; the tree is ${JSON.stringify({ direct: direct.pid, ...pids })}.`,
    );
    await until(
      () => !running(pids.sleeper) && !running(pids.ignorer),
      "the stopped sleepers to end",
    );
    assert(
      running(direct.pid) && running(pids.outside),
      "The stop ended the direct child or the outside sleeper.",
    );
    console.log("lifecycle O5 ok");
    console.log(
      `Worker lifecycle (${mode}, uid ${uid}): mkdir, removal, residue scan, discard and delete match native fs and base code on twin fixtures; a stop signals exactly its checkout's grandchildren; another Worker's requests are refused.`,
    );
  } finally {
    try {
      await owned?.stop();
    } finally {
      try {
        execFileSync("chmod", ["-R", "u+rwx", base]);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
  }
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
  await checkWorkerCheckoutReads();
  await checkWorkerWorkflowReads();
  await checkWorkerLifecycle();

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
  const ignore = await treeIgnoreForTests(DEFAULT_WORKER_SIDE, root);
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
  const lost = [];
  let overflows = 0;
  let released = false;
  const watches = checkoutWatchOn(DEFAULT_WORKER_SIDE);
  const subscribe = () =>
    watches.subscribe(
      root,
      root,
      (error, events) => {
        if (!error) seen.push(...events.map((event) => event.path));
      },
      {
        ignore,
        onOverflow: () => overflows++,
        onLost: () => lost.push(released),
      },
    );
  const native = () => inProcessWorkerWatchesForTests().subscriptions.length;
  // Ignored writes first and a watched barrier last. One subscription's events
  // arrive in the order the kernel queued them, and the Worker delivers them in
  // that order, so an ignored event that was going to arrive has arrived by
  // the barrier's.
  const writeUntilBarrier = async (barrier, watched) => {
    writeFileSync(join(root, "build", "out.txt"), `ignored ${barrier}\n`);
    writeFileSync(
      join(root, "nested", "cache", "c.txt"),
      `ignored ${barrier}\n`,
    );
    for (const path of watched) writeFileSync(path, `changed ${barrier}\n`);
    writeFileSync(barrier, "barrier\n");
    await until(
      () => [...watched, barrier].every((path) => seen.includes(path)),
      `watched events through the Worker up to ${barrier}`,
    );
  };
  const deliveries = recordWatchDeliveriesForTests();
  let subscription;
  try {
    subscription = await subscribe();
    assert(native() === 1, `The Worker holds ${native()} native watches.`);
    await writeUntilBarrier(join(root, "src", "barrier.txt"), [
      join(root, "src", "a.txt"),
      join(root, "nested", "keep", "k.txt"),
    ]);
    const delivered = deliveries.records().length;
    assert(delivered > 0, "No watch.events reached the server.");

    // The connection ends: the watch is lost only once the Worker released
    // its native subscription, and is made again on the next connection.
    const epoch = inProcessWorkerEpochForTests();
    void inProcessWorkerWatchesForTests().released.then(() => {
      released = true;
    });
    writeAsInProcessWorkerForTests(new Uint8Array(8));
    await until(() => lost.length > 0, "the watch lost with its connection");
    assert(
      lost.length === 1 && lost[0],
      `The watch was lost before its release: ${JSON.stringify(lost)}`,
    );
    await subscription.unsubscribe();
    subscription = await subscribe();
    const next = inProcessWorkerEpochForTests();
    assert(
      next !== undefined && next !== epoch,
      `The watch was made again on epoch ${next}, not after ${epoch}.`,
    );
    assert(native() === 1, `The new Worker holds ${native()} native watches.`);
    await writeUntilBarrier(join(root, "src", "barrier-2.txt"), [
      join(root, "src", "a.txt"),
    ]);
    assert(
      deliveries.records().length > delivered,
      "No watch.events reached the server on the new connection.",
    );
  } finally {
    deliveries.stop();
    await subscription?.unsubscribe();
  }
  assert(native() === 0, `${native()} native watches outlived unsubscribe.`);
  assert(lost.length === 1, `The watch was lost ${lost.length} times.`);
  assert(overflows === 0, `A small burst overflowed ${overflows} times.`);
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

/**
 * The synchronous child_process calls start their child with the CURRENT
 * environment. This guards Bun's own default: 1.3.13 used the start-up one,
 * which a bundled shim corrected until 1.4.2 made it unnecessary.
 */
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

await checkManagedStdioFdReuse();
await checkGit();
await checkMaxBufferBound();
await checkPackageProxyEnvironment();
await checkWatcher();
if (mode === "broker") {
  checkSqlite();
  checkSyncSpawnEnvironment();
  await checkPiOAuthFlows();
  await checkInitiativeLayout();
}
console.log(`Bun runtime probe (${mode}) passed.`);
process.exit(0);
