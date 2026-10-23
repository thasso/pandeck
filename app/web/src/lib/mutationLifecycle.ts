import { createClientId } from "./clientId.ts";

type Outcome =
  | { type: "settled" }
  | { type: "error"; message: string }
  | { type: "timeout" }
  | { type: "unknown" };

interface Effects {
  topic: string;
  additionalEffects?: readonly { topic: string }[];
}

interface Descriptor<Context> {
  context: Context;
  timeoutMs: number;
  recover: (context: Context) => void;
  terminal: (outcome: Outcome, context: Context, requestId: string) => void;
  /** Opting in is domain policy, not a property of a touched topic. */
  disconnected?: (context: Context) => void;
}

/** One identity, timer and remove-before-callback transition per write. */
export function createMutationLifecycle<Context extends Effects>() {
  const pending = new Map<
    string,
    Descriptor<Context> & { timer: ReturnType<typeof setTimeout> }
  >();
  let recoveries: Array<{
    context: Context;
    recover: (context: Context) => void;
  }> = [];

  const finish = (requestId: string, outcome: Outcome) => {
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
    entry.terminal(outcome, entry.context, requestId);
    return entry.context;
  };

  return {
    start(descriptor: Descriptor<Context>): string {
      const requestId = createClientId();
      pending.set(requestId, {
        ...descriptor,
        timer: setTimeout(
          () => finish(requestId, { type: "timeout" }),
          descriptor.timeoutMs,
        ),
      });
      return requestId;
    },
    finish,
    get: (requestId: string) => pending.get(requestId)?.context,
    get size() {
      return pending.size;
    },
    pendingTopics(): ReadonlySet<string> {
      return new Set(
        [...pending.values()].flatMap(({ context }) => [
          context.topic,
          ...(context.additionalEffects?.map((effect) => effect.topic) ?? []),
        ]),
      );
    },
    recoveryTopics(): ReadonlySet<string> {
      return new Set(recoveries.map(({ context }) => context.topic));
    },
    disconnect() {
      for (const [requestId, entry] of [...pending])
        if (entry.disconnected) finish(requestId, { type: "unknown" });
    },
    reconnect() {
      const queued = recoveries;
      recoveries = [];
      for (const { context, recover } of queued) recover(context);
    },
    /** Effect teardown abandons migrated writes, not the staged legacy paths. */
    cleanup() {
      for (const [requestId, entry] of [...pending])
        if (entry.disconnected) finish(requestId, { type: "unknown" });
      recoveries = [];
    },
  };
}
