/**
 * A live Claude query hosted by the session's Worker as a `claude-sdk` engine
 * (`docs/workers.md`): the Worker's side of `openHostedClaudeQuery`
 * (`remoteClaudeQuery.ts`). One engine is one query epoch; the session stays
 * the server-side driver of its turns, records and state.
 *
 * - The open spec is the server's {@link ClaudeQueryOpenSpec}. The factory
 *   binds only what is not JSON: the abort controller, the child environment
 *   over `host.childEnv()`, the permission and hook callbacks over
 *   `host.sessionHooks`, and the session's `pa` tool server.
 * - The SDK seam and the tool server come from the session's in-process
 *   binding ({@link registerClaudeHostedSession}). An open for a session with
 *   none fails: it never falls back to the real SDK.
 * - Nothing is pulled from the query before the `start` command, so every
 *   item follows the open's answer. Items: `message` per SDK message, then
 *   `end` or `failed`; `compactSummary` when the spec captures it.
 * - `close` closes the SDK query at most once. Dispose after the terminal
 *   item only releases (the executor slot, the prompt); before it, dispose is
 *   forced: the prompt ends, then close, then abort.
 */
import type {
  HostedEngine,
  HostedEngineFactory,
  HostedEngineHost,
  HostedEngineItem,
} from "../workerProtocol/engineMethods.ts";
import { WorkerMethodError } from "../workerProtocol/connection.ts";
import type { AppToolExecutor } from "../mcp/tool.ts";
import {
  claudeQueryEnvironment,
  claudeQueryOptions,
  type ClaudeQueryOpenSpec,
} from "./options.ts";
import type { ClaudeQuerySessionHooks } from "./outputPolicyHooks.ts";
import type {
  ClaudeQuery,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
  ClaudeSdkUserMessage,
} from "./sdkSeam.ts";
import type { ClaudeSessionToolServer } from "./toolServer.ts";

/** The optional query controls a hosted query may answer as commands. */
const CLAUDE_QUERY_CONTROLS = [
  "close",
  "interrupt",
  "stopTask",
  "cancelAsyncMessage",
  "setModel",
  "setMaxThinkingTokens",
  "applyFlagSettings",
  "supportedCommands",
  "getContextUsage",
] as const;

export type ClaudeQueryControl = (typeof CLAUDE_QUERY_CONTROLS)[number];

/** What a hosted query's open answers: the controls its query has. */
export interface ClaudeHostedInfo {
  controls: ClaudeQueryControl[];
}

/** A hosted query's items, in emission order. */
export type ClaudeHostedItem =
  | { kind: "message"; message: ClaudeSdkMessage }
  | { kind: "end" }
  | { kind: "failed"; message: string }
  | { kind: "compactSummary"; summary: string };

/** A command the engine itself serves, beside the query's controls. */
const UNKNOWN_COMMAND = "unknown_command";

/** What a session lends the Worker that hosts its queries, in-process. */
export interface ClaudeHostedSessionBinding {
  seam: () => Promise<ClaudeSdkSeam>;
  toolServer: () => ClaudeSessionToolServer | undefined;
}

const sessions = new Map<string, ClaudeHostedSessionBinding>();

/**
 * Lend `sessionId`'s SDK seam and tool server to the in-process Worker's
 * Claude engines. Answers the release, which removes only this binding.
 */
export function registerClaudeHostedSession(
  sessionId: string,
  binding: ClaudeHostedSessionBinding,
): () => void {
  sessions.set(sessionId, binding);
  return () => {
    if (sessions.get(sessionId) === binding) sessions.delete(sessionId);
  };
}

/** The query's prompt: the input the server sends, until `inputEnd`. */
class HostedInput implements AsyncIterable<ClaudeSdkUserMessage> {
  private readonly values: ClaudeSdkUserMessage[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<ClaudeSdkUserMessage>) => void
  > = [];
  private closed = false;

  push(value: ClaudeSdkUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkUserMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** The session's permission and hook calls, through this engine's host. */
function hostedSessionHooks(
  sessionId: string,
  epoch: string,
  host: HostedEngineHost,
): ClaudeQuerySessionHooks {
  return {
    epoch,
    canUseTool: (toolName, signal) =>
      host.sessionHooks.canUseTool({ sessionId, toolName }, signal),
    preToolUse: (epoch, input, signal) =>
      host.sessionHooks.preToolUse({ sessionId, epoch, ...input }, signal),
    stop: (epoch, tasks, signal) =>
      host.sessionHooks.stop({ sessionId, epoch, tasks }, signal),
    postCompact: (epoch, summary, signal) =>
      host.sessionHooks.postCompact({ sessionId, epoch, summary }, signal),
    persistOutput: (input, signal) =>
      host.persistOutput({ sessionId, ...input }, signal),
  };
}

/** The session's app tools, through this engine's host. */
function hostedToolExecutor(
  sessionId: string,
  host: HostedEngineHost,
): AppToolExecutor {
  return (tool, args, ctx) =>
    host.callAppTool(
      { sessionId, tool, toolCallId: ctx.toolCallId, args },
      {
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...(ctx.progress !== undefined ? { onProgress: ctx.progress } : {}),
      },
    );
}

function hostClaudeQuery(
  spec: ClaudeQueryOpenSpec,
  host: HostedEngineHost,
  seam: ClaudeSdkSeam,
  toolServer: ClaudeSessionToolServer | undefined,
): HostedEngine {
  const abortController = new AbortController();
  const input = new HostedInput();
  let listener: ((item: HostedEngineItem) => void) | undefined;
  const early: ClaudeHostedItem[] = [];
  const emit = (item: ClaudeHostedItem): void => {
    if (listener) listener(item);
    else early.push(item);
  };

  const options = claudeQueryOptions(spec, {
    abortController,
    env: claudeQueryEnvironment(spec.env, host.childEnv()),
    ...(spec.sessionHooksEpoch !== undefined
      ? {
          sessionHooks: hostedSessionHooks(
            spec.sessionId,
            spec.sessionHooksEpoch,
            host,
          ),
        }
      : {}),
    ...(toolServer ? { mcpServer: toolServer.server } : {}),
  });
  if (spec.captureCompactSummary)
    options.hooks = {
      PostCompact: [
        {
          hooks: [
            async (hookInput) => {
              if (
                "compact_summary" in hookInput &&
                typeof hookInput.compact_summary === "string"
              )
                emit({
                  kind: "compactSummary",
                  summary: hookInput.compact_summary,
                });
              return { continue: true };
            },
          ],
        },
      ],
    };

  // A synchronous throw rejects the open.
  const query: ClaudeQuery = seam.query({ prompt: input, options });

  let started = false;
  let ended = false;
  let closed = false;
  let releaseExecutor: (() => void) | undefined;

  const close = (): void => {
    if (closed) return;
    closed = true;
    query.close?.();
  };

  const pull = async (): Promise<void> => {
    try {
      for await (const message of query) emit({ kind: "message", message });
      ended = true;
      emit({ kind: "end" });
    } catch (err) {
      ended = true;
      emit({
        kind: "failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const control = (name: string, args: unknown): unknown => {
    if (!(CLAUDE_QUERY_CONTROLS as readonly string[]).includes(name))
      throw new WorkerMethodError(
        UNKNOWN_COMMAND,
        `A Claude query has no ${JSON.stringify(name)} command.`,
      );
    const method: unknown = query[name as ClaudeQueryControl];
    if (typeof method !== "function")
      throw new WorkerMethodError(
        UNKNOWN_COMMAND,
        `This Claude query has no ${name} control.`,
      );
    return (method as (...values: unknown[]) => unknown).apply(
      query,
      Array.isArray(args) ? args : [],
    );
  };

  const info: ClaudeHostedInfo = {
    controls: CLAUDE_QUERY_CONTROLS.filter(
      (name) => typeof query[name] === "function",
    ),
  };

  return {
    info,
    snapshot: () => null,
    command(name, args) {
      try {
        switch (name) {
          case "start":
            if (!started) {
              started = true;
              // Bound when its epoch starts, so an engine the session
              // discarded unstarted never takes the slot.
              if (toolServer)
                releaseExecutor = toolServer.bindExecutor(
                  hostedToolExecutor(spec.sessionId, host),
                );
              void pull();
            }
            return Promise.resolve(null);
          case "input":
            input.push((args as [ClaudeSdkUserMessage])[0]);
            return Promise.resolve(null);
          case "inputEnd":
            input.close();
            return Promise.resolve(null);
          case "close":
            close();
            return Promise.resolve(null);
          case "abort":
            abortController.abort();
            return Promise.resolve(null);
          default:
            return Promise.resolve(control(name, args));
        }
      } catch (err) {
        return Promise.reject(err);
      }
    },
    onItem(receive) {
      listener = receive as (item: HostedEngineItem) => void;
      for (const item of early.splice(0)) receive(item);
    },
    async dispose() {
      releaseExecutor?.();
      releaseExecutor = undefined;
      // The query's prompt ends with its engine either way.
      input.close();
      if (ended) return;
      close();
      abortController.abort();
    },
  };
}

/**
 * The in-process Worker's `claude-sdk` engine factory. Every live Claude
 * query a session opens runs here; one-shot runs and the usage probe stay on
 * the server.
 */
export function createClaudeHostedEngineFactory(): HostedEngineFactory {
  return async (raw, host) => {
    const spec = raw as ClaudeQueryOpenSpec;
    const binding = sessions.get(spec.sessionId);
    if (!binding)
      throw new Error(
        `Claude session ${spec.sessionId} lent this Worker no SDK binding.`,
      );
    const seam = await binding.seam();
    const toolServer = spec.mountToolServer ? binding.toolServer() : undefined;
    if (spec.mountToolServer && !toolServer)
      throw new Error(`Claude session ${spec.sessionId} has no tool server.`);
    return hostClaudeQuery(spec, host, seam, toolServer);
  };
}
