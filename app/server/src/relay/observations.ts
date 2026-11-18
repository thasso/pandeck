/** In-memory, admission-reserved reporting. No observation state reaches disk. */
import type { ClientCredentialClass } from "./credentialClass.ts";

export interface Observation {
  rid: string;
  at: number;
  host: string;
  method: string;
  path: string;
  status: number | null;
  outcome: "failed" | "refused" | "observed";
  reason?: string;
  clientCredential: ClientCredentialClass;
  clientCookie: boolean;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
}

type Note =
  | { note: "relay-restarted" }
  | { note: "overflow"; count: number; from: number; to: number };
export type Delivery = (Observation | Note) & { d: number };
export interface ObservationBatch {
  boot: string;
  records: Delivery[];
}
export interface ObservationAnswer {
  status: number;
  ack?: number;
}
export interface Reservation {
  /** Both operations are idempotent, including after the other operation. */
  release(): void;
  record(observation: Observation): void;
}

export interface ObservationOptions {
  boot: string;
  send(
    batch: ObservationBatch,
    signal: AbortSignal,
  ): Promise<ObservationAnswer>;
  log(line: string): void;
  capacity?: number;
  retryMs?: number;
  retryMaxMs?: number;
  now?: () => number;
}

/** A single-flight d/ack queue. Slots include unfinished admitted requests. */
export function createObservations(options: ObservationOptions) {
  const capacity = options.capacity ?? 20_000;
  if (!Number.isSafeInteger(capacity) || capacity < 2)
    throw new Error("Observation capacity must be at least two.");
  const now = options.now ?? Date.now;
  const records: Delivery[] = [];
  const firstRetry = options.retryMs ?? 1_000;
  let backoff = firstRetry;
  let nextD = 0;
  let ordinary = 0;
  let overflow: Extract<Note, { note: "overflow" }> | undefined;
  let overflowQueued = false;
  let running = false;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let sending: AbortController | undefined;
  let closePromise: Promise<void> | undefined;
  let drained: (() => void) | undefined;
  let rejected = 0;

  function enqueue(value: Observation | Note): void {
    records.push({ ...value, d: ++nextD });
    queueMicrotask(() => void kick());
  }
  function overflowNote(force = false): void {
    if (!overflow || overflowQueued || (!force && ordinary >= capacity - 1))
      return;
    const note = overflow;
    overflow = undefined;
    overflowQueued = true;
    enqueue(note);
  }
  function changed(): void {
    overflowNote();
    if (!records.length && !overflow) drained?.();
  }
  function removeThrough(d: number): void {
    while (records.length && records[0]!.d <= d) {
      const record = records.shift()!;
      if ("note" in record && record.note === "overflow")
        overflowQueued = false;
      else ordinary--;
    }
    changed();
  }
  function batch(): ObservationBatch {
    const result: ObservationBatch = { boot: options.boot, records: [] };
    for (const record of records) {
      if (result.records.length === 100) break;
      result.records.push(record);
      if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) {
        result.records.pop();
        break;
      }
    }
    return result;
  }
  async function kick(): Promise<void> {
    if (running || stopped || retry || !records.length) return;
    running = true;
    const outgoing = batch();
    const controller = new AbortController();
    sending = controller;
    let success = false;
    try {
      const answer = await options.send(outgoing, controller.signal);
      if (stopped) return;
      const last = outgoing.records.at(-1)!.d;
      if (answer.status === 400) {
        rejected += outgoing.records.length;
        options.log("observations: invalid batch dropped");
        removeThrough(last);
        success = true;
      } else if (
        answer.status === 200 &&
        Number.isSafeInteger(answer.ack) &&
        answer.ack! >= outgoing.records[0]!.d &&
        answer.ack! <= last
      ) {
        removeThrough(answer.ack!);
        success = true;
      }
    } catch {
      // No exception text: a peer's answer or transport error can hold secrets.
    } finally {
      sending = undefined;
      running = false;
      if (!stopped) {
        if (success) {
          backoff = firstRetry;
          queueMicrotask(() => void kick());
        } else {
          retry = setTimeout(() => {
            retry = undefined;
            void kick();
          }, backoff);
          retry.unref();
          backoff = Math.min(backoff * 2, options.retryMaxMs ?? 30_000);
        }
      }
    }
  }

  // There is no marker file. Even a first-ever boot reports an unknown gap.
  ordinary++;
  enqueue({ note: "relay-restarted" });

  return {
    reserve(): Reservation | undefined {
      if (stopped || ordinary >= capacity - 1) return undefined;
      ordinary++;
      let disposed = false;
      return {
        release() {
          if (disposed) return;
          disposed = true;
          ordinary--;
          changed();
        },
        record(observation) {
          if (disposed) return;
          disposed = true;
          if (stopped) ordinary--;
          else enqueue(observation);
        },
      };
    },
    overflow(): void {
      const at = now();
      if (overflow) {
        overflow.count++;
        // Keep the observed wall-time range ordered even across clock steps.
        overflow.from = Math.min(overflow.from, at);
        overflow.to = Math.max(overflow.to, at);
      } else overflow = { note: "overflow", count: 1, from: at, to: at };
    },
    /** Flush starts only after every active reservation has been disposed. */
    close(flushMs: number): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        overflowNote(true);
        if (retry) clearTimeout(retry);
        retry = undefined;
        void kick();
        let deadline: ReturnType<typeof setTimeout> | undefined;
        if (records.length || overflow) {
          await new Promise<void>((resolve) => {
            drained = resolve;
            deadline = setTimeout(resolve, flushMs);
          });
        }
        clearTimeout(deadline);
        drained = undefined;
        stopped = true;
        clearTimeout(retry);
        sending?.abort();
        const remaining = records.length + (overflow ? 1 : 0);
        const overflowCount = records.reduce(
          (sum, record) =>
            sum +
            ("note" in record && record.note === "overflow" ? record.count : 0),
          overflow?.count ?? 0,
        );
        if (remaining)
          options.log(
            `observations: ${remaining} not delivered at close${overflowCount ? ` overflow ${overflowCount}` : ""}`,
          );
        records.length = 0;
        overflow = undefined;
      })();
      return closePromise;
    },
    get rejected(): number {
      return rejected;
    },
  };
}
export type Observations = ReturnType<typeof createObservations>;
