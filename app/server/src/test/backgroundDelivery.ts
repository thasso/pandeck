import {
  BackgroundCompletionDelivery,
  type BackgroundCompletionDeliveryOptions,
} from "../backgroundWork/completionDelivery.ts";
import { setDeliveryWake } from "../deliveryWake.ts";
import { createDeliveryScheduler } from "../deliveryScheduler.ts";

/** Queue-policy tests admit through the real scheduler with a recorder for the runtime. */
export class ScheduledBackgroundDelivery extends BackgroundCompletionDelivery {
  readonly scheduler;

  constructor(
    options: BackgroundCompletionDeliveryOptions & {
      held?(sessionId: string): boolean;
      beforeBackground?(sessionId: string): Promise<void>;
    },
  ) {
    super(options);
    let prepared = false;
    this.scheduler = createDeliveryScheduler({
      lanes: [
        {
          name: "background completions",
          mayJoinRunningTurn: true,
          owes: (id) => this.wakeOwed(id),
          deliver: async (session, shouldStart) => {
            await super.drain(
              session.sessionId,
              () => shouldStart() === undefined,
            );
            return "none";
          },
        },
      ],
      reminder: {
        name: "reminders",
        mayJoinRunningTurn: false,
        owes: () => false,
        deliver: async () => "none",
      },
      settleEarlierDeliveries: async () => {},
      runAutoApprovals: async (id) => {
        if (prepared) return;
        prepared = true;
        await options.beforeBackground?.(id);
      },
      live: (sessionId) => ({ sessionId, isRunning: false, canSteer: false }),
      acquire: async () => undefined,
      held: options.held ?? (() => false),
      shutdown: () => false,
      reportError: () => {},
    });
    setDeliveryWake((id) => void this.scheduler.wake(id));
  }

  override drain(
    sessionId: string,
    shouldStart?: () => boolean,
  ): Promise<void> {
    return shouldStart
      ? super.drain(sessionId, shouldStart)
      : this.scheduler.wake(sessionId);
  }
}
