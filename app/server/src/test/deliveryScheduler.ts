import { automaticTurnsHeld } from "../automaticTurnHold.ts";
import { BackgroundCompletionDelivery } from "../backgroundWork/completionDelivery.ts";
import { createDeliveryScheduler } from "../deliveryScheduler.ts";
import { setDeliveryWake } from "../deliveryWake.ts";
import type { PromptQueueDriver } from "../promptQueue.ts";
import type { RuntimePromptDriver } from "../session/runtimePrompt.ts";
import { sessionDeliveryLanes } from "../sessionDeliveryLanes.ts";

/** Real SQLite lanes use the same admission path as production. */
export function installDeliveryTestScheduler(options: {
  live(id: string): RuntimePromptDriver | undefined;
  acquire(id: string): Promise<RuntimePromptDriver | undefined>;
  shutdown?(): boolean;
}) {
  const background = new BackgroundCompletionDelivery({
    drainPeers: async () => {},
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
  setDeliveryWake((id) => {
    void scheduler.wake(id);
  });
  return scheduler;
}
