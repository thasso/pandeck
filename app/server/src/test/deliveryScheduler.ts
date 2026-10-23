import { automaticTurnsHeld } from "../automaticTurnHold.ts";
import { BackgroundCompletionDelivery } from "../backgroundWork/completionDelivery.ts";
import { createDeliveryScheduler } from "../deliveryScheduler.ts";
import { setDeliveryWake } from "../deliveryWake.ts";
import type { PromptQueueDriver } from "../promptQueue.ts";
import type { RuntimePromptDriver } from "../session/runtimePrompt.ts";
import { sessionDeliveryLanes } from "../sessionDeliveryLanes.ts";
import { settleSessionDeliveries } from "../deliverySettlement.ts";

/** Real SQLite lanes use the same admission path as production. */
export function installDeliveryTestScheduler(options: {
  live(id: string): RuntimePromptDriver | undefined;
  acquire(id: string): Promise<RuntimePromptDriver | undefined>;
  shutdown?(): boolean;
  background?: BackgroundCompletionDelivery;
}) {
  const background =
    options.background ??
    new BackgroundCompletionDelivery({
      offer: async () => "busy",
    });
  const scheduler = createDeliveryScheduler({
    ...sessionDeliveryLanes(background),
    live: (id) => options.live(id) as PromptQueueDriver | undefined,
    acquire: async (id) =>
      (await options.acquire(id)) as PromptQueueDriver | undefined,
    runAutoApprovals: async () => {},
    held: automaticTurnsHeld,
    shutdown: options.shutdown ?? (() => false),
    reportError: () => {},
  });
  const latest = new Map<string, Promise<void>>();
  function offer(id: string, reminders = false, endedRunId?: string) {
    const run = reminders
      ? scheduler.offerReminders(id, endedRunId)
      : scheduler.wake(id, endedRunId);
    latest.set(id, run);
    return run;
  }
  setDeliveryWake((id, reminders, endedRunId) => {
    void offer(id, reminders, endedRunId);
  });
  return {
    ...scheduler,
    wake: (id: string, endedRunId?: string) => offer(id, false, endedRunId),
    offerReminders: (id: string, endedRunId?: string) =>
      offer(id, true, endedRunId),
    async drain(sessionId: string, reminders = false): Promise<void> {
      let run = offer(sessionId, reminders);
      for (;;) {
        await run;
        await settleSessionDeliveries(sessionId);
        const next = latest.get(sessionId)!;
        if (next === run) return;
        run = next;
      }
    },
  };
}
