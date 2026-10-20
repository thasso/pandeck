/**
 * Background work PA's own server runs (`server-task`): a tool's wait that
 * goes on after its call returned, such as a pull-request check watch.
 *
 * It is ordinary background work: admitted only through the supervisor, shown
 * in the Background tasks view, stopped by its owner or a human, bounded by a
 * frozen deadline, and announced through the existing completion delivery
 * with the job's final JSON result as its artifact. The job runs in THIS
 * process, so a restart ends it and nothing resumes it; what the owner hears
 * then is the store's retained restart receipt (`backgroundWorkStore.ts`).
 *
 * This module stays outside `backgroundWork/` and knows no provider: a tool
 * hands it a `run` closure that builds whatever client it needs from the
 * job's own signal, never the turn's.
 */
import type {
  BackgroundWorkKind,
  BackgroundWorkState,
} from "@assistant/shared";
import type {
  BackgroundWorkBackendEvents,
  BackgroundWorkBackendPort,
  BackgroundWorkLaunchAck,
  BackgroundWorkLaunchRequest,
  BackgroundWorkStopAck,
  BackgroundWorkStopAllAck,
  BackgroundWorkStopAllRequest,
  BackgroundWorkStopRequest,
} from "./backgroundWork/backends.ts";
import { backgroundWorkSupervisor } from "./backgroundWork/supervisor.ts";
import { backgroundWorkTitle } from "./backgroundWork/title.ts";
import { stageSessionArtifact } from "./mcp/toolGroups/packRuntime.ts";
import type { ToolCallContext } from "./mcp/tool.ts";

/**
 * How long before its frozen deadline a job's own timeout ends it. A job that
 * honours its budget therefore ends with its normal timeout result, and the
 * deadline Stop is only the backstop for one whose last provider call overran.
 */
export const SERVER_TASK_DEADLINE_MARGIN_MS = 60_000;

const SUMMARY_MAX_CHARS = 500;

/**
 * How long a Stop waits for an aborted job to unwind before it answers anyway.
 * A stopped job's result is discarded, so once its signal is aborted nothing it
 * does can reach the row; waiting longer would only leave a job that ignores
 * its signal `stop-unconfirmed`. Under the supervisor's acknowledgement
 * deadline.
 */
const STOP_GRACE_MS = 5_000;

/** The kinds a server task may be; widened by each piece that adds one. */
type ServerTaskKind = Extract<BackgroundWorkKind, "check-watch" | "image-pull">;

/** What a job gets to work with: its own signal and its frozen budget. */
export interface ServerTaskBudget {
  /** Aborted by a Stop, never by the turn that started the job. */
  signal: AbortSignal;
  /** The job's own timeout, already fitted inside its frozen lifetime. */
  timeoutMs: number;
  /** The frozen deadline, when the supervisor Stops a job that overran. */
  deadlineAt: number;
}

export interface ServerTaskResult {
  /** The final result, stored as the item's JSON artifact. */
  payload: unknown;
  /** One line for the row and the completion notice. */
  summary: string;
}

type ServerTaskRun = (budget: ServerTaskBudget) => Promise<ServerTaskResult>;

interface PendingServerTask {
  ownerSessionId: string;
  kind: ServerTaskKind;
  label: string;
  sourceTool: string;
  timeoutMs: number;
  deadlineAt: number;
  run: ServerTaskRun;
}

interface RunningServerTask {
  ownerSessionId: string;
  controller: AbortController;
  stopping: boolean;
  done: Promise<void>;
}

interface ServerTaskBackendDependencies {
  events?: BackgroundWorkBackendEvents;
  stageArtifact?: typeof stageSessionArtifact;
  stopGraceMs?: number;
}

function bounded(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SUMMARY_MAX_CHARS
    ? `${line.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : line;
}

function errorText(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error));
}

/** Abort one job and give it {@link STOP_GRACE_MS} to unwind. */
async function stopJob(
  work: RunningServerTask,
  reason: string,
  graceMs: number,
): Promise<void> {
  work.stopping = true;
  work.controller.abort(new Error(reason));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.done,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
}

/**
 * The `server-task` port. State is keyed by PA item id and every effect checks
 * the owner, so concurrent `stopAll` calls for distinct owners never touch
 * each other's jobs. No host epoch, so no `closeHost`.
 */
export class ServerTaskBackend implements BackgroundWorkBackendPort {
  readonly backend = "server-task" as const;
  private readonly pending = new Map<string, PendingServerTask>();
  private readonly running = new Map<string, RunningServerTask>();
  private readonly events: BackgroundWorkBackendEvents;
  private readonly stageArtifact: typeof stageSessionArtifact;
  private readonly stopGraceMs: number;

  constructor(deps: ServerTaskBackendDependencies = {}) {
    this.events = deps.events ?? backgroundWorkSupervisor;
    this.stageArtifact = deps.stageArtifact ?? stageSessionArtifact;
    this.stopGraceMs = deps.stopGraceMs ?? STOP_GRACE_MS;
  }

  reserve(itemId: string, task: PendingServerTask): void {
    if (this.pending.has(itemId) || this.running.has(itemId))
      throw new Error(`server task ${itemId} is already reserved`);
    this.pending.set(itemId, task);
  }

  discard(itemId: string): void {
    this.pending.delete(itemId);
  }

  launch(
    request: BackgroundWorkLaunchRequest,
  ): Promise<BackgroundWorkLaunchAck> {
    const itemId = request.target.itemId;
    const task = this.pending.get(itemId);
    if (
      !task ||
      task.ownerSessionId !== request.target.ownerSessionId ||
      task.kind !== request.target.kind
    )
      return Promise.resolve({
        launched: false,
        reason: "the server task reservation is no longer available",
      });
    this.pending.delete(itemId);
    const controller = new AbortController();
    const running: RunningServerTask = {
      ownerSessionId: task.ownerSessionId,
      controller,
      stopping: false,
      done: Promise.resolve(),
    };
    // A microtask later, so the supervisor marks the row running before the
    // job can report anything.
    running.done = Promise.resolve()
      .then(() =>
        task.run({
          signal: controller.signal,
          timeoutMs: task.timeoutMs,
          deadlineAt: task.deadlineAt,
        }),
      )
      .then(
        (result) => {
          // A stopped job reports nothing: the Stop terminalizes the row.
          if (running.stopping) return;
          this.finish(itemId, task, result);
        },
        (error: unknown) => {
          if (running.stopping || controller.signal.aborted) return;
          this.events.completed({
            itemId,
            state: "failed",
            outcomeSummary: errorText(error),
            eventId: `${itemId}:error`,
          });
        },
      )
      .catch((error: unknown) => {
        console.warn(
          `[background] server task ${itemId} could not report its end:`,
          errorText(error),
        );
      })
      .finally(() => this.running.delete(itemId));
    this.running.set(itemId, running);
    return Promise.resolve({ launched: true });
  }

  async stop(
    request: BackgroundWorkStopRequest,
  ): Promise<BackgroundWorkStopAck> {
    const work = this.running.get(request.target.itemId);
    if (!work || work.ownerSessionId !== request.target.ownerSessionId)
      return {
        acknowledged: false,
        evidence: "the server task is not running in this process",
      };
    await stopJob(work, request.reason, this.stopGraceMs);
    return { acknowledged: true };
  }

  async stopAll(
    request: BackgroundWorkStopAllRequest,
  ): Promise<BackgroundWorkStopAllAck> {
    const reserved = new Set(request.itemIds);
    const targets = [...this.running.entries()].filter(
      ([itemId, work]) =>
        reserved.has(itemId) && work.ownerSessionId === request.ownerSessionId,
    );
    await Promise.all(
      targets.map(([, work]) =>
        stopJob(work, request.reason, this.stopGraceMs),
      ),
    );
    return {
      acknowledgedItemIds: targets.map(([itemId]) => itemId),
      unconfirmedItemIds: [],
    };
  }

  /** Store the result as the item's artifact, then report the end. */
  private finish(
    itemId: string,
    task: PendingServerTask,
    result: ServerTaskResult,
  ): void {
    const text = JSON.stringify(result.payload, null, 2);
    const bytes = new TextEncoder().encode(text);
    let evidence;
    try {
      const artifact = this.stageArtifact(task.ownerSessionId, {
        name: `${task.kind}-result.json`,
        mimeType: "application/json",
        kind: "file",
        label: `${task.label} result`,
        sourceTool: task.sourceTool,
        bytes,
      });
      evidence = {
        artifactId: artifact.id,
        originalBytes: bytes.byteLength,
        capturedBytes: bytes.byteLength,
        truncated: false,
        text: true,
      };
    } catch (error) {
      console.warn(
        `[background] server task ${itemId} result was not kept:`,
        errorText(error),
      );
      evidence = { refusalReason: "artifact-write-failed" };
    }
    this.events.outputCaptured({
      itemId,
      eventId: `${itemId}:output`,
      evidence,
    });
    this.events.completed({
      itemId,
      state: "completed",
      outcomeSummary: bounded(result.summary),
      eventId: `${itemId}:result`,
    });
  }
}

const serverTaskBackend = new ServerTaskBackend();
let registered = false;

/**
 * Registered on first use. Nothing needs the port earlier: boot ends every
 * server task an earlier process left before any tool can run.
 */
function ensureServerTaskBackend(): void {
  if (registered) return;
  backgroundWorkSupervisor.registerBackend(serverTaskBackend);
  registered = true;
}

export interface ServerTaskLaunch {
  ctx: Pick<ToolCallContext, "session" | "toolCallId">;
  kind: ServerTaskKind;
  /** Human title for the row; bounded here. */
  label: string;
  description?: string;
  /** Display text for the row, e.g. the tool and its target. */
  command: string;
  /** The tool the result artifact is attributed to. */
  sourceTool: string;
  /** What the caller asked for; the frozen lifetime may shorten it. */
  requestedTimeoutMs: number;
  run: ServerTaskRun;
}

export interface ServerTaskStarted {
  taskId: string;
  state: BackgroundWorkState;
  hint: string;
}

/**
 * Admit a server task for the calling session and start it. The lifetime asked
 * for is the timeout plus {@link SERVER_TASK_DEADLINE_MARGIN_MS}; whatever the
 * Settings cap leaves, the job's timeout is that minus the margin, so the job
 * ends itself before its deadline Stop. A retried tool call answers with the
 * task it already started. A refusal throws `Background work denied: …`.
 */
export async function launchServerTask(
  input: ServerTaskLaunch,
): Promise<ServerTaskStarted> {
  ensureServerTaskBackend();
  const ownerSessionId = input.ctx.session.sessionId;
  const label = backgroundWorkTitle({
    description: input.label,
    fallback: "Server task",
  });
  const admission = backgroundWorkSupervisor.admit({
    ownerSessionId,
    backend: "server-task",
    kind: input.kind,
    label,
    ...(input.description ? { description: input.description } : {}),
    command: input.command,
    sourceRequestId: input.ctx.toolCallId,
    requestedLifetimeMs:
      input.requestedTimeoutMs + SERVER_TASK_DEADLINE_MARGIN_MS,
  });
  if (!admission.admitted)
    throw new Error(`Background work denied: ${admission.message}`);
  const taskId = admission.item.id;
  if (admission.reused)
    return { taskId, state: admission.item.state, hint: hintFor(taskId) };
  serverTaskBackend.reserve(taskId, {
    ownerSessionId,
    kind: input.kind,
    label,
    sourceTool: input.sourceTool,
    timeoutMs: Math.max(
      0,
      Math.min(
        input.requestedTimeoutMs,
        admission.frozen.lifetimeMs - SERVER_TASK_DEADLINE_MARGIN_MS,
      ),
    ),
    deadlineAt: admission.frozen.deadlineAt,
    run: input.run,
  });
  const launched = await backgroundWorkSupervisor.launch(admission);
  if (!launched || launched.state !== "running") {
    serverTaskBackend.discard(taskId);
    throw new Error(launched?.outcomeSummary ?? "Server task launch failed");
  }
  return { taskId, state: launched.state, hint: hintFor(taskId) };
}

function hintFor(taskId: string): string {
  return `PA background task ${taskId} is waiting in the background. Its result arrives automatically when it ends; stop it with background_tasks operation stop.`;
}
