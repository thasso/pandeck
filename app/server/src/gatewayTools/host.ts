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
 */
import {
  ToolError,
  abortError,
  raceAbort,
  type AtlassianToolDescriptor,
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
}

export type ToolFailureCode =
  | "unknown_tool"
  | "invalid_params"
  | "tool_error"
  | "result_too_large"
  | "timeout"
  | "cancelled"
  | "failed";

type ToolAnswer =
  | { ok: true; text: string }
  | { ok: false; code: ToolFailureCode; message: string };

interface ListedTool {
  name: string;
  description: string;
  inputSchema: ObjectSchema;
  effect: "read" | "write";
  actionKey: string;
  /** Run as `tools.prepare` and `tools.apply` on a client connection. */
  twoPhase?: true;
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
  ): Promise<PrepareAnswer>;
  apply(
    name: string,
    request: ApplyRequest,
    caller: ToolCaller,
  ): Promise<ApplyAnswer>;
}

const NO_SUCH_TOOL = "No such tool.";
const PREPARE_TIMEOUT =
  "Preparing the changes took too long; nothing was written. Send fewer items.";
const PREPARE_CANCELLED = "The call was cancelled; nothing was written.";
const prepareFailed = (tool: ToolDescriptor) =>
  `${tool.name} could not prepare the changes; nothing was written.`;

export interface ToolHostOptions {
  deadlineMs?: number;
  log?: (line: string) => void;
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
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const run = async (
    tool: ToolDescriptor,
    args: unknown,
    caller: ToolCaller,
  ): Promise<ToolAnswer> => {
    const checked = checkArguments(tool.inputSchema, args);
    if (!checked.ok)
      return { ok: false, code: "invalid_params", message: checked.message };
    const deadline = new AbortController();
    const deadlineMs = effectiveDeadlineMs(tool, options.deadlineMs);
    const deadlineAt = Date.now() + deadlineMs;
    const timer = setTimeout(() => deadline.abort(), deadlineMs);
    const signal = caller.signal
      ? AbortSignal.any([caller.signal, deadline.signal])
      : deadline.signal;
    try {
      const result = await raceAbort(
        Promise.resolve().then(() => {
          if (signal.aborted) throw abortError();
          // Narrowed per integration: each execute gets its own credential.
          switch (tool.integration) {
            case "atlassian":
              return tool.execute(checked.params, {
                signal,
                deadlineAt,
                credential: () => atlassianCredentialFor(caller, signal),
              });
            case "slack":
              return tool.execute(checked.params, {
                signal,
                deadlineAt,
                credential: () => slackCredentialFor(caller, signal),
              });
            default: {
              const never: never = tool;
              return never;
            }
          }
        }),
        signal,
      );
      const text = JSON.stringify(result ?? null);
      if (text.length > (tool.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS))
        return {
          ok: false,
          code: "result_too_large",
          message: failureText(tool, "result_too_large"),
        };
      return { ok: true, text };
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
  ): Promise<ApplyAnswer> => {
    // The request signal is the deadline's alone; the caller's only stops.
    const ledger = createWriteLedger();
    const deadline = new AbortController();
    const deadlineMs = effectiveDeadlineMs(tool, options.deadlineMs);
    const deadlineAt = Date.now() + deadlineMs;
    const timer = setTimeout(() => deadline.abort(), deadlineMs);
    const { signal } = deadline;
    try {
      return await raceAbort(
        Promise.resolve().then(() => {
          if (signal.aborted) throw abortError();
          return tool.phases.apply(request, {
            signal,
            deadlineAt,
            cancel: caller.signal ?? new AbortController().signal,
            ledger,
            credential: () => atlassianCredentialFor(caller, signal),
          });
        }),
        signal,
      );
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
    async prepare(name, args, caller) {
      const started = Date.now();
      const tool = twoPhaseTool(name);
      const answer: PrepareAnswer = tool
        ? await runPrepare(tool, args, caller).catch((): PrepareAnswer => ({
            ok: false,
            code: "failed",
            message: prepareFailed(tool),
          }))
        : { ok: false, code: "unknown_tool", message: NO_SUCH_TOOL };
      logged(tool?.name, " prepare", caller, started, answer);
      return answer;
    },
    async apply(name, request, caller) {
      const started = Date.now();
      const tool = twoPhaseTool(name);
      const ran: ApplyAnswer = tool
        ? await runApply(tool, request, caller).catch((): ApplyAnswer => ({
            ok: false,
            code: "failed",
            message: failureText(tool, "failed"),
            effects: "possible",
          }))
        : {
            ok: false,
            code: "unknown_tool",
            message: NO_SUCH_TOOL,
            effects: "none",
          };
      const answer = applyAnswerWithinCap(ran, () =>
        log(`tool ${tool?.name ?? "(unknown)"} apply result over its cap`),
      );
      logged(tool?.name, " apply", caller, started, answer);
      return answer;
    },
  };
}
