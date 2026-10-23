interface BootScheduler {
  wake(sessionId: string, endedRunId?: string): Promise<void>;
  offerReminders(sessionId: string, endedRunId?: string): Promise<void>;
}

/** Collect cheap recovery offers, not the operations recovery may execute. */
export function createDeliveryBoot(scheduler: BootScheduler) {
  let collecting = true;
  const sessions = new Map<
    string,
    { reminders: boolean; endedRunId: string | undefined }
  >();
  return {
    offer(sessionId: string, reminders = false, endedRunId?: string): void {
      if (collecting) {
        const prior = sessions.get(sessionId);
        sessions.set(sessionId, {
          reminders: reminders || prior?.reminders === true,
          endedRunId: prior ? undefined : endedRunId,
        });
      } else if (reminders)
        void scheduler.offerReminders(sessionId, endedRunId);
      else void scheduler.wake(sessionId, endedRunId);
    },
    release(): Promise<void> {
      if (!collecting) return Promise.resolve();
      collecting = false;
      const offers = [...sessions].map(([id, offer]) =>
        offer.reminders
          ? scheduler.offerReminders(id, offer.endedRunId)
          : scheduler.wake(id, offer.endedRunId),
      );
      sessions.clear();
      return Promise.all(offers).then(() => {});
    },
  };
}
