/**
 * The server's side of the engine methods (`docs/workers.md`): the engines it
 * opened on each Worker connection, and its handler for `engine.events`. It
 * knows no harness; a harness's remote handle (`piSdk/remotePiEngine.ts`)
 * supplies the sink that applies its items.
 *
 * - The server assigns every engine id, unique in this process, and registers
 *   it before `engine.open` goes out, so items that precede the answer are
 *   held and applied once the answer's snapshot is in place.
 * - Items are applied in order, and `engine.events` is acknowledged only once
 *   they are. A delivery for an engine this connection never opened answers a
 *   typed error; one for an engine being disposed is acknowledged and dropped.
 * - A command's answer, result or failure, settles only once the items up to
 *   its `seq` are applied.
 * - On connection end every engine is lost: its pending and later commands
 *   reject with `engine_gone`, and its sink's `onLost` runs once. The server
 *   never retries; the next open dials a fresh connection.
 *
 * Imports no connection acquisition, so `inProcessWorker.ts` can wire it.
 */
import {
  WorkerMethodError,
  WorkerRequestError,
  type MethodHandlers,
  type WorkerConnection,
} from "../workerProtocol/connection.ts";
import {
  ENGINE_GONE,
  ENGINE_METHODS,
  EngineCommandError,
  decodeEngineCommandAnswer,
  decodeEngineEvents,
  decodeEngineOpened,
  encodeEngineCommand,
  encodeEngineDispose,
  encodeEngineEventsApplied,
  encodeEngineOpen,
  type EngineDiscard,
  type EngineItem,
} from "../workerProtocol/engineMethods.ts";

/** How a harness's remote handle takes its engine's items. */
export interface EngineSink {
  /**
   * Apply one item. A returned promise holds back the next item, and the
   * acknowledgement, until it settles.
   */
  apply(item: EngineItem): void | Promise<void>;
  /** The connection ended: the engine is gone. Called once. */
  onLost(): void;
}

/** One open engine, as its remote handle drives it. */
export interface EngineChannel {
  readonly engineId: number;
  /**
   * Run a command under the caller's per-engine command id. Settles with the
   * result, or rejects with an {@link EngineCommandError}, once the items
   * the engine emitted before answering are applied.
   */
  command(commandId: number, command: string, args: unknown): Promise<unknown>;
  /** Remove the engine. Resolves at once when the engine is already gone. */
  dispose(discard?: EngineDiscard): Promise<void>;
}

interface Waiter {
  seq: number;
  settle: () => void;
}

interface Entry {
  state: "opening" | "live" | "disposing" | "lost";
  sink?: EngineSink;
  /** Items that arrived before the open's answer. */
  early: EngineItem[];
  applied: number;
  /** Answers waiting for their seq, in arrival order. */
  waiting: Waiter[];
  /** Commands not yet answered, rejected on loss. */
  pending: Set<(err: Error) => void>;
  /** The tail of the items being applied, so deliveries apply in order. */
  applying: Promise<void>;
}

let nextEngineId = 1;
const enginesByConnection = new WeakMap<WorkerConnection, ConnectionEngines>();

const goneError = (engineId: number): EngineCommandError =>
  new EngineCommandError(ENGINE_GONE, `Engine ${engineId} is gone.`);

/** The engines one Worker connection serves. */
class ConnectionEngines {
  readonly entries = new Map<number, Entry>();

  constructor(readonly connection: WorkerConnection) {
    void connection.ended.then(() => {
      for (const [engineId, entry] of this.entries) this.lose(engineId, entry);
      this.entries.clear();
    });
  }

  private lose(engineId: number, entry: Entry): void {
    const wasLive = entry.state === "live";
    entry.state = "lost";
    entry.waiting = [];
    for (const reject of entry.pending) reject(goneError(engineId));
    entry.pending.clear();
    if (wasLive) entry.sink?.onLost();
  }

  /** Apply `items` after any delivery still applying; resolves once applied. */
  deliver(engineId: number, items: EngineItem[]): Promise<void> {
    const entry = this.entries.get(engineId);
    if (!entry)
      throw new WorkerMethodError(
        ENGINE_GONE,
        `This connection opened no engine ${engineId}.`,
      );
    if (entry.state === "opening") {
      entry.early.push(...items);
      return Promise.resolve();
    }
    const run = entry.applying.then(() => this.apply(entry, items));
    entry.applying = run.catch(() => {});
    return run;
  }

  async apply(entry: Entry, items: EngineItem[]): Promise<void> {
    for (const item of items) {
      if (entry.state !== "live" || !entry.sink) return;
      if (item.seq <= entry.applied) continue;
      const applying = entry.sink.apply(item);
      if (applying) await applying;
      entry.applied = item.seq;
      while (entry.waiting.length > 0 && entry.waiting[0]!.seq <= item.seq)
        entry.waiting.shift()!.settle();
    }
  }

  /** Settle `settle` once the items up to `seq` are applied. */
  whenApplied(entry: Entry, seq: number, settle: () => void): void {
    if (entry.state === "lost") return;
    if (seq <= entry.applied) settle();
    else entry.waiting.push({ seq, settle });
  }
}

function enginesOn(connection: WorkerConnection): ConnectionEngines {
  let engines = enginesByConnection.get(connection);
  if (!engines) {
    engines = new ConnectionEngines(connection);
    enginesByConnection.set(connection, engines);
  }
  return engines;
}

/** The server's handler table for engine deliveries on one connection. */
export function engineDeliveries(
  connection: () => WorkerConnection,
): MethodHandlers {
  return {
    [ENGINE_METHODS.events]: async (payload) => {
      const { engineId, items } = decodeEngineEvents(payload);
      await enginesOn(connection()).deliver(engineId, items);
      return encodeEngineEventsApplied();
    },
  };
}

function commandFailure(err: unknown, engineId: number): Error {
  if (err instanceof WorkerRequestError)
    return err.code === ENGINE_GONE
      ? goneError(engineId)
      : new EngineCommandError(err.code, err.message);
  // Not sent, or the connection ended before the answer.
  return goneError(engineId);
}

/**
 * Open a `harness` engine on `connection`. `attach` builds the harness's sink
 * from the answer, before any item is applied to it.
 */
export async function openEngineChannel<T>(
  connection: WorkerConnection,
  harness: string,
  spec: unknown,
  attach: (
    opened: { info: unknown; snapshot: unknown },
    channel: EngineChannel,
  ) => { sink: EngineSink; value: T },
): Promise<{ info: unknown; value: T }> {
  const engines = enginesOn(connection);
  const engineId = nextEngineId++;
  const entry: Entry = {
    state: "opening",
    early: [],
    applied: 0,
    waiting: [],
    pending: new Set(),
    applying: Promise.resolve(),
  };
  engines.entries.set(engineId, entry);
  let answer;
  try {
    answer = decodeEngineOpened(
      await connection.request(
        ENGINE_METHODS.open,
        encodeEngineOpen({ engineId, harness, spec }),
      ),
    );
  } catch (err) {
    if (engines.entries.get(engineId) === entry)
      engines.entries.delete(engineId);
    throw err;
  }
  if (entry.state !== "opening") throw goneError(engineId);

  const channel: EngineChannel = {
    engineId,
    command(commandId, command, args) {
      if (entry.state !== "live") return Promise.reject(goneError(engineId));
      return new Promise<unknown>((resolve, reject) => {
        entry.pending.add(reject);
        const done = (settle: () => void) => {
          entry.pending.delete(reject);
          settle();
        };
        connection
          .request(
            ENGINE_METHODS.command,
            encodeEngineCommand({ engineId, commandId, command, args }),
          )
          .then(
            (payload) => {
              const answered = decodeEngineCommandAnswer(payload);
              engines.whenApplied(entry, answered.seq, () =>
                done(() =>
                  "result" in answered
                    ? resolve(answered.result)
                    : reject(
                        new EngineCommandError(
                          answered.error.code,
                          answered.error.message,
                        ),
                      ),
                ),
              );
            },
            (err: unknown) => done(() => reject(commandFailure(err, engineId))),
          )
          .catch((err: unknown) => done(() => reject(err as Error)));
      });
    },
    async dispose(discard) {
      if (entry.state !== "live") return;
      entry.state = "disposing";
      try {
        await connection.request(
          ENGINE_METHODS.dispose,
          encodeEngineDispose({
            engineId,
            ...(discard !== undefined ? { discard } : {}),
          }),
        );
      } catch {
        // A connection that ended took the engine with it.
      } finally {
        for (const reject of entry.pending) reject(goneError(engineId));
        entry.pending.clear();
        if (engines.entries.get(engineId) === entry)
          engines.entries.delete(engineId);
      }
    },
  };

  const { sink, value } = attach(
    { info: answer.info, snapshot: answer.snapshot },
    channel,
  );
  entry.sink = sink;
  entry.applied = answer.seq;
  entry.state = "live";
  const early = entry.early.splice(0);
  if (early.length > 0) await engines.deliver(engineId, early);
  return { info: answer.info, value };
}
