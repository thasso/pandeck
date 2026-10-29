/**
 * Starting child processes WITHOUT forking the server.
 *
 * libuv starts every child with a plain `fork()`, which copies the calling
 * process's page tables before `exec` and blocks the event loop until the child
 * has exec'd. For this server — well over a gigabyte resident — that is tens to
 * hundreds of milliseconds per spawn, so a burst of git reads (a worktree list
 * resolving every project, a watcher rescan) froze every connection for
 * seconds. The broker is one small, long-lived helper process that performs the
 * spawns instead; the server only writes a JSON line and reads one back.
 *
 * ONE implementation serves both sides: {@link HANDLER_SOURCE} runs inside the
 * broker, and in-process through `vm` when the broker is unavailable (it failed
 * to start, or `ASSISTANT_SPAWN_BROKER=0`). It is plain JavaScript on Node
 * built-ins so the helper needs no file of its own in either package: the
 * broker is `process.execPath -e <script>`.
 *
 * A request that reached a broker which then died is rejected as an execution
 * failure — it may or may not have run, and only the caller can decide whether
 * to retry — but only after the broker's process group is sent SIGKILL, so
 * nothing it started keeps running once the caller moves on. Requests queued before
 * the broker reported ready never reached it, so they run in-process instead.
 *
 * A request may ask for an EXIT RECEIPT (`awaitExit`): its reply then waits
 * until the child itself has exited, not just until `execFile` answered — an
 * aborted `execFile` calls back before its child is gone. A cancelled child
 * that ignores SIGTERM for {@link EXIT_ESCALATION_MS} gets SIGKILL, and its
 * exit is still awaited. Only the child is covered: processes it started (git
 * hooks, ssh) are not, as they are not on any cancel. The Worker's checkout git
 * asks for it (`docs/workers.md`); every other caller keeps the plain timing.
 *
 * A dead broker cannot report its child's exit, so on broker death a request
 * with an exit receipt fails only once nothing of the broker's process group is
 * left unexited ({@link awaitGroupExit}) — its child included, whatever the
 * child's pid. A member SIGKILL cannot end (uninterruptible sleep) holds it
 * indefinitely, failing closed, with one warning after
 * {@link GROUP_EXIT_WARN_MS}.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";
import { COLLECTED_FILE_HANDLE_SOURCE } from "./collectedFileHandle.ts";

/** How long a cancelled child with an exit receipt has before SIGKILL. */
const EXIT_ESCALATION_MS = 2_000;
/** Longest pause between probes of a dead broker's process group. */
const GROUP_POLL_MAX_MS = 50;
/** When `/proc` is first scanned for a group that is not yet empty… */
const GROUP_SCAN_GRACE_MS = 20;
/** …and how often at most after that: a scan reads every process. */
const GROUP_SCAN_INTERVAL_MS = 1_000;
/** When a group still not exited is reported, once. */
const GROUP_EXIT_WARN_MS = 10_000;

/** Creates `handle(message)`; replies go to `send`. Plain JS by design. */
const HANDLER_SOURCE = String.raw`(function createSpawnHandler(require, send) {
  const EXIT_ESCALATION_MS = ${EXIT_ESCALATION_MS};
  const { execFile, spawn } = require("node:child_process");
  const { StringDecoder } = require("node:string_decoder");
  const fs = require("node:fs");
  const running = new Map();

  // Children inherit this process's oom_score_adj (childOomScore.ts). The
  // broker raised its own to 0 at start, so this is a no-op there; run
  // in-process under the unit's lowered score, each child is raised to 0 the
  // moment it exists. Never lowers a score.
  let lowered;
  function release(child) {
    try {
      if (lowered === undefined)
        lowered = process.platform === "linux" &&
          Number(fs.readFileSync("/proc/self/oom_score_adj", "latin1")) < 0;
      if (!lowered || !child || !child.pid) return;
      const path = "/proc/" + child.pid + "/oom_score_adj";
      if (Number(fs.readFileSync(path, "latin1")) < 0) fs.writeFileSync(path, "0");
    } catch (_) {
      if (lowered === undefined) lowered = false;
    }
  }

  // With m.awaitExit, holds a reply until the child has exited as well:
  // execFile answers an abort before its child is gone. A cancelled child
  // still running after EXIT_ESCALATION_MS gets SIGKILL.
  function exitReceipt(id) {
    let child;
    let reply;
    let exited = false;
    let escalation;
    const flush = () => {
      if (!reply || !exited) return;
      if (escalation) clearTimeout(escalation);
      running.delete(id);
      send(reply);
    };
    return {
      watch(started) {
        child = started;
        // No pid: the spawn failed and no process exists.
        if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
          exited = true;
        else
          child.once("exit", () => {
            exited = true;
            flush();
          });
        flush();
      },
      escalate() {
        if (exited || escalation || !child) return;
        escalation = setTimeout(() => {
          if (exited) return;
          try {
            child.kill("SIGKILL");
          } catch (_) {}
        }, EXIT_ESCALATION_MS);
        if (escalation.unref) escalation.unref();
      },
      settle(message) {
        reply = message;
        flush();
      },
    };
  }

  function errorOf(err) {
    const code = err && err.code;
    return {
      code: typeof code === "number" || typeof code === "string" ? code : null,
      message: String((err && err.message) || err),
    };
  }

  function withinMaxBuffer(output, maxBuffer) {
    if (!output || output.length <= maxBuffer) return output;
    return typeof output === "string"
      ? output.slice(0, maxBuffer)
      : output.subarray(0, maxBuffer);
  }

  function exec(m) {
    const controller = new AbortController();
    const receipt = m.awaitExit ? exitReceipt(m.id) : undefined;
    running.set(m.id, () => {
      controller.abort();
      if (receipt) receipt.escalate();
    });
    const buffer = m.encoding === "buffer";
    let child;
    try {
      child = execFile(
        m.file,
        m.args,
        {
          cwd: m.cwd,
          env: m.env,
          maxBuffer: m.maxBuffer,
          encoding: buffer ? "buffer" : "utf8",
          signal: controller.signal,
        },
        (err, stdout, stderr) => {
          if (err && err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            // Node keeps each stream's .length within maxBuffer on overflow
            // (UTF-16 code units for text, bytes for a Buffer); Bun 1.4.2
            // returns a timing-dependent overshoot on either stream.
            stdout = withinMaxBuffer(stdout, m.maxBuffer);
            stderr = withinMaxBuffer(stderr, m.maxBuffer);
          }
          const reply = {
            id: m.id,
            error: err ? errorOf(err) : null,
            stdout: buffer ? Buffer.from(stdout || "").toString("base64") : stdout || "",
            stderr: buffer ? Buffer.from(stderr || "").toString("utf8") : stderr || "",
          };
          if (receipt) return receipt.settle(reply);
          running.delete(m.id);
          send(reply);
        },
      );
    } catch (err) {
      running.delete(m.id);
      send({ id: m.id, error: errorOf(err), stdout: "", stderr: "" });
      return;
    }
    if (receipt) receipt.watch(child);
    release(child);
    if (m.input !== undefined && m.input !== null && child.stdin) {
      // A command that exits before consuming input may close the pipe early;
      // its result stays the authoritative failure.
      child.stdin.on("error", () => undefined);
      child.stdin.end(Buffer.from(m.input, "base64"));
    }
  }

  function bounded(m) {
    let done = false;
    let aborted = false;
    let patch = "";
    let totalChars = 0;
    let stderr = "";
    const receipt = m.awaitExit ? exitReceipt(m.id) : undefined;
    const finish = (reply) => {
      if (done) return;
      done = true;
      const message = Object.assign({ id: m.id, patch, totalChars, stderr, aborted }, reply);
      if (receipt) return receipt.settle(message);
      running.delete(m.id);
      send(message);
    };
    let child;
    try {
      child = spawn(m.file, m.args, {
        cwd: m.cwd,
        env: m.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      if (receipt) receipt.watch(undefined);
      finish({ spawnError: errorOf(err).message, code: null });
      return;
    }
    if (receipt) receipt.watch(child);
    release(child);
    running.set(m.id, () => {
      aborted = true;
      child.kill("SIGTERM");
      if (receipt) receipt.escalate();
    });
    const out = new StringDecoder("utf8");
    const err = new StringDecoder("utf8");
    const consume = (text) => {
      totalChars += text.length;
      if (patch.length < m.maxChars) patch += text.slice(0, m.maxChars - patch.length);
    };
    const keepErr = (text) => {
      if (stderr.length < m.maxStderr) stderr += text.slice(0, m.maxStderr - stderr.length);
    };
    child.stdout.on("data", (chunk) => consume(out.write(chunk)));
    child.stderr.on("data", (chunk) => keepErr(err.write(chunk)));
    child.on("error", (e) => finish({ spawnError: errorOf(e).message, code: null }));
    child.on("close", (code) => {
      consume(out.end());
      keepErr(err.end());
      finish({ code });
    });
  }

  return function handle(m) {
    if (m.cancel !== undefined) {
      const cancel = running.get(m.cancel);
      if (cancel) cancel();
      return;
    }
    if (m.kind === "bounded") bounded(m);
    else exec(m);
  };
})`;

const BROKER_SCRIPT = String.raw`
// Bun 1.4.2 raises an uncaught error for a FileHandle closed during garbage
// collection, where Node only warns: warn for exactly that one, and end the
// broker on anything else as an unheard exception would (collectedFileHandle.ts).
const ignoreCollectedFileHandle = ${COLLECTED_FILE_HANDLE_SOURCE};
process.on("uncaughtException", (err) => {
  if (ignoreCollectedFileHandle(err, "spawn broker")) return;
  console.error("Uncaught exception in the spawn broker:", err);
  process.exit(1);
});
// The server's lowered oom_score_adj is its own: the broker, and so every
// process it starts, goes back to neutral (childOomScore.ts).
try {
  const fs = require("node:fs");
  if (Number(fs.readFileSync("/proc/self/oom_score_adj", "latin1")) < 0)
    fs.writeFileSync("/proc/self/oom_score_adj", "0");
} catch (_) {}
const handle = ${HANDLER_SOURCE}(require, (m) => process.stdout.write(JSON.stringify(m) + "\n"));
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  pending += data;
  for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
    const line = pending.slice(0, at);
    pending = pending.slice(at + 1);
    if (line) handle(JSON.parse(line));
  }
});
// The server went away: nothing can read our answers any more.
process.stdin.on("end", () => process.exit(0));
process.stdout.write(JSON.stringify({ ready: true }) + "\n");
`;

export interface BrokerExecRequest {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  encoding: "utf8" | "buffer";
  input?: string | Buffer;
  signal?: AbortSignal;
  /** Reply only once the child has exited, escalating a cancel to SIGKILL. */
  awaitExit?: boolean;
}

/** What `execFile`'s callback saw, with `stdout` as a string or raw bytes. */
export interface BrokerExecOutcome<Out extends string | Buffer> {
  error: { code: number | string | null; message: string } | null;
  stdout: Out;
  stderr: string;
}

export interface BrokerBoundedRequest {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  maxChars: number;
  maxStderr: number;
  signal?: AbortSignal;
  /** Reply only once the child has exited, escalating a cancel to SIGKILL. */
  awaitExit?: boolean;
}

export interface BrokerBoundedOutcome {
  spawnError?: string;
  code: number | null;
  aborted: boolean;
  patch: string;
  totalChars: number;
  stderr: string;
}

interface WireReply {
  id: number;
  error?: BrokerExecOutcome<string>["error"];
  stdout?: string;
  stderr: string;
  spawnError?: string;
  code?: number | null;
  aborted?: boolean;
  patch?: string;
  totalChars?: number;
}

type WireRequest = Record<string, unknown> & { id: number };

interface Pending {
  message: WireRequest;
  settle: (reply: WireReply) => void;
  fail: (err: Error) => void;
}

const READY_TIMEOUT_MS = 10_000;
const RETRY_AFTER_FAILURE_MS = 60_000;

let nextId = 1;
let broker:
  | {
      child: ChildProcess;
      ready: boolean;
      pending: Map<number, Pending>;
      queued: Pending[];
    }
  | undefined;
let brokerFailedAt = 0;
let localHandle: ((message: WireRequest) => void) | undefined;
const localPending = new Map<number, (reply: WireReply) => void>();

function brokerEnabled(): boolean {
  return process.env.ASSISTANT_SPAWN_BROKER !== "0";
}

/** The in-process twin of the broker, built from the same source. */
function local(): (message: WireRequest) => void {
  if (!localHandle) {
    const create = runInThisContext(HANDLER_SOURCE) as (
      req: NodeJS.Require,
      send: (reply: WireReply) => void,
    ) => (message: WireRequest) => void;
    localHandle = create(createRequire(import.meta.url), (reply) => {
      const settle = localPending.get(reply.id);
      localPending.delete(reply.id);
      settle?.(reply);
    });
  }
  return localHandle;
}

function runLocally(entry: Pending): void {
  localPending.set(entry.message.id, entry.settle);
  local()(entry.message);
}

function setRef(child: ChildProcess, busy: boolean): void {
  // An idle broker must not keep a script or test process alive; a busy one
  // must, or a pending git call could outlive its own event loop.
  for (const stream of [child.stdin, child.stdout] as const) {
    const handle = stream as unknown as { ref?(): void; unref?(): void };
    if (busy) handle.ref?.();
    else handle.unref?.();
  }
}

function startBroker(): typeof broker {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  let child: ChildProcess;
  try {
    // Its own process group, which every child it starts inherits: if the
    // broker dies, the group is how its still-running children are found.
    child = spawn(process.execPath, ["-e", BROKER_SCRIPT], {
      stdio: ["pipe", "pipe", "inherit"],
      env,
      detached: true,
    });
  } catch {
    brokerFailedAt = Date.now();
    return undefined;
  }
  child.unref();
  const state = {
    child,
    ready: false,
    pending: new Map<number, Pending>(),
    queued: [] as Pending[],
  };
  const readyTimer = setTimeout(() => {
    if (!state.ready) child.kill("SIGKILL");
  }, READY_TIMEOUT_MS);
  readyTimer.unref();

  let buffered = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (data: string) => {
    buffered += data;
    for (
      let at = buffered.indexOf("\n");
      at >= 0;
      at = buffered.indexOf("\n")
    ) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (!line) continue;
      const reply = JSON.parse(line) as WireReply & { ready?: boolean };
      if (reply.ready) {
        state.ready = true;
        clearTimeout(readyTimer);
        for (const entry of state.queued.splice(0)) write(state, entry);
        continue;
      }
      const entry = state.pending.get(reply.id);
      state.pending.delete(reply.id);
      if (state.pending.size === 0) setRef(child, false);
      entry?.settle(reply);
    }
  });
  const onGone = (): void => {
    clearTimeout(readyTimer);
    if (broker === state) broker = undefined;
    if (!state.ready) brokerFailedAt = Date.now();
    // A child the broker started outlives it. Before an in-flight request is
    // answered — and a caller releases the repo lock it held — that child is
    // sent SIGKILL, or a git mutation keeps writing beside whatever runs next.
    // The signal is not awaited; the window left is the kernel's delivery.
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // No member of the group is left.
      }
    }
    // Never reached the broker: safe to run here instead.
    for (const entry of state.queued.splice(0)) runLocally(entry);
    // Reached it, outcome unknown. An exit receipt was asked for: the broker
    // can no longer give one, so the group's exit stands in for it.
    const gone = new Error("The process broker exited before answering.");
    const group = child.pid;
    const receipts: Pending[] = [];
    for (const entry of state.pending.values()) {
      if (entry.message.awaitExit && group !== undefined) receipts.push(entry);
      else entry.fail(gone);
    }
    state.pending.clear();
    if (group !== undefined && receipts.length > 0)
      void awaitGroupExit(group, groupIo).then(() => {
        for (const entry of receipts) entry.fail(gone);
      });
  };
  child.once("exit", onGone);
  child.once("error", onGone);
  child.stdin?.on("error", () => undefined);
  setRef(child, false);
  return state;
}

/** How {@link awaitGroupExit} looks at processes; a seam for tests. */
export interface GroupIo {
  /** `process.kill(-pgid, 0)`. */
  probe(pgid: number): void;
  /** Whether `/proc` can be scanned. */
  scannable: boolean;
  /** The entries of `/proc`. */
  list(): string[];
  /** `/proc/<pid>/stat`. */
  stat(pid: string): string;
  /** The entries of `/proc/<pid>/task`. */
  tasks(pid: string): string[];
  /** `/proc/<pid>/task/<tid>/stat`. */
  taskStat(pid: string, tid: string): string;
  warn(message: string): void;
}

const systemGroupIo: GroupIo = {
  probe: (pgid) => process.kill(-pgid, 0),
  scannable: process.platform === "linux",
  list: () => readdirSync("/proc"),
  stat: (pid) => readFileSync(`/proc/${pid}/stat`, "latin1"),
  tasks: (pid) => readdirSync(`/proc/${pid}/task`),
  taskStat: (pid, tid) =>
    readFileSync(`/proc/${pid}/task/${tid}/stat`, "latin1"),
  warn: (message) => console.warn(message),
};
let groupIo = systemGroupIo;

/** Test seam: replace how a dead broker's group is observed; reset with none. */
export function setGroupIoForTests(io?: Partial<GroupIo>): void {
  groupIo = io ? { ...systemGroupIo, ...io } : systemGroupIo;
}

function errorCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

/** Parse identity, state, pgrp and num_threads, not the parenthesized comm. */
function procStat(text: string, id: string) {
  const at = text.lastIndexOf(")");
  if (!text.startsWith(`${id} (`) || at < 0 || text[at + 1] !== " ")
    return undefined;
  const fields = text
    .slice(at + 2)
    .trim()
    .split(/\s+/);
  const [state, ppid, pgrp] = fields;
  const threads = fields[17];
  if (
    !/^[A-Za-z]$/.test(state ?? "") ||
    !/^\d+$/.test(ppid ?? "") ||
    !/^\d+$/.test(pgrp ?? "") ||
    !/^\d+$/.test(threads ?? "") ||
    !Number.isSafeInteger(Number(pgrp)) ||
    !Number.isSafeInteger(Number(threads)) ||
    Number(threads) < 1
  )
    return undefined;
  return { state, pgrp: Number(pgrp), threads: Number(threads) };
}

const deadState = (state: string | undefined) => state === "Z" || state === "X";

/**
 * One complete `/proc` scan. Dead leaders need a complete task scan and a
 * final single-thread count: readdir alone can miss a concurrently born task.
 * A Z/X leader with num_threads=1 cannot create another thread. Task read and
 * enumeration races, including ENOENT, are unknown until a later scan/probe.
 * Only a top-level pid that vanished before its first stat is skipped.
 */
function scanGroup(
  pgid: number,
  io: GroupIo,
): { members: number; running: string[] } | undefined {
  let names: string[];
  try {
    names = io.list();
  } catch {
    return undefined;
  }
  let members = 0;
  const running: string[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let text: string;
    try {
      text = io.stat(name);
    } catch (err) {
      if (errorCode(err) === "ENOENT") continue;
      return undefined;
    }
    const leader = procStat(text, name);
    if (!leader) return undefined;
    if (leader.pgrp !== pgid) continue;
    members += 1;
    if (!deadState(leader.state)) {
      running.push(`${name}:${leader.state}`);
      continue;
    }
    try {
      const tids = io.tasks(name);
      if (!tids.includes(name) || tids.some((tid) => !/^\d+$/.test(tid)))
        return undefined;
      for (const tid of tids) {
        const task = procStat(io.taskStat(name, tid), tid);
        if (!task || task.pgrp !== pgid) return undefined;
        if (!deadState(task.state))
          running.push(`${name}/${tid}:${task.state}`);
      }
      // Do not infer a lifetime proof from sequential task reads. In
      // particular, a live thread can clone and exit during enumeration.
      const final = procStat(io.stat(name), name);
      if (!final || final.pgrp !== pgid) return undefined;
      if (!deadState(final.state) || final.threads !== 1)
        running.push(`${name}:${final.state}/threads=${final.threads}`);
    } catch {
      return undefined;
    }
  }
  return { members, running };
}

/**
 * Resolves once no member of process group `pgid` is left unexited: signal 0
 * to the group finds none (ESRCH), or a complete `/proc` scan sees members and
 * all of them have dead leaders with no sibling threads left. A zombie leader
 * alone is not an exited process. Anything uncertain means members remain: an
 * unexpected errno, task read/parse races, or a scan that sees no member though
 * the probe found one (hidden by `hidepid`, another pid namespace, or reaped
 * since, which the next probe shows). It never sends a real signal and never
 * gives up: a member in uninterruptible sleep keeps it
 * waiting, with one warning at {@link GROUP_EXIT_WARN_MS}.
 *
 * A group id is not reused while a member, zombie or not, still holds it, so
 * every member seen is the broker's; reuse after the group emptied can only
 * make this wait longer.
 */
export function awaitGroupExit(
  pgid: number,
  io: GroupIo = systemGroupIo,
): Promise<void> {
  const started = Date.now();
  let lastScan: number | undefined;
  let scan: ReturnType<typeof scanGroup>;
  const scanIfDue = (): void => {
    const now = Date.now();
    if (
      io.scannable &&
      now - started >= GROUP_SCAN_GRACE_MS &&
      (lastScan === undefined || now - lastScan >= GROUP_SCAN_INTERVAL_MS)
    ) {
      lastScan = now;
      scan = scanGroup(pgid, io);
    }
  };
  let delay = 1;
  return new Promise((resolve) => {
    const warning = setTimeout(() => {
      scanIfDue();
      const running = scan?.running.length ? scan.running.join(", ") : "";
      io.warn(
        `[spawn-broker] process group ${pgid} has not exited ` +
          `${GROUP_EXIT_WARN_MS / 1000} s after its broker died; ` +
          `still running: ${running || "unknown"}`,
      );
    }, GROUP_EXIT_WARN_MS);
    warning.unref();
    const poll = (): void => {
      let certain = true;
      try {
        io.probe(pgid);
      } catch (err) {
        if (errorCode(err) === "ESRCH") {
          clearTimeout(warning);
          resolve();
          return;
        }
        certain = false;
      }
      // A cached all-dead scan is stable: its leaders had no other threads
      // left to fork. A probe error still prevents using it as a receipt.
      scanIfDue();
      if (certain && scan && scan.members > 0 && scan.running.length === 0) {
        clearTimeout(warning);
        resolve();
        return;
      }
      // Ref'd: a request still waiting must keep its process alive.
      setTimeout(poll, delay);
      delay = Math.min(delay * 2, GROUP_POLL_MAX_MS);
    };
    poll();
  });
}

function write(state: NonNullable<typeof broker>, entry: Pending): void {
  state.pending.set(entry.message.id, entry);
  setRef(state.child, true);
  state.child.stdin?.write(`${JSON.stringify(entry.message)}\n`);
}

function submit(entry: Pending): void {
  if (
    !brokerEnabled() ||
    (!broker && Date.now() - brokerFailedAt < RETRY_AFTER_FAILURE_MS)
  ) {
    runLocally(entry);
    return;
  }
  broker ??= startBroker();
  if (!broker) {
    runLocally(entry);
    return;
  }
  if (broker.ready) write(broker, entry);
  else {
    broker.queued.push(entry);
    setRef(broker.child, true);
  }
}

function cancel(id: number): void {
  const message = { cancel: id } as unknown as WireRequest;
  if (localPending.has(id)) {
    local()(message);
    return;
  }
  if (broker?.pending.has(id))
    broker.child.stdin?.write(`${JSON.stringify(message)}\n`);
  else if (broker) {
    // Still queued: drop it and answer as an abort would.
    const index = broker.queued.findIndex((entry) => entry.message.id === id);
    if (index >= 0) {
      const [entry] = broker.queued.splice(index, 1);
      entry?.settle({
        id,
        error: { code: "ABORT_ERR", message: "The operation was aborted" },
        stdout: "",
        stderr: "",
        aborted: true,
        code: null,
        patch: "",
        totalChars: 0,
      });
    }
  }
}

function request(
  message: Omit<WireRequest, "id">,
  signal: AbortSignal | undefined,
): Promise<WireReply> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onAbort = (): void => cancel(id);
    const entry: Pending = {
      message: { ...message, id },
      settle: (reply) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(reply);
      },
      fail: (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    };
    submit(entry);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** `execFile` off the server's process; resolves with what its callback saw. */
export async function brokerExecFile(
  req: BrokerExecRequest & { encoding: "utf8" },
): Promise<BrokerExecOutcome<string>>;
export async function brokerExecFile(
  req: BrokerExecRequest & { encoding: "buffer" },
): Promise<BrokerExecOutcome<Buffer>>;
export async function brokerExecFile(
  req: BrokerExecRequest,
): Promise<BrokerExecOutcome<string | Buffer>> {
  if (req.signal?.aborted)
    return {
      error: { code: "ABORT_ERR", message: "The operation was aborted" },
      stdout: req.encoding === "buffer" ? Buffer.alloc(0) : "",
      stderr: "",
    };
  const reply = await request(
    {
      kind: "exec",
      file: req.file,
      args: req.args,
      cwd: req.cwd,
      env: req.env,
      maxBuffer: req.maxBuffer,
      encoding: req.encoding,
      ...(req.input !== undefined
        ? { input: Buffer.from(req.input).toString("base64") }
        : {}),
      ...(req.awaitExit ? { awaitExit: true } : {}),
    },
    req.signal,
  );
  return {
    error: reply.error ?? null,
    stdout:
      req.encoding === "buffer"
        ? Buffer.from(reply.stdout ?? "", "base64")
        : (reply.stdout ?? ""),
    stderr: reply.stderr,
  };
}

/**
 * Stream a child's stdout off the server's process, keeping at most `maxChars`
 * of it (and `maxStderr` of stderr) while counting the total.
 */
export async function brokerBoundedStdout(
  req: BrokerBoundedRequest,
): Promise<BrokerBoundedOutcome> {
  const reply = await request(
    {
      kind: "bounded",
      file: req.file,
      args: req.args,
      cwd: req.cwd,
      env: req.env,
      maxChars: req.maxChars,
      maxStderr: req.maxStderr,
      ...(req.awaitExit ? { awaitExit: true } : {}),
    },
    req.signal,
  );
  return {
    ...(reply.spawnError !== undefined ? { spawnError: reply.spawnError } : {}),
    code: reply.code ?? null,
    aborted: reply.aborted === true,
    patch: reply.patch ?? "",
    totalChars: reply.totalChars ?? 0,
    stderr: reply.stderr,
  };
}

/**
 * Start the broker now rather than on the first request, so its one fork of
 * the server happens at boot, while the process is still small.
 */
export function startSpawnBroker(): void {
  if (!brokerEnabled() || broker) return;
  broker = startBroker();
}

/** Test seam: the broker's pid, starting it if needed; undefined when local. */
export async function spawnBrokerPidForTests(): Promise<number | undefined> {
  await brokerExecFile({
    file: "true",
    args: [],
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 1024,
    encoding: "utf8",
  });
  return broker?.child.pid;
}
