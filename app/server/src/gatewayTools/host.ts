/**
 * The edge's tool host (Task-1397): lists the registered tools and runs one
 * call for one client. MCP (`mcp.ts`) is one adapter over it; gateway client
 * 1.x's `tools.*` (`gateway/clientListener.ts`, Task-1398) is the other.
 *
 * A client connection never runs a write in one call (Task-1463 P6a):
 * `callForClient`, which only `clientListener.ts` uses, refuses a write tool
 * with `TWO_PHASE_ONLY` before any credential read, and the write tools run
 * there as `prepare` and `apply` (`twoPhase.ts`). `/mcp` keeps `call`. No
 * request argument chooses the path. `prepare` and `apply` never throw;
 * their log lines carry the registry's tool name, never request content.
 *
 * `call` never throws and settles by its deadline (the tool's own, else the
 * host's, 30 s by default) or the caller's abort, whatever an await inside the
 * tool ignores. It answers the tool's JSON or a fixed failure: only
 * `ToolError` text passes, every other error's message is dropped unread and
 * unlogged. A write tool's timeout, cancel, failure and oversized result say
 * that changes may have been applied (Task-1463); a read tool's texts stay as
 * they were.
 *
 * A file-capable tool (Task-1441 P7a, `file` on its descriptor) runs only
 * through `run`'s file path, for a caller with `onSettled`. A call holds the
 * edge's one file permit (`FileBudget`) from before the credential read
 * until both its execution and its answer's output have settled, never on a
 * timer; a second call meanwhile answers `FILE_BUSY` and sends nothing. The
 * answer carries the bytes with their size and SHA-256.
 *
 * A client-mode upload (Task-1441 P8a) shares that permit: the upload store
 * (`uploads.ts`) reserves from the same `FileBudget`, so a download and an
 * upload never overlap and the second answers the transfer-neutral busy text.
 * `prepare` takes the declared sources only as a host option, and `apply`
 * consumes the connection's sealed upload synchronously before its timer is
 * armed, which then runs to the upload deadline.
 */
import { createHash } from "node:crypto";
import {
  FileResult,
  ToolError,
  abortError,
  raceAbort,
  type AtlassianToolDescriptor,
  type FileSpec,
  type ObjectSchema,
  type ToolDescriptor,
  type TwoPhaseTool,
} from "./descriptor.ts";
import {
  atlassianCredentialFor,
  slackCredentialFor,
  type CredentialSource,
} from "./toolCredential.ts";
import { checkArguments } from "./schema.ts";
import {
  uploadApplyDeadlineMs,
  type AttachedUpload,
  type UploadEntry,
  type UploadScope,
} from "./uploads.ts";
import {
  ITEMS_INVALID,
  PREPARE_DEADLINE_MS,
  TWO_PHASE_ONLY,
  applyAnswerWithinCap,
  createWriteLedger,
  prepareAnswerWithinCap,
  type ApplyAnswer,
  type ApplyRequest,
  type PrepareAnswer,
} from "./twoPhase.ts";

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_MAX_RESULT_CHARS = 60_000;

export interface ToolCaller extends CredentialSource {
  /** The calling client, from the registry; only logged. */
  clientId: string;
  /** Aborts when the caller goes away. */
  signal?: AbortSignal;
  /**
   * Registers `fn` to run once this call's answer has left the edge or can
   * no longer be written (Task-1441 P7a, H1): the connection's
   * `MethodContext.onSettled`. A file-capable tool runs only for a caller
   * that has it.
   */
  onSettled?: (fn: () => void) => void;
}

export type ToolFailureCode =
  | "unknown_tool"
  | "invalid_params"
  | "tool_error"
  | "result_too_large"
  | "timeout"
  | "cancelled"
  | "failed";

/** A file answer's file: what the wire's JSON names, and the bytes. */
interface AnswerFile {
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  bytes: Uint8Array;
}

type ToolAnswer =
  | { ok: true; text: string; file?: AnswerFile }
  | { ok: false; code: ToolFailureCode; message: string };

interface ListedTool {
  name: string;
  description: string;
  inputSchema: ObjectSchema;
  effect: "read" | "write";
  actionKey: string;
  /** Run as `tools.prepare` and `tools.apply` on a client connection. */
  twoPhase?: true;
  /** File-capable: its limit argument, default and cap (Task-1441 P7a). */
  file?: FileSpec;
}

export interface ToolHost {
  list(): ListedTool[];
  /** `/mcp`'s one call, a write included. */
  call(name: string, args: unknown, caller: ToolCaller): Promise<ToolAnswer>;
  /** A client's `tools.call`: a write tool is refused, unread and unsent. */
  callForClient(
    name: string,
    args: unknown,
    caller: ToolCaller,
  ): Promise<ToolAnswer>;
  prepare(
    name: string,
    args: unknown,
    caller: ToolCaller,
    options?: PrepareOptions,
  ): Promise<PrepareAnswer>;
  apply(
    name: string,
    request: ApplyRequest,
    caller: ToolCaller,
    options?: ApplyOptions,
  ): Promise<ApplyAnswer>;
}

/** `prepare`'s host option: the upload sources a client declared (v09 P1(b)). */
interface PrepareOptions {
  uploads?: readonly UploadEntry[];
}

/**
 * `apply`'s host option: the connection's upload this apply names (v09
 * P1(c), v10 S1). It needs `caller.onSettled`, which carries the output hold.
 */
interface ApplyOptions {
  upload?: { id: string; scope: UploadScope };
}

export const NO_SUCH_TOOL = "No such tool.";
const PREPARE_TIMEOUT =
  "Preparing the changes took too long; nothing was written. Send fewer items.";
const PREPARE_CANCELLED = "The call was cancelled; nothing was written.";
const prepareFailed = (tool: ToolDescriptor) =>
  `${tool.name} could not prepare the changes; nothing was written.`;

export interface ToolHostOptions {
  deadlineMs?: number;
  log?: (line: string) => void;
  /** The edge process's file budget; one per host unless given. */
  fileBudget?: FileBudget;
}

/** The edge's file memory: one live reservation at most (OD-7a1). */
const FILE_MEMORY_BUDGET = 210 * 1024 * 1024;
const FILE_RESERVE_OVERHEAD = 2 * 1024 * 1024;
/** How long after a timeout or cancel an unsettled file call is logged. */
const FILE_NOT_SETTLED_LOG_MS = 30_000;
/** Longest file name and MIME type a file answer carries (G4). */
const FILE_NAME_MAX_CHARS = 1024;
const FILE_MIME_MAX_CHARS = 1024;

/** Transfer-neutral: an upload holds the same permit (Task-1441 P8a, v10 S3). */
export const FILE_BUSY =
  "The gateway is already transferring a file; try again when it finishes. Nothing was downloaded.";
/** P7A-R2: a file call whose answer's departure nobody reports. */
const FILE_NEEDS_OUTPUT =
  "This tool can only be called over a gateway client connection.";
const fileTooLarge = (spec: FileSpec, limit: number) =>
  `The file is larger than the ${limit}-byte limit; nothing was saved. Raise ${spec.limitParam} (at most ${spec.maxBytes}) to fetch it.`;

/**
 * The edge process's file permit (Task-1441 P7a, G7): one reservation at a
 * time, never queued. `reserve` answers the release, callable once, or
 * nothing when a reservation is held or `bytes` does not fit.
 */
export interface FileBudget {
  reserve(bytes: number): (() => void) | undefined;
  /** Bytes reserved now; a counter, not memory. */
  readonly reserved: number;
}

export function createFileBudget(capacity = FILE_MEMORY_BUDGET): FileBudget {
  let reserved = 0;
  return {
    reserve(bytes) {
      if (reserved > 0 || bytes > capacity) return undefined;
      reserved = bytes;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        reserved = 0;
      };
    },
    get reserved() {
      return reserved;
    },
  };
}

/** The local tools' `clamp`: non-finite → `fallback`, else truncated. */
function clampTrunc(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** A file call's effective limit E from its arguments (H3). */
export function effectiveFileLimit(
  spec: FileSpec,
  params: Record<string, unknown>,
): number {
  return Math.min(
    spec.maxBytes,
    clampTrunc(params[spec.limitParam], spec.defaultBytes, 1, spec.maxBytes),
  );
}

/** Refuses at construction a `file` the file path cannot run (J3). */
function checkFileSpec(tool: ToolDescriptor): void {
  const spec = tool.file;
  if (!spec) return;
  const fail = (why: string) => {
    throw new Error(`file tool ${tool.name}: ${why}`);
  };
  if (tool.effect !== "read") fail("a file tool is a read");
  if (tool.integration === "atlassian" && tool.phases)
    fail("a file tool has no phases");
  if (!Number.isSafeInteger(spec.maxBytes) || spec.maxBytes < 1)
    fail("maxBytes is a positive integer");
  if (
    !Number.isSafeInteger(spec.defaultBytes) ||
    spec.defaultBytes < 1 ||
    spec.defaultBytes > spec.maxBytes
  )
    fail("defaultBytes is within [1, maxBytes]");
  const limitParam = tool.inputSchema.properties[spec.limitParam];
  if (limitParam?.type !== "number" && limitParam?.type !== "integer")
    fail("limitParam names a number argument");
}

/** The deadline one call of `tool` runs under. */
export function effectiveDeadlineMs(
  tool: Pick<ToolDescriptor, "deadlineMs">,
  hostDeadlineMs?: number,
): number {
  return tool.deadlineMs ?? hostDeadlineMs ?? DEFAULT_DEADLINE_MS;
}

/** The longest deadline any call of these tools can run under. */
export function longestDeadlineMs(
  tools: readonly Pick<ToolDescriptor, "deadlineMs">[],
  hostDeadlineMs?: number,
): number {
  return Math.max(
    hostDeadlineMs ?? DEFAULT_DEADLINE_MS,
    ...tools.map((tool) => effectiveDeadlineMs(tool, hostDeadlineMs)),
  );
}

/** A failure's fixed text, by the tool's effect. */
function failureText(
  tool: ToolDescriptor,
  code: "timeout" | "cancelled" | "failed" | "result_too_large",
): string {
  if (tool.effect === "write")
    switch (code) {
      case "timeout":
        return "The tool timed out; some changes may have been applied, so check before retrying.";
      case "cancelled":
        return "The call was cancelled; some changes may have been applied, so check before retrying.";
      case "failed":
        return `${tool.name} failed; some changes may have been applied, so check before retrying.`;
      case "result_too_large":
        return "The tool's result is too large; the changes may have been applied, so check before retrying.";
    }
  switch (code) {
    case "timeout":
      return "The tool timed out.";
    case "cancelled":
      return "The call was cancelled.";
    case "failed":
      return `${tool.name} failed.`;
    case "result_too_large":
      return "The tool's result is too large.";
  }
}

export function createToolHost(
  tools: readonly ToolDescriptor[],
  options: ToolHostOptions = {},
): ToolHost {
  const log = options.log ?? ((line: string) => console.log(`[tools] ${line}`));
  for (const tool of tools) checkFileSpec(tool);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const fileBudget = options.fileBudget ?? createFileBudget();

  const run = async (
    tool: ToolDescriptor,
    args: unknown,
    caller: ToolCaller,
  ): Promise<ToolAnswer> => {
    const checked = checkArguments(tool.inputSchema, args);
    if (!checked.ok)
      return { ok: false, code: "invalid_params", message: checked.message };
    let file: FilePermit | undefined;
    if (tool.file) {
      // P7A-R2: without the output seam the permit could never be released.
      if (!caller.onSettled)
        return { ok: false, code: "failed", message: FILE_NEEDS_OUTPUT };
      const limit = effectiveFileLimit(tool.file, checked.params);
      // Before the credential read, so before any upstream request.
      const release = fileBudget.reserve(2 * limit + FILE_RESERVE_OVERHEAD);
      if (!release)
        return { ok: false, code: "tool_error", message: FILE_BUSY };
      file = filePermit(tool, caller, limit, release);
    }
    const answer = await runCall(tool, checked.params, caller, file);
    file?.answered(answer);
    return answer;
  };

  /**
   * A file call's permit and its two holds (H1): released exactly once, when
   * the execution and the answer's output have both settled.
   */
  interface FilePermit {
    limit: number;
    /** The tool's own execution promise: the execution hold. */
    executing(pending: Promise<unknown>): void;
    answered(answer: ToolAnswer): void;
  }

  const filePermit = (
    tool: ToolDescriptor,
    caller: ToolCaller,
    limit: number,
    release: () => void,
  ): FilePermit => {
    let execution = false;
    let output = false;
    let stuck: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (!execution || !output) return;
      clearTimeout(stuck);
      release();
    };
    caller.onSettled!(() => {
      output = true;
      settle();
    });
    return {
      limit,
      executing(pending) {
        const done = () => {
          execution = true;
          settle();
        };
        pending.then(done, done);
      },
      answered(answer) {
        if (execution || answer.ok) return;
        if (answer.code !== "timeout" && answer.code !== "cancelled") return;
        stuck = setTimeout(() => {
          if (!execution)
            log(
              `file call not settled after abort: ${tool.name} client ${caller.clientId}`,
            );
        }, FILE_NOT_SETTLED_LOG_MS);
        stuck.unref?.();
      },
    };
  };

  /** A result's answer: plain JSON, or a file tool's `FileResult`. */
  const answerOf = (
    tool: ToolDescriptor,
    result: unknown,
    file: FilePermit | undefined,
  ): ToolAnswer => {
    const maxChars = tool.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
    const tooLarge: ToolAnswer = {
      ok: false,
      code: "result_too_large",
      message: failureText(tool, "result_too_large"),
    };
    if (!(result instanceof FileResult)) {
      const text = JSON.stringify(result ?? null);
      return text.length > maxChars ? tooLarge : { ok: true, text };
    }
    const failed: ToolAnswer = {
      ok: false,
      code: "failed",
      message: failureText(tool, "failed"),
    };
    // Only a descriptor that declares `file` may answer one (H3).
    if (!file || !tool.file) return failed;
    const { name, mimeType, bytes } = result.file;
    if (
      !(bytes instanceof Uint8Array) ||
      typeof name !== "string" ||
      name.length < 1 ||
      name.length > FILE_NAME_MAX_CHARS ||
      typeof mimeType !== "string" ||
      mimeType.length > FILE_MIME_MAX_CHARS
    )
      return failed;
    if (bytes.byteLength > file.limit)
      return {
        ok: false,
        code: "tool_error",
        message: fileTooLarge(tool.file, file.limit),
      };
    const text = JSON.stringify(result.json ?? null);
    if (text.length > maxChars) return tooLarge;
    return {
      ok: true,
      text,
      file: {
        name,
        mimeType,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes,
      },
    };
  };

  const runCall = async (
    tool: ToolDescriptor,
    params: Record<string, unknown>,
    caller: ToolCaller,
    file: FilePermit | undefined,
  ): Promise<ToolAnswer> => {
    const deadline = new AbortController();
    const deadlineMs = effectiveDeadlineMs(tool, options.deadlineMs);
    const deadlineAt = Date.now() + deadlineMs;
    const timer = setTimeout(() => deadline.abort(), deadlineMs);
    const signal = caller.signal
      ? AbortSignal.any([caller.signal, deadline.signal])
      : deadline.signal;
    const fileLimit = file ? { maxFileBytes: file.limit } : {};
    try {
      const executing = Promise.resolve().then(() => {
        if (signal.aborted) throw abortError();
        // Narrowed per integration: each execute gets its own credential.
        switch (tool.integration) {
          case "atlassian":
            return tool.execute(params, {
              signal,
              deadlineAt,
              ...fileLimit,
              credential: () => atlassianCredentialFor(caller, signal),
            });
          case "slack":
            return tool.execute(params, {
              signal,
              deadlineAt,
              ...fileLimit,
              credential: () => slackCredentialFor(caller, signal),
            });
          default: {
            const never: never = tool;
            return never;
          }
        }
      });
      // H1: the execution hold is the tool's own promise, not the race.
      file?.executing(executing);
      return answerOf(tool, await raceAbort(executing, signal), file);
    } catch (err) {
      // By which signal aborted, never by error text.
      if (deadline.signal.aborted)
        return {
          ok: false,
          code: "timeout",
          message: failureText(tool, "timeout"),
        };
      if (signal.aborted)
        return {
          ok: false,
          code: "cancelled",
          message: failureText(tool, "cancelled"),
        };
      if (err instanceof ToolError)
        return { ok: false, code: "tool_error", message: err.message };
      return {
        ok: false,
        code: "failed",
        message: failureText(tool, "failed"),
      };
    } finally {
      clearTimeout(timer);
    }
  };

  /** The two-phase tool named `name`, from the registry. */
  const twoPhaseTool = (
    name: string,
  ): (AtlassianToolDescriptor & { phases: TwoPhaseTool }) | undefined => {
    const tool = byName.get(name);
    return tool?.integration === "atlassian" && tool.phases
      ? (tool as AtlassianToolDescriptor & { phases: TwoPhaseTool })
      : undefined;
  };

  const runPrepare = async (
    tool: AtlassianToolDescriptor & { phases: TwoPhaseTool },
    args: unknown,
    caller: ToolCaller,
    uploads: readonly UploadEntry[] | undefined,
  ): Promise<PrepareAnswer> => {
    const checked = checkArguments(tool.inputSchema, args);
    if (!checked.ok)
      return { ok: false, code: "invalid_params", message: checked.message };
    const deadline = new AbortController();
    const deadlineAt = Date.now() + PREPARE_DEADLINE_MS;
    const timer = setTimeout(() => deadline.abort(), PREPARE_DEADLINE_MS);
    const signal = caller.signal
      ? AbortSignal.any([caller.signal, deadline.signal])
      : deadline.signal;
    try {
      const proposal = await raceAbort(
        Promise.resolve().then(() => {
          if (signal.aborted) throw abortError();
          return tool.phases.prepare(checked.params, {
            signal,
            deadlineAt,
            credential: () => atlassianCredentialFor(caller, signal),
            ...(uploads
              ? {
                  uploads: new Map(
                    uploads.map((entry) => [entry.stagedAttachmentId, entry]),
                  ),
                }
              : {}),
          });
        }),
        signal,
      );
      return prepareAnswerWithinCap({ ok: true, ...proposal });
    } catch (err) {
      if (deadline.signal.aborted)
        return { ok: false, code: "timeout", message: PREPARE_TIMEOUT };
      if (signal.aborted)
        return { ok: false, code: "cancelled", message: PREPARE_CANCELLED };
      if (err instanceof ToolError)
        return { ok: false, code: err.code, message: err.message };
      return { ok: false, code: "failed", message: prepareFailed(tool) };
    } finally {
      clearTimeout(timer);
    }
  };

  const runApply = async (
    tool: AtlassianToolDescriptor & { phases: TwoPhaseTool },
    request: ApplyRequest,
    caller: ToolCaller,
    upload?: AttachedUpload,
  ): Promise<ApplyAnswer> => {
    // The request signal is the deadline's alone; the caller's only stops.
    const ledger = createWriteLedger();
    const deadline = new AbortController();
    // An upload's deadline grows with its bytes (v08 N1), fixed here, at
    // admission, before the timer is armed.
    const baseMs = effectiveDeadlineMs(tool, options.deadlineMs);
    const deadlineMs = upload
      ? uploadApplyDeadlineMs(upload.work, baseMs)
      : baseMs;
    const deadlineAt = Date.now() + deadlineMs;
    const timer = setTimeout(() => deadline.abort(), deadlineMs);
    const { signal } = deadline;
    try {
      const executing = Promise.resolve().then(() => {
        if (signal.aborted) throw abortError();
        return tool.phases.apply(request, {
          signal,
          deadlineAt,
          cancel: caller.signal ?? new AbortController().signal,
          ledger,
          credential: () => atlassianCredentialFor(caller, signal),
          ...(upload ? { upload } : {}),
        });
      });
      // The execution hold: the tool's own promise, not the race below,
      // which a deadline settles while a request may still be running.
      if (upload) {
        const settled = () => upload.executionSettled();
        executing.then(settled, settled);
      }
      return await raceAbort(executing, signal);
    } catch (err) {
      // Whatever ended the call, the ledger says what may have been written
      // and, once the apply began, what the working copy shows (AC14).
      if (signal.aborted)
        return ledger.failed({
          ok: false,
          code: "timeout",
          message: failureText(tool, "timeout"),
        });
      if (err instanceof ToolError)
        return ledger.failed({
          ok: false,
          code: err.code,
          message: err.message,
        });
      return ledger.failed({
        ok: false,
        code: "failed",
        message: failureText(tool, "failed"),
      });
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * v09 P1(c) steps 2-3, synchronous: no await may come between this and
   * `runApply` arming its timer. Without the output seam nothing could
   * release the upload, so it is refused unconsumed (P4); otherwise the
   * scope's `consume` attaches it or discards it, and its output hold is
   * registered at once either way.
   */
  const consumeUpload = (
    applyOptions: ApplyOptions | undefined,
    request: ApplyRequest,
    caller: ToolCaller,
  ): { upload?: AttachedUpload } | { refused: ApplyAnswer } => {
    const named = applyOptions?.upload;
    if (!named) return {};
    const refused = (message: string) => ({
      refused: {
        ok: false as const,
        code: "invalid_params" as const,
        message,
        effects: "none" as const,
      },
    });
    if (!caller.onSettled) return refused(ITEMS_INVALID);
    const consumed = named.scope.consume(named.id, request.items);
    caller.onSettled(consumed.outputSettled);
    return consumed.ok
      ? { upload: consumed.upload }
      : refused(consumed.message);
  };

  const logged = (
    name: string | undefined,
    phase: string,
    caller: ToolCaller,
    started: number,
    answer: { ok: boolean; code?: string },
  ) =>
    log(
      `tool ${name ?? "(unknown)"}${phase} client ${caller.clientId} ${answer.ok ? "ok" : answer.code} ${Date.now() - started}ms`,
    );

  const call: ToolHost["call"] = async (name, args, caller) => {
    const started = Date.now();
    const tool = byName.get(name);
    const answer: ToolAnswer = tool
      ? await run(tool, args, caller).catch((): ToolAnswer => ({
          ok: false,
          code: "failed",
          message: failureText(tool, "failed"),
        }))
      : { ok: false, code: "unknown_tool", message: NO_SUCH_TOOL };
    // The tool name only from the registry: a request's string is not logged.
    logged(tool?.name, "", caller, started, answer);
    return answer;
  };

  return {
    list: () =>
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        effect: tool.effect,
        actionKey: tool.actionKey,
        ...(tool.integration === "atlassian" && tool.phases
          ? { twoPhase: true as const }
          : {}),
        ...(tool.file
          ? {
              file: {
                limitParam: tool.file.limitParam,
                defaultBytes: tool.file.defaultBytes,
                maxBytes: tool.file.maxBytes,
              },
            }
          : {}),
      })),
    call,
    async callForClient(name, args, caller) {
      const tool = byName.get(name);
      if (tool?.effect !== "write") return call(name, args, caller);
      const answer: ToolAnswer = {
        ok: false,
        code: "invalid_params",
        message: TWO_PHASE_ONLY,
      };
      logged(tool.name, "", caller, Date.now(), answer);
      return answer;
    },
    async prepare(name, args, caller, prepareOptions) {
      const started = Date.now();
      const tool = twoPhaseTool(name);
      const answer: PrepareAnswer = tool
        ? await runPrepare(tool, args, caller, prepareOptions?.uploads).catch(
            (): PrepareAnswer => ({
              ok: false,
              code: "failed",
              message: prepareFailed(tool),
            }),
          )
        : { ok: false, code: "unknown_tool", message: NO_SUCH_TOOL };
      logged(tool?.name, " prepare", caller, started, answer);
      return answer;
    },
    async apply(name, request, caller, applyOptions) {
      const started = Date.now();
      // An unknown name never consumes the upload (v09 P1(c) step 1).
      const tool = twoPhaseTool(name);
      const consumed = tool ? consumeUpload(applyOptions, request, caller) : {};
      const ran: ApplyAnswer = !tool
        ? {
            ok: false,
            code: "unknown_tool",
            message: NO_SUCH_TOOL,
            effects: "none",
          }
        : "refused" in consumed
          ? consumed.refused
          : await runApply(tool, request, caller, consumed.upload).catch(
              (): ApplyAnswer => ({
                ok: false,
                code: "failed",
                message: failureText(tool, "failed"),
                effects: "possible",
              }),
            );
      const answer = applyAnswerWithinCap(ran, () =>
        log(`tool ${tool?.name ?? "(unknown)"} apply result over its cap`),
      );
      logged(tool?.name, " apply", caller, started, answer);
      return answer;
    },
  };
}
