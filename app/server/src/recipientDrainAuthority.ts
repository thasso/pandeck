/** Explicit peer send-now reservations shared with every recipient drain. */
const waiters = new Map<string, number>();
const active = new Set<string>();
const authorityWaiters = new Map<string, Set<() => void>>();

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
  notifyAuthorityReleased(sessionId);
}

/** Wait until no explicit send-now owns or awaits recipient authority. */
export function waitForExplicitRecipientAuthorityRelease(
  sessionId: string,
): Promise<void> {
  if (!hasExplicitRecipientAuthority(sessionId)) return Promise.resolve();
  return new Promise((resolve) => {
    const listeners = authorityWaiters.get(sessionId) ?? new Set();
    listeners.add(resolve);
    authorityWaiters.set(sessionId, listeners);
  });
}

function notifyAuthorityReleased(sessionId: string): void {
  if (hasExplicitRecipientAuthority(sessionId)) return;
  const listeners = authorityWaiters.get(sessionId);
  if (!listeners) return;
  authorityWaiters.delete(sessionId);
  for (const resolve of listeners) resolve();
}

/** A queue drain must yield while an explicit peer send owns or awaits authority. */
export function hasExplicitRecipientAuthority(sessionId: string): boolean {
  return active.has(sessionId) || (waiters.get(sessionId) ?? 0) > 0;
}
