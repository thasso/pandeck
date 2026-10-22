/** Installed at boot. Without it automatic offers cannot admit work. */
let wake:
  | ((sessionId: string, reminders?: boolean, endedRunId?: string) => void)
  | undefined;

export function setDeliveryWake(next: typeof wake): void {
  wake = next;
}

/** True when the scheduler owns this offer; false before boot wiring. */
export function wakeSessionDelivery(
  sessionId: string,
  reminders = false,
  endedRunId?: string,
): boolean {
  if (!wake) return false;
  wake(sessionId, reminders, endedRunId);
  return true;
}
