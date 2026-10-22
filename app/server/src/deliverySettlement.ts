/** Unfinished admitted drains, shared by the scheduler and explicit send-now. */
const settling = new Map<
  string,
  Set<{ run: Promise<unknown>; peer: boolean }>
>();

export function trackDeliverySettlement(
  sessionId: string,
  run: Promise<unknown>,
  peer: boolean,
): void {
  const pending =
    settling.get(sessionId) ??
    new Set<{ run: Promise<unknown>; peer: boolean }>();
  settling.set(sessionId, pending);
  const entry = { run, peer };
  pending.add(entry);
  void run
    .finally(() => {
      pending.delete(entry);
      if (pending.size === 0) settling.delete(sessionId);
    })
    .catch(() => {});
}

export async function settleSessionDeliveries(
  sessionId: string,
  scope: "all" | "peer" = "all",
): Promise<void> {
  const earlier = [...(settling.get(sessionId) ?? [])]
    .filter((entry) => scope === "all" || entry.peer)
    .map((entry) => entry.run);
  if (earlier.length === 0) return;
  const warning = setTimeout(() => {
    console.warn(
      `[delivery] session ${sessionId} is idle but ${earlier.length} earlier drain(s) have not settled after 30s`,
    );
  }, 30_000);
  warning.unref?.();
  try {
    await Promise.all(earlier.map((run) => run.catch(() => {})));
  } finally {
    clearTimeout(warning);
  }
}
