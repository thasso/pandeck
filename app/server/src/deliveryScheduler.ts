/** Per-session admission. Lanes retain their own storage and delivery policy. */
export interface DeliverySession {
  readonly sessionId: string;
  readonly isRunning: boolean;
  readonly canSteer: boolean;
  readonly released?: boolean;
}

/** Deferred admission waits for explicit-send authority's release wake. */
export type DeliveryResult = "none" | "turn" | "steer" | "deferred";
type DeliveryAdmissionFailure =
  | "shutdown"
  | "held"
  | "released"
  | "not-promptable"
  | "running"
  | "earlier-debt";
export type DeliveryAdmissionCheck = () => DeliveryAdmissionFailure | undefined;

export interface DeliveryAcquisitionFailure {
  kind: "error" | "unavailable";
  reason: unknown;
}

export interface DeliveryLane<Session extends DeliverySession> {
  readonly name: string;
  readonly mayJoinRunningTurn: boolean;
  /** Cheap and harness-free. */
  owes(sessionId: string): boolean;
  /** Lane-owned retry/self-edge policy, separate from priority debt. */
  offerable?(sessionId: string, endedRunId?: string): boolean;
  deliver(
    session: Session,
    checkAdmission: DeliveryAdmissionCheck,
  ): Promise<DeliveryResult>;
  /** Interpret the shared acquisition failure without acquiring again. */
  unavailable?(
    sessionId: string,
    failure: DeliveryAcquisitionFailure,
  ): void | Promise<void>;
}

interface DeliverySchedulerOptions<Session extends DeliverySession> {
  lanes: readonly DeliveryLane<Session>[];
  reminder: DeliveryLane<Session>;
  /** A declined lane with debt remaining defers these lanes for this pass. */
  deferOnDecline?: Readonly<Record<string, readonly string[]>>;
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
  // Only a single real idle edge retains its run identity. Any coalesced
  // wake makes the next pass unrelated, even when it arrived in the same turn.
  const wakes = new Map<string, string | undefined>();
  const reminders = new Set<string>();

  // One owner for changing admission state. A missing driver is cold before
  // acquisition and unpromptable after it; neither is a delivery target.
  function sharedChecks(sessionId: string, session: Session | undefined) {
    const running = session?.isRunning ?? false;
    const canSteer = session?.canSteer ?? false;
    const shutdown = options.shutdown();
    const held = options.held(sessionId);
    const failure: DeliveryAdmissionFailure | undefined = shutdown
      ? "shutdown"
      : held
        ? "held"
        : !session
          ? "not-promptable"
          : session.released
            ? "released"
            : running && !canSteer
              ? "running"
              : undefined;
    return {
      session,
      running,
      canSteer,
      shutdown,
      held,
      failure,
      admissible: failure === undefined,
    };
  }

  async function pass(sessionId: string, endedRunId?: string): Promise<void> {
    // Idle edges precede prompt settlement. A fresh pass must not reuse an
    // earlier fenced drain. Running joinable offers must not wait for the turn
    // they may steer. Read shared state only after the wait, including Stop.
    if (!options.live(sessionId)?.isRunning)
      await options.settleEarlierDeliveries(sessionId);
    let state = sharedChecks(sessionId, options.live(sessionId));
    if (state.shutdown) return;
    // Approval executors require an idle session, but run even under Stop.
    if (!state.running) {
      try {
        await options.runAutoApprovals(sessionId);
      } catch (error) {
        options.reportError(sessionId, "auto-approvals", error);
      }
    }
    // The pre-pass can resume a driver, or Stop/shutdown can land while it
    // awaits. Do not carry its earlier live/running snapshot into admission.
    state = sharedChecks(sessionId, options.live(sessionId));
    if (state.shutdown || state.held) return;
    let session = state.session;
    const withReminder = reminders.delete(sessionId);
    // Reminders never open a harness of their own.
    const lanes =
      withReminder && session
        ? [...options.lanes, options.reminder]
        : options.lanes;
    // No debt means no cold acquisition, including boot and view-only wakes.
    const owed = lanes.filter(
      (lane) =>
        (!state.running || (state.canSteer && lane.mayJoinRunningTurn)) &&
        lane.owes(sessionId) &&
        lane.offerable?.(sessionId, endedRunId) !== false,
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
      state = sharedChecks(sessionId, session);
      if (failure) {
        // Failure hooks cannot admit work. Keep their lane-owned accounting,
        // including Stop/shutdown guards, even if admission changed in acquire.
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
      if (!state.admissible || !session) return;
    }
    const deferred = new Set<string>();
    for (const lane of owed) {
      // The selected driver's getters stay live across awaits. In particular,
      // a refused lane must not admit its successor using an old idle snapshot.
      state = sharedChecks(sessionId, session);
      if (!state.admissible) return;
      if (state.running && !lane.mayJoinRunningTurn) continue;
      if (deferred.has(lane.name)) continue;
      let result: DeliveryResult = "none";
      try {
        const selected = session;
        result = await lane.deliver(session, () => {
          const current = sharedChecks(sessionId, selected);
          if (current.failure) return current.failure;
          if (current.running && !lane.mayJoinRunningTurn) return "running";
          // Only reminders yield to debt arriving during their preparation.
          // Its producer already marked the next pass; retain eligibility for it.
          if (
            lane === options.reminder &&
            options.lanes.some((prior) => prior.owes(sessionId))
          ) {
            if (wakes.has(sessionId)) reminders.add(sessionId);
            return "earlier-debt";
          }
          return undefined;
        });
        const successors = options.deferOnDecline?.[lane.name];
        if (result === "none" && successors && lane.owes(sessionId))
          for (const name of successors) deferred.add(name);
      } catch (error) {
        // A lane owns retries. One refused delivery must not block the others.
        options.reportError(sessionId, lane.name, error);
      }
      if (result === "deferred") {
        // Authority may fence an earlier lane before we reach reminders, or
        // arrive during reminder preparation. Keep only an existing idle offer.
        // Release supplies the wake; retained eligibility must not spin itself.
        if (withReminder) reminders.add(sessionId);
        return;
      }
      state = sharedChecks(sessionId, session);
      if (result === "turn" || !state.admissible) return;
    }
  }

  function wake(sessionId: string, endedRunId?: string): Promise<void> {
    wakes.set(sessionId, wakes.has(sessionId) ? undefined : endedRunId);
    const existing = passes.get(sessionId);
    if (existing) return existing;
    // Install the gate before any synchronous lane callback can wake it again.
    const run = Promise.resolve().then(async () => {
      try {
        do {
          const endedRunId = wakes.get(sessionId);
          wakes.delete(sessionId);
          try {
            await pass(sessionId, endedRunId);
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
    offerReminders(sessionId: string, endedRunId?: string): Promise<void> {
      reminders.add(sessionId);
      return wake(sessionId, endedRunId);
    },
    /** Ordered within a session, with no cross-session wait. No boot reminders. */
    boot(sessionIds: Iterable<string>): Promise<void> {
      return Promise.all([...new Set(sessionIds)].map((id) => wake(id))).then(
        () => {},
      );
    },
  };
}
