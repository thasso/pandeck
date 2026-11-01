/**
 * The Worker's engine table (`docs/workers.md`): the live agent engines this
 * Worker hosts for the server, by the id the server assigned, each opened by
 * the factory the composition root injected for its harness. The table knows
 * no harness; it numbers each engine's items and delivers them in order.
 *
 * - An open reserves its id before the factory runs, so a duplicate is refused
 *   while it opens too. An engine whose factory returns after the connection
 *   ended, or after its reservation was dropped, is disposed once and never
 *   registered.
 * - A command is handed to its engine in the span that received it, so an
 *   engine's commands start in arrival order; a long one never holds back a
 *   later one.
 * - Each engine's items go out as `engine.events`, one delivery in flight;
 *   the next follows the server's acknowledgement. An engine's app-tool call
 *   waits until every item it emitted before the call is acknowledged, so the
 *   server's mirror holds what the engine wrote before the tool runs.
 * - On connection end every engine is disposed and its queue dropped.
 */
import { errorText } from "../errors.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerMethodError,
  type MethodHandlers,
} from "../workerProtocol/connection.ts";
import {
  ENGINE_GONE,
  ENGINE_ID_TAKEN,
  ENGINE_METHODS,
  UNKNOWN_HARNESS,
  decodeEngineCommand,
  decodeEngineDispose,
  decodeEngineOpen,
  encodeEngineCommandAnswer,
  encodeEngineDisposed,
  encodeEngineEvents,
  encodeEngineOpened,
  type EngineItem,
  type HostedEngine,
  type HostedEngineFactory,
  type HostedEngineHost,
} from "../workerProtocol/engineMethods.ts";
import type { AppToolCaller } from "./appTools.ts";

/** The factory for a harness, or undefined when this Worker hosts none. */
export type EngineFactories = (
  harness: string,
) => HostedEngineFactory | undefined;

interface Entry {
  /** Undefined while the factory runs. */
  engine?: HostedEngine;
  /** The last seq numbered. */
  seq: number;
  queue: EngineItem[];
  inFlight: boolean;
  /** App-tool calls waiting for the queue to be acknowledged. */
  drained: Array<() => void>;
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () =>
      reject(new Error("The engine command was cancelled by connection end."));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

export function engineHandlers(options: {
  factories: EngineFactories | undefined;
  childEnv: () => NodeJS.ProcessEnv;
  callAppTool: AppToolCaller;
  persistOutput: HostedEngineHost["persistOutput"];
  deliver: (payload: Payload) => Promise<Payload>;
}): {
  handlers: MethodHandlers;
  end(): void;
  /** Resolves once every engine disposed on end has finished disposing. */
  released(): Promise<void>;
  readonly size: number;
} {
  const table = new Map<number, Entry>();
  const disposals = new Set<Promise<void>>();
  let ended = false;

  const current = (engineId: number, entry: Entry): boolean =>
    !ended && table.get(engineId) === entry;

  const settleDrained = (entry: Entry): void => {
    for (const resume of entry.drained.splice(0)) resume();
  };

  const flush = (engineId: number, entry: Entry): void => {
    if (entry.inFlight || !current(engineId, entry)) return;
    if (entry.queue.length === 0) {
      settleDrained(entry);
      return;
    }
    const items = entry.queue.splice(0);
    entry.inFlight = true;
    const next = () => {
      entry.inFlight = false;
      flush(engineId, entry);
    };
    options.deliver(encodeEngineEvents({ engineId, items })).then(next, next);
  };

  const dispose = (engine: HostedEngine): Promise<void> => {
    const disposal = engine.dispose().catch(() => {
      // Nothing is left to tell: the connection that held the engine is gone.
    });
    disposals.add(disposal);
    void disposal.then(() => disposals.delete(disposal));
    return disposal;
  };

  const hostFor = (engineId: number, entry: Entry): HostedEngineHost => ({
    engineId,
    childEnv: options.childEnv,
    callAppTool: async (request, callOptions) => {
      if (entry.inFlight || entry.queue.length > 0)
        await new Promise<void>((resume) => entry.drained.push(resume));
      return options.callAppTool(request, callOptions);
    },
    persistOutput: options.persistOutput,
  });

  const handlers: MethodHandlers = {
    [ENGINE_METHODS.open]: async (payload) => {
      const { engineId, harness, spec } = decodeEngineOpen(payload);
      const factory = options.factories?.(harness);
      if (!factory)
        throw new WorkerMethodError(
          UNKNOWN_HARNESS,
          `This Worker hosts no ${JSON.stringify(harness)} engines.`,
        );
      if (ended) throw new Error("The Worker connection ended.");
      if (table.has(engineId))
        throw new WorkerMethodError(
          ENGINE_ID_TAKEN,
          `Engine ${engineId} is already open.`,
        );
      const entry: Entry = { seq: 0, queue: [], inFlight: false, drained: [] };
      table.set(engineId, entry);
      let engine: HostedEngine;
      try {
        engine = await factory(spec, hostFor(engineId, entry));
      } catch (err) {
        if (table.get(engineId) === entry) table.delete(engineId);
        throw err;
      }
      if (!current(engineId, entry)) {
        await dispose(engine);
        throw new Error("The Worker connection ended.");
      }
      entry.engine = engine;
      const snapshot = engine.snapshot();
      engine.onItem((item) => {
        if (!current(engineId, entry)) return;
        entry.queue.push({ ...item, seq: ++entry.seq });
        flush(engineId, entry);
      });
      return encodeEngineOpened({
        info: engine.info,
        snapshot,
        seq: entry.seq,
      });
    },
    // Not awaiting before the engine call: commands start in arrival order.
    [ENGINE_METHODS.command]: (payload, signal) => {
      let outcome: Promise<unknown>;
      let entry: Entry | undefined;
      try {
        const { engineId, commandId, command, args } =
          decodeEngineCommand(payload);
        entry = table.get(engineId);
        if (!entry?.engine)
          throw new WorkerMethodError(
            ENGINE_GONE,
            `Engine ${engineId} is not open.`,
          );
        outcome = entry.engine.command(command, args, commandId);
      } catch (err) {
        if (!entry?.engine) return Promise.reject(err);
        outcome = Promise.reject(err);
      }
      const answered = entry;
      // Connection end disposes the engine; its answer would be dropped, and
      // the Worker's quiescence must not wait for a turn that never settles.
      return Promise.race([outcome, aborted(signal)]).then(
        (result) => encodeEngineCommandAnswer({ seq: answered.seq, result }),
        (err: unknown) =>
          encodeEngineCommandAnswer({
            seq: answered.seq,
            error: {
              ...(err instanceof WorkerMethodError ? { code: err.code } : {}),
              message: errorText(err),
            },
          }),
      );
    },
    [ENGINE_METHODS.dispose]: async (payload) => {
      const { engineId, discard } = decodeEngineDispose(payload);
      const entry = table.get(engineId);
      if (!entry)
        throw new WorkerMethodError(
          ENGINE_GONE,
          `Engine ${engineId} is not open.`,
        );
      table.delete(engineId);
      entry.queue = [];
      settleDrained(entry);
      // An engine still opening is disposed when its factory returns.
      if (entry.engine) await entry.engine.dispose(discard);
      return encodeEngineDisposed();
    },
  };

  return {
    handlers,
    end() {
      ended = true;
      for (const entry of table.values()) {
        entry.queue = [];
        settleDrained(entry);
        if (entry.engine) void dispose(entry.engine);
      }
      table.clear();
    },
    async released() {
      await Promise.all(disposals);
    },
    get size() {
      return table.size;
    },
  };
}
