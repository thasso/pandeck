import { createClientId } from "./clientId.ts";

type Outcome =
  | { type: "settled" }
  | { type: "error"; message: string }
  | { type: "timeout" }
  | { type: "unknown" };

interface Effects {
  topic?: string;
  additionalEffects?: readonly { topic: string }[];
}

interface Descriptor<Context, Observation> {
  context: Context;
  timeoutMs: number;
  recover: (context: Context) => void;
  terminal: (
    outcome: Outcome,
    context: Context,
    requestId: string,
    observation?: Observation,
  ) => void;
  firstSettled?: () => void;
  done?: (settled: boolean, observation?: Observation) => boolean;
  /** Opting in is domain policy, not a property of a touched topic. */
  disconnected?: (context: Context) => void;
}

/** One identity, timer and remove-before-callback transition per write. */
export function createMutationLifecycle<
  Context extends Effects,
  Observation = never,
>() {
  const pending = new Map<
    string,
    Descriptor<Context, Observation> & {
      timer: ReturnType<typeof setTimeout>;
      settled: boolean;
    }
  >();
  let recoveries: Array<{
    context: Context;
    recover: (context: Context) => void;
  }> = [];

  const finish = (
    requestId: string,
    outcome: Outcome,
    observation?: Observation,
  ) => {
    const entry = pending.get(requestId);
    if (!entry) return undefined;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    if (outcome.type === "unknown") {
      recoveries.push({ context: entry.context, recover: entry.recover });
      entry.disconnected?.(entry.context);
    } else if (outcome.type === "error" || outcome.type === "timeout") {
      entry.recover(entry.context);
    }
    entry.terminal(outcome, entry.context, requestId, observation);
    return entry.context;
  };

  return {
    start(descriptor: Descriptor<Context, Observation>): string {
      const requestId = createClientId();
      pending.set(requestId, {
        ...descriptor,
        settled: false,
        timer: setTimeout(
          () => finish(requestId, { type: "timeout" }),
          descriptor.timeoutMs,
        ),
      });
      return requestId;
    },
    finish,
    settle(requestId: string) {
      const entry = pending.get(requestId);
      if (!entry || entry.settled) return;
      entry.settled = true;
      entry.firstSettled?.();
      if (pending.get(requestId) === entry && (!entry.done || entry.done(true)))
        finish(requestId, { type: "settled" });
    },
    observe(observation: Observation) {
      // Do not visit a new write started by a terminal hook in this pass.
      for (const [requestId, entry] of [...pending])
        if (
          pending.get(requestId) === entry &&
          entry.done?.(entry.settled, observation)
        )
          finish(requestId, { type: "settled" }, observation);
    },
    /** Raw object broadcasts belong to the oldest matching write only. */
    observeFirst(
      observation: Observation,
      matches: (context: Context) => boolean,
    ) {
      for (const [requestId, entry] of pending) {
        if (!matches(entry.context)) continue;
        if (entry.done?.(entry.settled, observation))
          finish(requestId, { type: "settled" }, observation);
        // Even an incomplete or reentrant completion must not expose the next
        // same-object write to this uncorrelated observation.
        break;
      }
    },
    get: (requestId: string) => pending.get(requestId)?.context,
    get size() {
      return pending.size;
    },
    pendingTopics(): ReadonlySet<string> {
      return new Set(
        [...pending.values()].flatMap(({ context }) => [
          ...(context.topic ? [context.topic] : []),
          ...(context.additionalEffects?.map((effect) => effect.topic) ?? []),
        ]),
      );
    },
    recoveryTopics(): ReadonlySet<string> {
      return new Set(
        recoveries.flatMap(({ context }) =>
          context.topic ? [context.topic] : [],
        ),
      );
    },
    /** The socket was lost: its sent writes' outcomes are unknown; `unsent` ones were never sent and stay pending. */
    disconnect(unsent: ReadonlySet<string> = new Set()) {
      for (const [requestId, entry] of [...pending])
        if (entry.disconnected && !unsent.has(requestId))
          finish(requestId, { type: "unknown" });
    },
    reconnect() {
      const queued = recoveries;
      recoveries = [];
      for (const { context, recover } of queued) recover(context);
    },
    /** Effect teardown abandons opted-in writes and their recovery obligations. */
    cleanup() {
      for (const [requestId, entry] of [...pending])
        if (entry.disconnected) finish(requestId, { type: "unknown" });
      recoveries = [];
    },
  };
}
