/** Installed at boot. Isolated lane tests can still drive their private drains. */
let wake: ((sessionId: string) => void) | undefined;

export function setDeliveryWake(next: typeof wake): void {
  wake = next;
}

/** True when the scheduler owns this offer; false before boot wiring. */
export function wakeSessionDelivery(sessionId: string): boolean {
  if (!wake) return false;
  wake(sessionId);
  return true;
}
