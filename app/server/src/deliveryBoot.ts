interface BootScheduler {
  wake(sessionId: string): Promise<void>;
  offerReminders(sessionId: string): Promise<void>;
  boot(sessionIds: Iterable<string>): Promise<void>;
}

/** Collect cheap recovery offers, not the operations recovery may execute. */
export function createDeliveryBoot(scheduler: BootScheduler) {
  let collecting = true;
  const sessions = new Map<string, boolean>();
  return {
    offer(sessionId: string, reminders = false): void {
      if (collecting) {
        sessions.set(sessionId, reminders || sessions.get(sessionId) === true);
      } else if (reminders) void scheduler.offerReminders(sessionId);
      else void scheduler.wake(sessionId);
    },
    release(): Promise<void> {
      if (!collecting) return Promise.resolve();
      collecting = false;
      const plain: string[] = [];
      const reminders: string[] = [];
      for (const [id, enabled] of sessions)
        (enabled ? reminders : plain).push(id);
      sessions.clear();
      return Promise.all([
        scheduler.boot(plain),
        ...reminders.map((id) => scheduler.offerReminders(id)),
      ]).then(() => {});
    },
  };
}
