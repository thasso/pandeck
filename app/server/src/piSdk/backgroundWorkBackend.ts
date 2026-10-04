import {
  createBashTool,
  getShellConfig,
  type BashOperations,
  type BashToolInput,
} from "@earendil-works/pi-coding-agent";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import WebSocket, { type RawData } from "ws";
import type {
  BackgroundWorkActivity,
  BackgroundWorkBackendEvents,
  BackgroundWorkBackendPort,
  BackgroundWorkLaunchAck,
  BackgroundWorkLaunchRequest,
  BackgroundWorkStopAck,
  BackgroundWorkStopAllAck,
  BackgroundWorkStopAllRequest,
  BackgroundWorkStopRequest,
} from "../backgroundWork/backends.ts";
import { BoundedBackgroundMonitorBuffer } from "../backgroundWork/monitorBuffer.ts";
import { backgroundWorkSupervisor } from "../backgroundWork/supervisor.ts";
import { backgroundWorkIntentHint } from "../backgroundWork/intent.ts";
import {
  backgroundWorkDescription,
  backgroundWorkTitle,
} from "../backgroundWork/title.ts";
import {
  defineAgentTool,
  jsonResult,
  type AgentTool,
  type ToolResult,
  type ToolSession,
} from "../mcp/tool.ts";
import { captureTaskOutputArtifact } from "../outputPolicy.ts";
import { assertPublicHost } from "../publicNetwork.ts";
import { childProcessEnv, withChildProcessEnv } from "../subprocessEnv.ts";
import {
  PI_BACKGROUND_BASH_TOOL_DEFINITION,
  PI_MONITOR_TOOL_DEFINITION,
} from "./backgroundWorkToolDefinitions.ts";
import { piBinDir } from "./toolBinaries.ts";
import { releaseChildOomScore } from "../childOomScore.ts";

const ACTIVITY_MAX_LINES = 100;
const ACTIVITY_MAX_BYTES = 32 * 1024;
const SUMMARY_MAX_CHARS = 2_000;
const PROCESS_OUTPUT_FILE_MAX_BYTES = 1024 * 1024;
const PROCESS_OUTPUT_TAIL_BYTES = 32 * 1024;
// A monitor's events are lines, not clock ticks: the window exists only to group
// output that arrived together (a multi-line stack trace, a burst of CI results)
// into one notification, which is why it is short.
const ACTIVITY_COALESCE_MS = 200;
// Every notification is a provider turn, so an unfiltered monitor is expensive
// rather than merely noisy. Past this sustained rate the item is STOPPED and the
// agent told, because a monitor that quietly stops notifying while its process
// keeps running is indistinguishable from one that has nothing to report.
const ACTIVITY_RATE_WINDOW_MS = 60_000;
const ACTIVITY_RATE_MAX_PER_WINDOW = 20;

interface PiProcessEnvironment {
  sessionId: string;
  sessionFile?: string;
  provider?: string;
  model?: string;
  reasoningLevel?: string;
}

interface ProcessLaunch {
  type: "process";
  ownerSessionId: string;
  kind: "shell" | "monitor-command";
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSeconds?: number;
  shellPath?: string;
  commandPrefix?: string;
}

interface SocketLaunch {
  type: "socket";
  ownerSessionId: string;
  kind: "monitor-websocket";
  url: string;
  protocols?: string[];
}

type PendingLaunch = ProcessLaunch | SocketLaunch;

interface SocketLike {
  on(event: "message", listener: (data: RawData) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: () => void): this;
  close(): void;
}

interface RunningWork {
  ownerSessionId: string;
  stop(): void;
  done: Promise<void>;
  stopping: boolean;
}

interface ActivityTimer {
  cancel(): void;
}

interface PiBackgroundBackendDependencies {
  operations?: BashOperations;
  scheduleActivity?: (delayMs: number, callback: () => void) => ActivityTimer;
  createSocket?: (url: string, protocols?: string[]) => SocketLike;
  events?: BackgroundWorkBackendEvents;
  /** Drives the activity rate window only; the supervisor owns every deadline. */
  now?: () => number;
}

function killOwnedProcessGroup(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
    } catch {
      // The process already exited or taskkill is unavailable.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The exact process group is already gone.
    }
  }
}

function createSupervisedOperations(shellPath?: string): BashOperations {
  return {
    async exec(command, cwd, options) {
      if (options.signal?.aborted) throw new Error("aborted");
      const shellConfig = getShellConfig(shellPath);
      try {
        await fsAccess(cwd, constants.F_OK);
      } catch {
        throw new Error(
          `Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
        );
      }
      if (options.signal?.aborted) throw new Error("aborted");
      const commandFromStdin = shellConfig.commandTransport === "stdin";
      const child = spawn(
        shellConfig.shell,
        commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
        {
          cwd,
          detached: process.platform !== "win32",
          env: options.env,
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      if (commandFromStdin) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(command);
      }
      const pid = child.pid;
      releaseChildOomScore(pid);
      child.stdout?.on("data", options.onData);
      child.stderr?.on("data", options.onData);
      let timedOut = false;
      const stop = () => {
        if (pid) killOwnedProcessGroup(pid);
      };
      const timeout =
        options.timeout === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              stop();
            }, options.timeout * 1_000);
      timeout?.unref();
      if (options.signal?.aborted) stop();
      else options.signal?.addEventListener("abort", stop, { once: true });
      return new Promise<{ exitCode: number | null }>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, exitCode: number | null = null) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          options.signal?.removeEventListener("abort", stop);
          if (error) reject(error);
          else if (options.signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
          else resolve({ exitCode });
        };
        let exitCode: number | null = null;
        child.once("error", (error) => finish(error));
        child.once("exit", (code) => {
          exitCode = code;
          // A shell leader may exit while descendants remain in its detached
          // group. Reap that exact group before the item can terminalize.
          stop();
        });
        child.once("close", (code) => finish(undefined, code ?? exitCode));
      });
    },
  };
}

function withPiEnvironment(
  base: NodeJS.ProcessEnv,
  identity: PiProcessEnvironment,
): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_REASONING_LEVEL;
  env.PI_SESSION_ID = identity.sessionId;
  if (identity.sessionFile) env.PI_SESSION_FILE = identity.sessionFile;
  if (identity.provider) env.PI_PROVIDER = identity.provider;
  if (identity.model) env.PI_MODEL = identity.model;
  if (identity.reasoningLevel) env.PI_REASONING_LEVEL = identity.reasoningLevel;
  return env;
}

function piShellEnvironment(): NodeJS.ProcessEnv {
  const binDir = piBinDir();
  const env = childProcessEnv();
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const current = env[pathKey] ?? "";
  const entries = current.split(delimiter).filter(Boolean);
  return {
    ...env,
    [pathKey]: entries.includes(binDir)
      ? current
      : [binDir, current].filter(Boolean).join(delimiter),
  };
}

function bridgeResult(result: {
  content: ReadonlyArray<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  details?: unknown;
}): ToolResult {
  const content: ToolResult["content"] = [];
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string")
      content.push({ type: "text", text: block.text });
    else if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    )
      content.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
      });
  }
  return { content, details: result.details };
}

interface BackgroundOutputResult {
  eventCount: number;
  droppedEventCount: number;
  writerDroppedBytes: number;
  evidence: ReturnType<typeof captureTaskOutputArtifact>;
}

/**
 * Captures one item's output to a bounded file and, for a MONITOR only, turns it
 * into activity notifications.
 *
 * `streamsActivity` is the whole difference between the two kinds that share this
 * class. A monitor exists to report while it runs, so its lines are the awaited
 * result. A background shell command is awaited at its EXIT: its log is a tail
 * the agent reads if it wants to, and pushing it mid-flight buys nothing and
 * costs one provider turn per push. Both still capture the full output file.
 */
class BackgroundOutput {
  private readonly buffer = new BoundedBackgroundMonitorBuffer(
    ACTIVITY_MAX_LINES,
    ACTIVITY_MAX_BYTES,
  );
  private readonly decoder = new StringDecoder("utf8");
  private remainder = "";
  private activityTimer: ActivityTimer | undefined;
  private sequence = 0;
  private windowStartedAt: number | undefined;
  private windowCount = 0;
  private rateExceeded = false;
  private totalEventCount = 0;
  private droppedEventCount = 0;
  private closed = false;
  private finalResult: BackgroundOutputResult | undefined;
  private outputWriteFailed = false;
  private observedBytes = 0;
  private writtenBytes = 0;
  private writerDroppedBytes = 0;
  private tail = Buffer.alloc(0);
  private readonly root: string;
  private readonly outputPath: string;
  private readonly fd: number;

  constructor(
    private readonly itemId: string,
    private readonly ownerSessionId: string,
    private readonly events: BackgroundWorkBackendEvents,
    private readonly schedule: (
      delayMs: number,
      callback: () => void,
    ) => ActivityTimer,
    private readonly streamsActivity: boolean,
    private readonly now: () => number = Date.now,
  ) {
    this.root = mkdtempSync(join(tmpdir(), `pa-pi-${process.pid}-`));
    chmodSync(this.root, 0o700);
    this.outputPath = join(this.root, "output.log");
    this.fd = openSync(this.outputPath, "wx", 0o600);
  }

  push(value: Buffer | string): void {
    if (this.closed) return;
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    this.tail = Buffer.from(
      Buffer.concat([this.tail, data]).subarray(-PROCESS_OUTPUT_TAIL_BYTES),
    );
    this.observedBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.observedBytes + data.length,
    );
    const writable = Math.max(
      0,
      Math.min(data.length, PROCESS_OUTPUT_FILE_MAX_BYTES - this.writtenBytes),
    );
    let written = 0;
    if (writable > 0)
      try {
        written = writeSync(this.fd, data.subarray(0, writable));
        this.writtenBytes += written;
      } catch {
        this.outputWriteFailed = true;
      }
    this.writerDroppedBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.writerDroppedBytes + data.length - written,
    );
    const parts = `${this.remainder}${this.decoder.write(data)}`.split(/\r?\n/);
    this.remainder = parts.pop() ?? "";
    for (const line of parts) this.pushLine(line);
    if (Buffer.byteLength(this.remainder, "utf8") > ACTIVITY_MAX_BYTES) {
      this.pushLine(this.remainder);
      this.remainder = "";
    }
    this.scheduleActivity();
  }

  abandon(): void {
    if (this.closed) return;
    this.activityTimer?.cancel();
    this.closed = true;
    try {
      closeSync(this.fd);
    } catch {
      // Nothing was launched, so no evidence can refer to this file.
    }
    try {
      rmSync(this.root, { recursive: true, force: true });
    } catch {
      // The boot sweeper can reclaim a provably dead owner's tree.
    }
  }

  finish(): BackgroundOutputResult {
    if (this.finalResult) return this.finalResult;
    this.remainder += this.decoder.end();
    if (this.remainder) this.pushLine(this.remainder);
    this.remainder = "";
    this.activityTimer?.cancel();
    this.activityTimer = undefined;
    this.flushActivity(true);
    this.closed = true;
    const exceededHeadCap = this.observedBytes > this.writtenBytes;
    let omittedBytes = this.writerDroppedBytes;
    if (exceededHeadCap && !this.outputWriteFailed) {
      omittedBytes = Math.max(0, omittedBytes - this.tail.length);
      const marker = Buffer.from(
        `\n[... ${omittedBytes} byte(s) omitted at the 1 MiB capture cap; final 32 KiB follows ...]\n`,
      );
      try {
        if (writeSync(this.fd, marker) !== marker.length)
          this.outputWriteFailed = true;
        if (
          !this.outputWriteFailed &&
          writeSync(this.fd, this.tail) !== this.tail.length
        )
          this.outputWriteFailed = true;
      } catch {
        this.outputWriteFailed = true;
      }
      if (this.outputWriteFailed) omittedBytes = this.writerDroppedBytes;
    }
    try {
      closeSync(this.fd);
    } catch {
      this.outputWriteFailed = true;
    }
    const evidence = this.outputWriteFailed
      ? {
          capturedBytes: 0,
          text: false,
          truncated: false,
          refusalReason: "output-write-failed",
        }
      : captureTaskOutputArtifact({
          sessionId: this.ownerSessionId,
          outputFile: this.outputPath,
          trustedRoot: this.root,
          sourceTool: "pi background work",
          artifactLabel: "pi background work output",
        });
    try {
      rmSync(this.root, { recursive: true, force: true });
    } catch {
      // Artifact capture already copied or refused the output. Cleanup is best effort.
    }
    this.finalResult = {
      eventCount: this.totalEventCount,
      droppedEventCount: this.droppedEventCount,
      writerDroppedBytes: omittedBytes,
      evidence: exceededHeadCap
        ? {
            ...evidence,
            originalBytes: this.observedBytes,
            truncated: true,
          }
        : evidence,
    };
    return this.finalResult;
  }

  private pushLine(line: string): void {
    this.totalEventCount += 1;
    // Buffer only what can still be sent. A shell command's lines reach the agent
    // through the output file alone, and a rate-tripped monitor will never flush
    // again, so buffering either would hold bytes nobody reads and invent a
    // dropped-event count for a batch that was never going to leave.
    if (!this.streamsActivity || this.rateExceeded) return;
    this.buffer.push(line);
  }

  private scheduleActivity(): void {
    if (!this.streamsActivity || this.activityTimer || this.rateExceeded)
      return;
    this.activityTimer = this.schedule(ACTIVITY_COALESCE_MS, () => {
      this.activityTimer = undefined;
      this.flushActivity(false);
    });
  }

  private flushActivity(finishing: boolean): void {
    if (this.closed || !this.streamsActivity || this.rateExceeded) return;
    const batch = this.buffer.take();
    if (batch.lines.length === 0 && batch.droppedEventCount === 0) return;
    if (this.admitOneNotification()) {
      this.droppedEventCount += batch.droppedEventCount + batch.lines.length;
      // The item is on its way to a Stop, so this batch is the last thing it
      // would have said. Report the trip rather than the truncated batch.
      this.events.activityRateExceeded({
        itemId: this.itemId,
        eventId: `${this.itemId}:activity-rate:${this.sequence + 1}`,
        notificationCount: this.windowCount,
        windowMs: ACTIVITY_RATE_WINDOW_MS,
      });
      return;
    }
    this.sequence += 1;
    this.droppedEventCount += batch.droppedEventCount;
    const activity: BackgroundWorkActivity = {
      itemId: this.itemId,
      lines: batch.lines,
      bytes: batch.bytes,
      droppedEventCount: batch.droppedEventCount,
      eventId: `${this.itemId}:activity:${this.sequence}`,
    };
    this.events.activity(activity);
    if (!finishing) this.scheduleActivity();
  }

  /**
   * Count this notification against the sliding window. True means the window is
   * now over budget and nothing further may be sent.
   */
  private admitOneNotification(): boolean {
    const now = this.now();
    if (
      this.windowStartedAt === undefined ||
      now - this.windowStartedAt >= ACTIVITY_RATE_WINDOW_MS
    ) {
      this.windowStartedAt = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    if (this.windowCount <= ACTIVITY_RATE_MAX_PER_WINDOW) return false;
    this.rateExceeded = true;
    this.activityTimer?.cancel();
    this.activityTimer = undefined;
    return true;
  }
}

/** Process-local host-process port. State is isolated by PA item and owner. */
export class PiBackgroundWorkBackend implements BackgroundWorkBackendPort {
  readonly backend = "host-process" as const;
  private readonly pending = new Map<string, PendingLaunch>();
  private readonly running = new Map<string, RunningWork>();
  private readonly operations: BashOperations | undefined;
  private readonly scheduleActivity: (
    delayMs: number,
    callback: () => void,
  ) => ActivityTimer;
  private readonly createSocket: (
    url: string,
    protocols?: string[],
  ) => SocketLike;
  private readonly events: BackgroundWorkBackendEvents;
  private readonly now: () => number;

  constructor(deps: PiBackgroundBackendDependencies = {}) {
    this.operations = deps.operations;
    this.now = deps.now ?? Date.now;
    this.scheduleActivity =
      deps.scheduleActivity ??
      ((delayMs, callback) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return { cancel: () => clearTimeout(timer) };
      });
    this.createSocket =
      deps.createSocket ??
      ((url, protocols) =>
        protocols ? new WebSocket(url, protocols) : new WebSocket(url));
    this.events = deps.events ?? backgroundWorkSupervisor;
  }

  reserve(itemId: string, launch: PendingLaunch): void {
    if (this.pending.has(itemId) || this.running.has(itemId))
      throw new Error(`pi background item ${itemId} is already reserved`);
    this.pending.set(itemId, launch);
  }

  discard(itemId: string): void {
    this.pending.delete(itemId);
  }

  launch(
    request: BackgroundWorkLaunchRequest,
  ): Promise<BackgroundWorkLaunchAck> {
    const pending = this.pending.get(request.target.itemId);
    if (
      !pending ||
      pending.ownerSessionId !== request.target.ownerSessionId ||
      pending.kind !== request.target.kind
    )
      return Promise.resolve({
        launched: false,
        reason: "the pi launch reservation is no longer available",
      });
    this.pending.delete(request.target.itemId);
    return pending.type === "process"
      ? this.launchProcess(request.target.itemId, pending)
      : this.launchSocket(request.target.itemId, pending);
  }

  async stop(
    request: BackgroundWorkStopRequest,
  ): Promise<BackgroundWorkStopAck> {
    const work = this.running.get(request.target.itemId);
    if (!work || work.ownerSessionId !== request.target.ownerSessionId)
      return {
        acknowledged: false,
        evidence: "the owned process group or socket is unavailable",
      };
    work.stopping = true;
    work.stop();
    try {
      await work.done;
      return { acknowledged: true };
    } catch (error) {
      return {
        acknowledged: false,
        evidence:
          error instanceof Error ? error.message.slice(0, 500) : "Stop failed",
      };
    }
  }

  async stopAll(
    request: BackgroundWorkStopAllRequest,
  ): Promise<BackgroundWorkStopAllAck> {
    const targets = [...this.running.entries()].filter(
      ([, work]) => work.ownerSessionId === request.ownerSessionId,
    );
    const acknowledgedItemIds: string[] = [];
    const unconfirmedItemIds: string[] = [];
    await Promise.all(
      targets.map(async ([itemId, work]) => {
        work.stopping = true;
        work.stop();
        try {
          await work.done;
          acknowledgedItemIds.push(itemId);
        } catch {
          unconfirmedItemIds.push(itemId);
        }
      }),
    );
    return { acknowledgedItemIds, unconfirmedItemIds };
  }

  private launchProcess(
    itemId: string,
    launch: ProcessLaunch,
  ): Promise<BackgroundWorkLaunchAck> {
    const controller = new AbortController();
    const output = new BackgroundOutput(
      itemId,
      launch.ownerSessionId,
      this.events,
      this.scheduleActivity,
      launch.kind === "monitor-command",
      this.now,
    );
    const running: RunningWork = {
      ownerSessionId: launch.ownerSessionId,
      stop: () => controller.abort(),
      done: Promise.resolve(),
      stopping: false,
    };
    running.done = Promise.resolve()
      .then(() =>
        (this.operations ?? createSupervisedOperations(launch.shellPath)).exec(
          launch.commandPrefix
            ? `${launch.commandPrefix}\n${launch.command}`
            : launch.command,
          launch.cwd,
          {
            onData: (data) => output.push(data),
            signal: controller.signal,
            ...(launch.timeoutSeconds !== undefined
              ? { timeout: launch.timeoutSeconds }
              : {}),
            env: launch.env,
          },
        ),
      )
      .then(({ exitCode }) => {
        const result = this.finishOutput(itemId, output);
        if (running.stopping) return;
        this.events.completed({
          itemId,
          state: exitCode === 0 ? "completed" : "failed",
          ...(exitCode !== null ? { exitCode } : {}),
          outcomeSummary: humanSummary(processSummary(exitCode), result),
          eventId: `${itemId}:exit`,
        });
      })
      .catch((error) => {
        const result = this.finishOutput(itemId, output);
        if (running.stopping || controller.signal.aborted) return;
        this.events.completed({
          itemId,
          state: "failed",
          outcomeSummary: humanSummary(processErrorMessage(error), result),
          eventId: `${itemId}:error`,
        });
      })
      .finally(() => this.running.delete(itemId));
    this.running.set(itemId, running);
    return Promise.resolve({ launched: true });
  }

  private launchSocket(
    itemId: string,
    launch: SocketLaunch,
  ): Promise<BackgroundWorkLaunchAck> {
    const output = new BackgroundOutput(
      itemId,
      launch.ownerSessionId,
      this.events,
      this.scheduleActivity,
      true,
      this.now,
    );
    let socket: SocketLike;
    try {
      socket = this.createSocket(launch.url, launch.protocols);
    } catch (error) {
      output.abandon();
      return Promise.resolve({
        launched: false,
        reason:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "WebSocket launch failed",
      });
    }
    let settle!: () => void;
    const done = new Promise<void>((resolve) => (settle = resolve));
    const running: RunningWork = {
      ownerSessionId: launch.ownerSessionId,
      stop: () => socket.close(),
      done,
      stopping: false,
    };
    let ended = false;
    const finish = (error?: Error) => {
      if (ended) return;
      ended = true;
      const result = this.finishOutput(itemId, output);
      if (!running.stopping)
        this.events.completed({
          itemId,
          state: error ? "failed" : "completed",
          outcomeSummary: humanSummary(
            error ? error.message : "WebSocket closed",
            result,
          ),
          eventId: `${itemId}:${error ? "socket-error" : "socket-close"}`,
        });
      settle();
    };
    socket.on("message", (data) => output.push(rawData(data)));
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish());
    void done.finally(() => this.running.delete(itemId));
    this.running.set(itemId, running);
    return Promise.resolve({ launched: true });
  }

  private finishOutput(
    itemId: string,
    output: BackgroundOutput,
  ): ReturnType<BackgroundOutput["finish"]> {
    const result = output.finish();
    try {
      this.events.outputCaptured({
        itemId,
        eventId: `${itemId}:output`,
        evidence: result.evidence,
      });
    } catch (error) {
      console.warn(`[background] output evidence failed for ${itemId}:`, error);
    }
    return result;
  }
}

function rawData(data: RawData): Buffer | string {
  if (typeof data === "string" || Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * The outcome as a human reads it on the row and the card, with the capture
 * accounting appended only when something was LOST: a completed build says
 * "Exited with code 0", not how many events its writer counted. The sizes a
 * reader might want are already on the row as evidence facts.
 */
function humanSummary(
  outcome: string,
  result: ReturnType<BackgroundOutput["finish"]>,
): string {
  const lost: string[] = [];
  if (result.droppedEventCount > 0)
    lost.push(`${result.droppedEventCount} activity event(s) dropped`);
  if (result.writerDroppedBytes > 0)
    lost.push(
      `${result.writerDroppedBytes} output byte(s) dropped at the capture cap`,
    );
  return (
    lost.length > 0
      ? `${outcome.replace(/\.$/, "")} · ${lost.join(", ")}`
      : outcome
  ).slice(0, SUMMARY_MAX_CHARS);
}

function processSummary(exitCode: number | null): string {
  if (exitCode === 0) return "Exited with code 0";
  if (exitCode === null) return "Killed by a signal before it could exit";
  return `Exited with code ${exitCode}`;
}

function processErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "process failed";
  if (!message.startsWith("timeout:")) return message;
  return `Command timed out after ${message.slice("timeout:".length)} seconds`;
}

const piBackgroundWorkBackend = new PiBackgroundWorkBackend();
let registered = false;

function registerPiBackgroundWorkBackend(): void {
  if (registered) return;
  backgroundWorkSupervisor.registerBackend(piBackgroundWorkBackend);
  registered = true;
}

interface PiBackgroundToolsOptions {
  session(): ToolSession;
  identity(): PiProcessEnvironment;
  bashConfig?(): { shellPath?: string; commandPrefix?: string };
}

interface BackgroundBashInput extends BashToolInput, Record<string, unknown> {
  run_in_background?: boolean;
  /** A short human title for a BACKGROUND job; ignored for foreground calls. */
  description?: string;
}

interface MonitorInput extends Record<string, unknown> {
  description: string;
  timeout_ms: number;
  persistent: boolean;
  command?: string;
  ws?: { url: string; protocols?: string[] };
}

export function createPiBackgroundTools(
  options: PiBackgroundToolsOptions,
): AgentTool[] {
  registerPiBackgroundWorkBackend();
  const bash = defineAgentTool<BackgroundBashInput>({
    ...PI_BACKGROUND_BASH_TOOL_DEFINITION,
    async execute(params, ctx) {
      const session = options.session();
      const identity = options.identity();
      const bashConfig = options.bashConfig?.() ?? {};
      if (!params.run_in_background) {
        const upstream = createBashTool(session.cwd ?? process.cwd(), {
          exposeSessionEnvironment: false,
          ...(bashConfig.shellPath ? { shellPath: bashConfig.shellPath } : {}),
          ...(bashConfig.commandPrefix
            ? { commandPrefix: bashConfig.commandPrefix }
            : {}),
          spawnHook: (spawn) => ({
            ...spawn,
            env: withPiEnvironment(withChildProcessEnv(spawn.env), identity),
          }),
        });
        return bridgeResult(
          await upstream.execute(
            ctx.toolCallId,
            {
              command: params.command,
              ...(params.timeout !== undefined
                ? { timeout: params.timeout }
                : {}),
            },
            ctx.signal,
            ctx.progress
              ? (partial) => ctx.progress!(bridgeResult(partial))
              : undefined,
          ),
        );
      }
      validateBashTimeout(params.timeout);
      return admitProcess({
        session,
        identity,
        toolCallId: ctx.toolCallId,
        kind: "shell",
        label: backgroundWorkTitle({
          description: params.description,
          command: params.command,
          fallback: "Background shell command",
        }),
        description: params.description,
        command: params.command,
        ...bashConfig,
        ...(params.timeout !== undefined
          ? { timeoutSeconds: params.timeout }
          : {}),
      });
    },
  });

  const monitor = defineAgentTool<MonitorInput>({
    ...PI_MONITOR_TOOL_DEFINITION,
    async execute(params, ctx) {
      if (Boolean(params.command) === Boolean(params.ws))
        throw new Error("monitor requires exactly one of command or ws");
      if (!Number.isSafeInteger(params.timeout_ms) || params.timeout_ms <= 0)
        throw new Error("timeout_ms must be a positive safe integer");
      const session = options.session();
      if (params.command) {
        const bashConfig = options.bashConfig?.() ?? {};
        return admitProcess({
          session,
          identity: options.identity(),
          toolCallId: ctx.toolCallId,
          kind: "monitor-command",
          label: backgroundWorkTitle({
            description: params.description,
            command: params.command,
            fallback: "Command monitor",
          }),
          description: params.description,
          command: params.command,
          requestedLifetimeMs: params.timeout_ms,
          ...bashConfig,
        });
      }
      const ws = await validateMonitorWebSocket(params.ws!);
      return admitSocket({
        session,
        toolCallId: ctx.toolCallId,
        label: backgroundWorkTitle({
          description: params.description,
          command: ws.url,
          fallback: "WebSocket monitor",
        }),
        description: params.description,
        requestedLifetimeMs: params.timeout_ms,
        ws,
      });
    },
  });
  return [bash, monitor];
}

async function validateMonitorWebSocket(input: {
  url: string;
  protocols?: string[];
}): Promise<{ url: string; protocols?: string[] }> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("monitor.ws.url must be a valid ws:// or wss:// URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new Error("monitor.ws.url supports only ws:// and wss:// URLs");
  if (url.username || url.password)
    throw new Error("monitor.ws.url must not contain credentials");
  await assertPublicHost(url.hostname, "monitor");
  return {
    url: url.toString(),
    ...(input.protocols ? { protocols: input.protocols } : {}),
  };
}

function validateBashTimeout(timeout: number | undefined): void {
  if (timeout === undefined) return;
  const maxSeconds = 2_147_483_647 / 1_000;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error("Invalid timeout: must be a finite number of seconds");
  if (timeout > maxSeconds)
    throw new Error(`Invalid timeout: maximum is ${maxSeconds} seconds`);
}

async function admitProcess(input: {
  session: ToolSession;
  identity: PiProcessEnvironment;
  toolCallId: string;
  kind: "shell" | "monitor-command";
  label: string;
  description?: string | undefined;
  command: string;
  timeoutSeconds?: number;
  requestedLifetimeMs?: number;
  shellPath?: string;
  commandPrefix?: string;
}): Promise<ToolResult> {
  const description = backgroundWorkDescription(input.description);
  const admission = backgroundWorkSupervisor.admit({
    ownerSessionId: input.session.sessionId,
    backend: "host-process",
    kind: input.kind,
    label: input.label,
    ...(description ? { description } : {}),
    command: input.command,
    sourceRequestId: input.toolCallId,
    ...(input.requestedLifetimeMs !== undefined
      ? { requestedLifetimeMs: input.requestedLifetimeMs }
      : {}),
  });
  if (!admission.admitted)
    throw new Error(`Background work denied: ${admission.message}`);
  let state = admission.item.state;
  if (!admission.reused) {
    piBackgroundWorkBackend.reserve(admission.item.id, {
      type: "process",
      ownerSessionId: input.session.sessionId,
      kind: input.kind,
      command: input.command,
      cwd: input.session.cwd ?? process.cwd(),
      env: withPiEnvironment(piShellEnvironment(), input.identity),
      ...(input.shellPath ? { shellPath: input.shellPath } : {}),
      ...(input.commandPrefix ? { commandPrefix: input.commandPrefix } : {}),
      ...(input.timeoutSeconds !== undefined
        ? { timeoutSeconds: input.timeoutSeconds }
        : {}),
    });
    const launched = await backgroundWorkSupervisor.launch(admission);
    if (!launched || launched.state !== "running") {
      piBackgroundWorkBackend.discard(admission.item.id);
      throw new Error(launched?.outcomeSummary ?? "Background launch failed");
    }
    state = launched.state;
  }
  return jsonResult({
    taskId: admission.item.id,
    state,
    ...(admission.item.intent === "service"
      ? { intent: "service" }
      : { hint: backgroundWorkIntentHint(admission.item.id) }),
  });
}

async function admitSocket(input: {
  session: ToolSession;
  toolCallId: string;
  label: string;
  description?: string | undefined;
  requestedLifetimeMs: number;
  ws: { url: string; protocols?: string[] };
}): Promise<ToolResult> {
  const description = backgroundWorkDescription(input.description);
  const admission = backgroundWorkSupervisor.admit({
    ownerSessionId: input.session.sessionId,
    backend: "host-process",
    kind: "monitor-websocket",
    label: input.label,
    ...(description ? { description } : {}),
    command: input.ws.url,
    sourceRequestId: input.toolCallId,
    requestedLifetimeMs: input.requestedLifetimeMs,
  });
  if (!admission.admitted)
    throw new Error(`Background work denied: ${admission.message}`);
  let state = admission.item.state;
  if (!admission.reused) {
    piBackgroundWorkBackend.reserve(admission.item.id, {
      type: "socket",
      ownerSessionId: input.session.sessionId,
      kind: "monitor-websocket",
      url: input.ws.url,
      ...(input.ws.protocols ? { protocols: input.ws.protocols } : {}),
    });
    const launched = await backgroundWorkSupervisor.launch(admission);
    if (!launched || launched.state !== "running") {
      piBackgroundWorkBackend.discard(admission.item.id);
      throw new Error(
        launched?.outcomeSummary ?? "WebSocket monitor launch failed",
      );
    }
    state = launched.state;
  }
  return jsonResult({
    taskId: admission.item.id,
    state,
    ...(admission.item.intent === "service"
      ? { intent: "service" }
      : { hint: backgroundWorkIntentHint(admission.item.id) }),
  });
}
