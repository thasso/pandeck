/**
 * The server's handle on a live Claude query hosted by the session's Worker
 * (`claudeEngineHosted.ts`), driven over the engine methods
 * (`docs/workers.md`). In phase 1 that Worker is the in-process one.
 *
 * - It is a {@link ClaudeQuery} with exactly the optional controls the hosted
 *   query has; each is an `engine.command`.
 * - Iterating it starts the query (`start`), then streams the prompt to it
 *   (`input`, `inputEnd`). Before that the engine pulls nothing, so its
 *   first item follows the open's answer.
 * - Applying an item never waits for the consumer: a message is queued for
 *   the iterator, a compact summary handed to `onCompactSummary`. The
 *   consumer's own awaits on commands would otherwise deadlock.
 * - `close()` asks the query to close and keeps the stream: iteration ends
 *   with the query's own terminal item, and the engine is disposed once that
 *   item arrived and every command sent before has its answer. `discard()`
 *   is for a handle never iterated: a forced dispose.
 */
import type { EngineItem } from "../workerProtocol/engineMethods.ts";
import {
  openEngineChannel,
  type EngineChannel,
  type EngineSink,
} from "../workers/engineClient.ts";
import { ensureInProcessWorker } from "../workers/inProcessWorker.ts";
import type {
  ClaudeHostedInfo,
  ClaudeHostedItem,
  ClaudeQueryControl,
} from "./claudeEngineHosted.ts";
import type { ClaudeQueryOpenSpec } from "./options.ts";
import type {
  ClaudeQuery,
  ClaudeSdkMessage,
  ClaudeSdkUserMessage,
} from "./sdkSeam.ts";

/** A hosted query, as the session drives it. */
export type RemoteClaudeQuery = ClaudeQuery & {
  /** Dispose a handle the session abandons before iterating it. */
  discard(): Promise<void>;
};

type Terminal = { failed?: Error };

function remoteClaudeQuery(
  info: ClaudeHostedInfo,
  channel: EngineChannel,
  prompt: AsyncIterable<ClaudeSdkUserMessage>,
  onCompactSummary: ((summary: string) => void) | undefined,
): { query: RemoteClaudeQuery; sink: EngineSink; abort(): void } {
  const queued: ClaudeSdkMessage[] = [];
  let waiting:
    | {
        resolve(result: IteratorResult<ClaudeSdkMessage>): void;
        reject(err: unknown): void;
      }
    | undefined;
  let terminal: Terminal | undefined;
  /** The consumer left or the session discarded the handle. */
  let finished = false;
  let iterated = false;
  let closeSent = false;
  let disposed = false;
  let nextCommandId = 1;
  /** Commands sent and not yet answered. */
  let inFlight = 0;

  /**
   * Once the query ended and every command sent before has its answer: a
   * control still waiting when the stream ends is answered by the query, as
   * it would be in-process, not failed by the engine's disposal.
   */
  const disposeWhenSettled = (): void => {
    if (disposed || !terminal || inFlight > 0) return;
    disposed = true;
    void channel.dispose();
  };
  const command = (name: string, args: unknown[] = []): Promise<unknown> => {
    // JSON has no `undefined`: a trailing omitted argument stays omitted.
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
    const answer = channel.command(nextCommandId++, name, args);
    inFlight += 1;
    const settled = (): void => {
      inFlight -= 1;
      disposeWhenSettled();
    };
    answer.then(settled, settled);
    return answer;
  };
  const send = (name: string, args?: unknown[]): void => {
    command(name, args).catch(() => {
      // Its engine is gone; nothing waits for the answer.
    });
  };

  const settle = (): void => {
    const waiter = waiting;
    if (!waiter || !terminal) return;
    waiting = undefined;
    finished = true;
    if (terminal.failed) waiter.reject(terminal.failed);
    else waiter.resolve({ value: undefined, done: true });
  };

  const end = (reached: Terminal): void => {
    if (terminal) return;
    terminal = reached;
    settle();
    disposeWhenSettled();
  };

  const close = (): void => {
    if (closeSent || terminal || disposed) return;
    closeSent = true;
    send("close");
  };

  const pump = async (): Promise<void> => {
    try {
      for await (const message of prompt) {
        if (disposed) return;
        send("input", [message]);
      }
      if (!disposed) send("inputEnd");
    } catch {
      // A prompt that fails ends nothing the query has not already been sent.
    }
  };

  const sink: EngineSink = {
    apply(entry: EngineItem): void {
      const item = entry as unknown as ClaudeHostedItem;
      switch (item.kind) {
        case "message":
          if (finished) return;
          if (waiting) {
            const waiter = waiting;
            waiting = undefined;
            waiter.resolve({ value: item.message, done: false });
          } else queued.push(item.message);
          return;
        case "compactSummary":
          onCompactSummary?.(item.summary);
          return;
        case "end":
          end({});
          return;
        case "failed":
          end({ failed: new Error(item.message) });
          return;
      }
    },
    onLost() {
      disposed = true;
      end({ failed: new Error("The Worker connection ended.") });
    },
  };

  const iterator: AsyncIterator<ClaudeSdkMessage> = {
    next() {
      const value = queued.shift();
      if (value !== undefined) return Promise.resolve({ value, done: false });
      if (finished) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        settle();
      });
    },
    return() {
      // The consumer left early: the query is asked to close, and its engine
      // is disposed once its own terminal item says it ended.
      finished = true;
      queued.length = 0;
      close();
      return Promise.resolve({ value: undefined, done: true });
    },
  };

  const controls = new Set<ClaudeQueryControl>(info.controls);
  const query: RemoteClaudeQuery = {
    [Symbol.asyncIterator]() {
      if (!iterated && !finished) {
        iterated = true;
        send("start");
        void pump();
      }
      return iterator;
    },
    async discard() {
      finished = true;
      queued.length = 0;
      if (disposed) return;
      disposed = true;
      await channel.dispose();
    },
    ...(controls.has("close") ? { close } : {}),
    ...(controls.has("interrupt")
      ? { interrupt: () => command("interrupt") }
      : {}),
    ...(controls.has("stopTask")
      ? {
          stopTask: (taskId: string) =>
            command("stopTask", [taskId]) as Promise<void>,
        }
      : {}),
    ...(controls.has("cancelAsyncMessage")
      ? {
          cancelAsyncMessage: (uuid: string) =>
            command("cancelAsyncMessage", [uuid]) as Promise<boolean>,
        }
      : {}),
    ...(controls.has("setModel")
      ? {
          setModel: (model?: string) =>
            command("setModel", [model]) as Promise<void>,
        }
      : {}),
    ...(controls.has("setMaxThinkingTokens")
      ? {
          setMaxThinkingTokens: (tokens: number | null) =>
            command("setMaxThinkingTokens", [tokens]) as Promise<void>,
        }
      : {}),
    ...(controls.has("applyFlagSettings")
      ? {
          applyFlagSettings: (settings: Record<string, unknown>) =>
            command("applyFlagSettings", [settings]) as Promise<void>,
        }
      : {}),
    ...(controls.has("supportedCommands")
      ? {
          supportedCommands: () =>
            command("supportedCommands") as Promise<Array<{ name: string }>>,
        }
      : {}),
    ...(controls.has("getContextUsage")
      ? {
          getContextUsage: (opts?: { detail?: "summary" | "full" }) =>
            command("getContextUsage", [opts]) as ReturnType<
              NonNullable<ClaudeQuery["getContextUsage"]>
            >,
        }
      : {}),
  };
  return { query, sink, abort: () => send("abort") };
}

/**
 * Open `spec`'s query on the session's Worker. Aborting `signal` aborts the
 * hosted query's own controller; its stream then ends as the query does.
 */
export async function openHostedClaudeQuery(input: {
  prompt: AsyncIterable<ClaudeSdkUserMessage>;
  spec: ClaudeQueryOpenSpec;
  signal: AbortSignal;
  onCompactSummary?: (summary: string) => void;
}): Promise<RemoteClaudeQuery> {
  const { value } = await openEngineChannel(
    ensureInProcessWorker(),
    "claude-sdk",
    input.spec,
    ({ info }, channel) => {
      const remote = remoteClaudeQuery(
        info as ClaudeHostedInfo,
        channel,
        input.prompt,
        input.onCompactSummary,
      );
      if (input.signal.aborted) remote.abort();
      else
        input.signal.addEventListener("abort", () => remote.abort(), {
          once: true,
        });
      return { sink: remote.sink, value: remote.query };
    },
  );
  return value;
}
