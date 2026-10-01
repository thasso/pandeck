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
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { runInThisContext } from "node:vm";

/** Creates `handle(message)`; replies go to `send`. Plain JS by design. */
const HANDLER_SOURCE = String.raw`(function createSpawnHandler(require, send) {
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

  function errorOf(err) {
    const code = err && err.code;
    return {
      code: typeof code === "number" || typeof code === "string" ? code : null,
      message: String((err && err.message) || err),
    };
  }

  function exec(m) {
    const controller = new AbortController();
    running.set(m.id, () => controller.abort());
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
          running.delete(m.id);
          send({
            id: m.id,
            error: err ? errorOf(err) : null,
            stdout: buffer ? Buffer.from(stdout || "").toString("base64") : stdout || "",
            stderr: buffer ? Buffer.from(stderr || "").toString("utf8") : stderr || "",
          });
        },
      );
    } catch (err) {
      running.delete(m.id);
      send({ id: m.id, error: errorOf(err), stdout: "", stderr: "" });
      return;
    }
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
    const finish = (reply) => {
      if (done) return;
      done = true;
      running.delete(m.id);
      send(Object.assign({ id: m.id, patch, totalChars, stderr, aborted }, reply));
    };
    let child;
    try {
      child = spawn(m.file, m.args, {
        cwd: m.cwd,
        env: m.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ spawnError: errorOf(err).message, code: null });
      return;
    }
    release(child);
    running.set(m.id, () => {
      aborted = true;
      child.kill("SIGTERM");
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
    // Reached it, outcome unknown.
    for (const entry of state.pending.values())
      entry.fail(new Error("The process broker exited before answering."));
    state.pending.clear();
  };
  child.once("exit", onGone);
  child.once("error", onGone);
  child.stdin?.on("error", () => undefined);
  setRef(child, false);
  return state;
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
