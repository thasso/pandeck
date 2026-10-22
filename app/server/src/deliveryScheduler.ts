/** Per-session admission. Lanes retain their own storage and delivery policy. */
export interface DeliverySession {
  readonly sessionId: string;
  readonly isRunning: boolean;
  readonly canSteer: boolean;
  readonly released?: boolean;
}

export type DeliveryResult = "none" | "turn" | "steer";

export interface DeliveryAcquisitionFailure {
  kind: "error" | "unavailable";
  reason: unknown;
}

export interface DeliveryLane<Session extends DeliverySession> {
  readonly name: string;
  readonly mayJoinRunningTurn: boolean;
  /** Cheap and harness-free. */
  owes(sessionId: string): boolean;
  deliver(session: Session): Promise<DeliveryResult>;
  /** Interpret the shared acquisition failure without acquiring again. */
  unavailable?(
    sessionId: string,
    failure: DeliveryAcquisitionFailure,
  ): void | Promise<void>;
}

interface DeliverySchedulerOptions<Session extends DeliverySession> {
  lanes: readonly DeliveryLane<Session>[];
  reminder: DeliveryLane<Session>;
  /** Settle earlier admitted drains before an idle pass reads shared state. */
  settleEarlierDeliveries(sessionId: string): Promise<void>;
  runAutoApprovals(sessionId: string): Promise<unknown>;
  live(sessionId: string): Session | undefined;
  acquire(sessionId: string): Promise<Session | undefined>;
  held(sessionId: string): boolean;
  shutdown(): boolean;
  reportError(sessionId: string, lane: string, error: unknown): void;
}

export function createDeliveryScheduler<Session extends DeliverySession>(
  options: DeliverySchedulerOptions<Session>,
) {
  const passes = new Map<string, Promise<void>>();
  const wakes = new Set<string>();
  const reminders = new Set<string>();

  async function pass(sessionId: string): Promise<void> {
    // Idle edges precede prompt settlement. A fresh pass must not reuse an
    // earlier fenced drain. Running joinable offers must not wait for the turn
    // they may steer. Read shared state only after the wait, including Stop.
    if (!options.live(sessionId)?.isRunning)
      await options.settleEarlierDeliveries(sessionId);
    if (options.shutdown()) return;
    let session = options.live(sessionId);
    let running = session?.isRunning ?? false;
    let canSteer = session?.canSteer ?? false;
    // Approval executors require an idle session, but run even under Stop.
    if (!running) {
      try {
        await options.runAutoApprovals(sessionId);
      } catch (error) {
        options.reportError(sessionId, "auto-approvals", error);
      }
    }
    if (options.held(sessionId)) return;
    const withReminder = reminders.delete(sessionId);
    // Reminders never open a harness of their own.
    const lanes =
      withReminder && session
        ? [...options.lanes, options.reminder]
        : options.lanes;
    // No debt means no cold acquisition, including boot and view-only wakes.
    const owed = lanes.filter(
      (lane) =>
        (!running || (canSteer && lane.mayJoinRunningTurn)) &&
        lane.owes(sessionId),
    );
    if (owed.length === 0) return;
    if (!session) {
      let failure: DeliveryAcquisitionFailure | undefined;
      try {
        session = await options.acquire(sessionId);
        if (!session)
          failure = {
            kind: "unavailable",
            reason: new Error("target session could not be resumed"),
          };
      } catch (reason) {
        failure = { kind: "error", reason };
      }
      if (failure) {
        options.reportError(sessionId, "acquire", failure.reason);
        for (const lane of owed) {
          try {
            await lane.unavailable?.(sessionId, failure);
          } catch (error) {
            options.reportError(sessionId, lane.name, error);
          }
        }
        return;
      }
      if (!session) return;
      running = session.isRunning;
      canSteer = session.canSteer;
    }
    if (session.released || (running && !canSteer)) return;
    for (const lane of owed) {
      if (running && !lane.mayJoinRunningTurn) continue;
      try {
        if ((await lane.deliver(session)) === "turn") return;
      } catch (error) {
        // A lane owns retries. One refused delivery must not block the others.
        options.reportError(sessionId, lane.name, error);
      }
    }
  }

  function wake(sessionId: string): Promise<void> {
    wakes.add(sessionId);
    const existing = passes.get(sessionId);
    if (existing) return existing;
    // Install the gate before any synchronous lane callback can wake it again.
    const run = Promise.resolve().then(async () => {
      try {
        do {
          wakes.delete(sessionId);
          try {
            await pass(sessionId);
          } catch (error) {
            options.reportError(sessionId, "pass", error);
          }
        } while (wakes.has(sessionId) && !options.shutdown());
      } finally {
        passes.delete(sessionId);
        wakes.delete(sessionId);
      }
    });
    passes.set(sessionId, run);
    return run;
  }

  return {
    wake,
    /** Only real idle edges, Resume and the reminder's own re-offer call this. */
    offerReminders(sessionId: string): Promise<void> {
      reminders.add(sessionId);
      return wake(sessionId);
    },
    /** Ordered within a session, with no cross-session wait. No boot reminders. */
    boot(sessionIds: Iterable<string>): Promise<void> {
      return Promise.all([...new Set(sessionIds)].map(wake)).then(() => {});
    },
  };
}
