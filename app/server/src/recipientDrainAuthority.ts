/** Explicit peer send-now reservations shared with every recipient drain. */
const waiters = new Map<string, number>();
const active = new Set<string>();

export function markExplicitRecipientWaiter(sessionId: string): void {
  waiters.set(sessionId, (waiters.get(sessionId) ?? 0) + 1);
}

export function releaseExplicitRecipientWaiter(sessionId: string): void {
  const remaining = (waiters.get(sessionId) ?? 1) - 1;
  if (remaining > 0) waiters.set(sessionId, remaining);
  else waiters.delete(sessionId);
}

export function markExplicitRecipientAuthority(sessionId: string): void {
  active.add(sessionId);
}

export function clearExplicitRecipientAuthority(sessionId: string): void {
  active.delete(sessionId);
}

/** A queue drain must yield while an explicit peer send owns or awaits authority. */
export function hasExplicitRecipientAuthority(sessionId: string): boolean {
  return active.has(sessionId) || (waiters.get(sessionId) ?? 0) > 0;
}
