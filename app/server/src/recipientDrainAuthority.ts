import { settleSessionDeliveries } from "./deliverySettlement.ts";
import { wakeSessionDelivery } from "./deliveryWake.ts";

/** Explicit peer send-now reservations shared with every recipient drain. */
const waiters = new Map<string, number>();
const active = new Set<string>();
const explicitSends = new Map<string, Promise<unknown>>();

/** Serialize user choices only. Automatic admission belongs to the scheduler. */
export async function withExplicitRecipientAuthority<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  markExplicitRecipientWaiter(sessionId);
  const earlier = explicitSends.get(sessionId);
  const run = (async () => {
    await earlier?.catch(() => {});
    await settleSessionDeliveries(sessionId, "peer");
    releaseExplicitRecipientWaiter(sessionId);
    markExplicitRecipientAuthority(sessionId);
    try {
      return await operation();
    } finally {
      clearExplicitRecipientAuthority(sessionId);
      wakeSessionDelivery(sessionId);
    }
  })();
  explicitSends.set(sessionId, run);
  try {
    return await run;
  } finally {
    if (explicitSends.get(sessionId) === run) explicitSends.delete(sessionId);
  }
}

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
