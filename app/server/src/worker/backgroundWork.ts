/**
 * The Worker's background-work table (`docs/workers.md`): the items this
 * Worker executes for its engines, by PA item id. The table knows no harness;
 * an engine hands it a runner with each admission, and the server owns the
 * row, Stop and output evidence.
 *
 * - An admission reserves its runner under a fresh launch key until the
 *   server's answer settles, whatever it says; `backgroundWork.launch` names
 *   that key, so admission and launch stay one span on the server.
 * - A launched item stays held until its work is done and every report it
 *   made has settled. `stop` and `stopAll` act only on held items of the
 *   named owner and answer once that holds, so an item's output evidence
 *   always reaches the server before its Stop is answered.
 * - One item's reports go out in order, each after the previous answer, and
 *   the first only once its admission's answer arrived: by then the server
 *   has recorded the item running. A failed report is logged and dropped.
 * - On connection end every held item is stopped and every reservation
 *   dropped; their reports are lost with the connection.
 */
import { errorText } from "../errors.ts";
import {
  BACKGROUND_WORK_METHODS,
  decodeAdmitAnswer,
  decodeLaunch,
  decodeReportAcknowledgement,
  decodeStop,
  decodeStopAll,
  encodeBackgroundWork,
  type BackgroundWorkAdmitter,
  type BackgroundWorkReporter,
  type BackgroundWorkRun,
  type BackgroundWorkRunner,
} from "../workerProtocol/backgroundWorkMethods.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import type { MethodHandlers } from "../workerProtocol/connection.ts";

/** Today's answer to a launch whose reservation is gone. */
const RESERVATION_GONE = "the pi launch reservation is no longer available";
/** Today's answer to a Stop of an item this Worker does not hold for its owner. */
const UNAVAILABLE = "the owned process group or socket is unavailable";

type Send = (
  method: string,
  payload: Payload,
  signal?: AbortSignal,
) => Promise<Payload>;

interface Reservation {
  runner: BackgroundWorkRunner;
  /** Settles once the admission's answer arrived or failed. */
  answered: Promise<void>;
}

interface Held {
  ownerSessionId: string;
  run: BackgroundWorkRun;
  /** Settles once the work is done and every report it made has settled. */
  settled: Promise<void>;
}

/** One item's reports, each sent once the previous one settled. */
function reportChain(
  send: Send,
  itemId: string,
  first: Promise<void>,
): { reporter: BackgroundWorkReporter; drained(): Promise<void> } {
  let tail = first;
  const report = (method: string, value: object): Promise<void> => {
    const sent = tail
      .then(() => send(method, encodeBackgroundWork({ ...value, itemId })))
      .then((answer) => decodeReportAcknowledgement(method, answer))
      .catch((error: unknown) =>
        console.warn(
          `[background] ${method} report failed for ${itemId}: ${errorText(error)}`,
        ),
      );
    tail = sent;
    return sent;
  };
  return {
    reporter: {
      activity: (activity) =>
        void report(BACKGROUND_WORK_METHODS.activity, activity),
      rateExceeded: (event) =>
        void report(BACKGROUND_WORK_METHODS.rateExceeded, event),
      output: (output) => report(BACKGROUND_WORK_METHODS.output, output),
      completed: (completion) =>
        void report(BACKGROUND_WORK_METHODS.completed, completion),
    },
    async drained() {
      let seen: Promise<void>;
      do {
        seen = tail;
        await seen;
      } while (seen !== tail);
    },
  };
}

/** Stop `held`; true once its work and reports are done. */
async function stopHeld(held: Held): Promise<true> {
  await held.run.stop();
  await held.settled;
  return true;
}

export function backgroundWorkTable(send: Send): {
  /** What each engine on this Worker admits its background work through. */
  admitter: BackgroundWorkAdmitter;
  handlers: MethodHandlers;
  end(): void;
} {
  const reservations = new Map<string, Reservation>();
  const items = new Map<string, Held>();
  let keys = 0;
  let ended = false;

  const admitter: BackgroundWorkAdmitter = {
    async admit(request, runner, signal) {
      if (ended) throw new Error("The Worker connection ended.");
      keys += 1;
      const launchKey = `launch-${keys}`;
      let answered!: () => void;
      reservations.set(launchKey, {
        runner,
        answered: new Promise<void>((resolve) => (answered = resolve)),
      });
      try {
        return decodeAdmitAnswer(
          await send(
            BACKGROUND_WORK_METHODS.admit,
            encodeBackgroundWork({ ...request, launchKey }),
            signal,
          ),
        );
      } finally {
        reservations.delete(launchKey);
        answered();
      }
    },
  };

  const handlers: MethodHandlers = {
    [BACKGROUND_WORK_METHODS.launch]: async (payload) => {
      const { launchKey, request } = decodeLaunch(payload);
      const { itemId, ownerSessionId, kind } = request.target;
      const reservation = reservations.get(launchKey);
      if (
        ended ||
        !reservation ||
        reservation.runner.ownerSessionId !== ownerSessionId ||
        reservation.runner.kind !== kind ||
        items.has(itemId)
      )
        return encodeBackgroundWork({
          launched: false,
          reason: RESERVATION_GONE,
        });
      reservations.delete(launchKey);
      const reports = reportChain(send, itemId, reservation.answered);
      const started = await reservation.runner.launch(
        request,
        reports.reporter,
      );
      if (!started.launched)
        return encodeBackgroundWork({
          launched: false,
          ...(started.reason !== undefined ? { reason: started.reason } : {}),
        });
      const { run } = started;
      const held: Held = {
        ownerSessionId,
        run,
        settled: run.done.then(reports.drained, reports.drained),
      };
      items.set(itemId, held);
      void held.settled.finally(() => {
        if (items.get(itemId) === held) items.delete(itemId);
      });
      // The connection ended while the runner started: nobody can stop it.
      if (ended) void run.stop().catch(() => undefined);
      return encodeBackgroundWork({ launched: true });
    },
    [BACKGROUND_WORK_METHODS.stop]: async (payload) => {
      const { target } = decodeStop(payload);
      const held = items.get(target.itemId);
      if (!held || held.ownerSessionId !== target.ownerSessionId)
        return encodeBackgroundWork({
          acknowledged: false,
          evidence: UNAVAILABLE,
        });
      try {
        return encodeBackgroundWork({ acknowledged: await stopHeld(held) });
      } catch (error) {
        return encodeBackgroundWork({
          acknowledged: false,
          evidence:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Stop failed",
        });
      }
    },
    [BACKGROUND_WORK_METHODS.stopAll]: async (payload) => {
      const request = decodeStopAll(payload);
      const reserved = new Set(request.itemIds);
      const targets = [...items].filter(
        ([itemId, held]) =>
          reserved.has(itemId) &&
          held.ownerSessionId === request.ownerSessionId,
      );
      const acknowledgedItemIds: string[] = [];
      const unconfirmedItemIds: string[] = [];
      await Promise.all(
        targets.map(async ([itemId, held]) => {
          try {
            await stopHeld(held);
            acknowledgedItemIds.push(itemId);
          } catch {
            unconfirmedItemIds.push(itemId);
          }
        }),
      );
      return encodeBackgroundWork({ acknowledgedItemIds, unconfirmedItemIds });
    },
  };

  return {
    admitter,
    handlers,
    end() {
      ended = true;
      reservations.clear();
      for (const held of items.values())
        void held.run.stop().catch(() => undefined);
    },
  };
}
