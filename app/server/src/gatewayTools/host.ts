/**
 * The edge's tool host (Task-1397): lists the registered tools and runs one
 * call for one client. MCP (`mcp.ts`) is one adapter over it; gateway client
 * 1.0's `tools.*` (`gateway/clientListener.ts`, Task-1398) is the other.
 *
 * `call` never throws and settles by its deadline (30 s) or the caller's
 * abort, whatever an await inside the tool ignores. It answers the tool's
 * JSON or a fixed failure: only `ToolError` text passes, every other error's
 * message is dropped unread and unlogged.
 */
import {
  ToolError,
  abortError,
  raceAbort,
  type ObjectSchema,
  type ToolDescriptor,
} from "./descriptor.ts";
import { credentialFor, type CredentialSource } from "./toolCredential.ts";
import { checkArguments } from "./schema.ts";

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_MAX_RESULT_CHARS = 60_000;

export interface ToolCaller extends CredentialSource {
  /** The calling client, from the registry; only logged. */
  clientId: string;
  /** Aborts when the caller goes away. */
  signal?: AbortSignal;
}

type ToolFailureCode =
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
}

export interface ToolHost {
  list(): ListedTool[];
  call(name: string, args: unknown, caller: ToolCaller): Promise<ToolAnswer>;
}

export interface ToolHostOptions {
  deadlineMs?: number;
  log?: (line: string) => void;
}

export function createToolHost(
  tools: readonly ToolDescriptor[],
  options: ToolHostOptions = {},
): ToolHost {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
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
    const timer = setTimeout(() => deadline.abort(), deadlineMs);
    const signal = caller.signal
      ? AbortSignal.any([caller.signal, deadline.signal])
      : deadline.signal;
    try {
      const result = await raceAbort(
        Promise.resolve().then(() => {
          if (signal.aborted) throw abortError();
          return tool.execute(checked.params, {
            signal,
            credential: () => credentialFor(caller, tool.integration, signal),
          });
        }),
        signal,
      );
      const text = JSON.stringify(result ?? null);
      if (text.length > (tool.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS))
        return {
          ok: false,
          code: "result_too_large",
          message: "The tool's result is too large.",
        };
      return { ok: true, text };
    } catch (err) {
      // By which signal aborted, never by error text.
      if (deadline.signal.aborted)
        return { ok: false, code: "timeout", message: "The tool timed out." };
      if (signal.aborted)
        return {
          ok: false,
          code: "cancelled",
          message: "The call was cancelled.",
        };
      if (err instanceof ToolError)
        return { ok: false, code: "tool_error", message: err.message };
      return { ok: false, code: "failed", message: `${tool.name} failed.` };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    list: () =>
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        effect: tool.effect,
        actionKey: tool.actionKey,
      })),
    async call(name, args, caller) {
      const started = Date.now();
      const tool = byName.get(name);
      const answer: ToolAnswer = tool
        ? await run(tool, args, caller).catch((): ToolAnswer => ({
            ok: false,
            code: "failed",
            message: `${tool.name} failed.`,
          }))
        : { ok: false, code: "unknown_tool", message: "No such tool." };
      // The tool name only from the registry: a request's string is not logged.
      log(
        `tool ${tool?.name ?? "(unknown)"} client ${caller.clientId} ${answer.ok ? "ok" : answer.code} ${Date.now() - started}ms`,
      );
      return answer;
    },
  };
}
