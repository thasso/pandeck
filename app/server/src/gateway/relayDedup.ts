/** Client-scoped relay identity and delivery state, independent of the UI ring. */
export const RELAY_RID = /^([0-9a-f]{32}):([1-9][0-9]{0,14})$/;
const IDLE_MS = 6 * 60 * 60_000;
interface Boot {
  intervals: [number, number][];
  floor: number;
  lastActive: number;
  ack: number;
  dropped: number;
}

export function createRelayDedup(options: {
  now?: () => number;
  log(line: string): void;
  maxIntervals?: number;
}) {
  const now = options.now ?? Date.now;
  const clients = new Map<string, Map<string, Boot>>();
  const maxIntervals = options.maxIntervals ?? 4096;
  if (!Number.isSafeInteger(maxIntervals) || maxIntervals < 1)
    throw new Error("Invalid relay interval capacity.");
  function sweep(): void {
    const cutoff = now() - IDLE_MS;
    for (const [client, boots] of clients) {
      for (const [boot, state] of boots)
        if (state.lastActive <= cutoff) boots.delete(boot);
      if (!boots.size) clients.delete(client);
    }
  }
  function state(client: string, boot: string): Boot {
    let boots = clients.get(client);
    if (!boots) {
      boots = new Map();
      clients.set(client, boots);
    }
    const time = now();
    for (const [name, entry] of boots)
      if (time - entry.lastActive >= IDLE_MS) boots.delete(name);
    let entry = boots.get(boot);
    if (!entry)
      entry = { intervals: [], floor: 0, lastActive: time, ack: 0, dropped: 0 };
    entry.lastActive = time;
    // Map order is LRU even when the injected clock does not advance.
    boots.delete(boot);
    boots.set(boot, entry);
    while (boots.size > 64) boots.delete(boots.keys().next().value!);
    return entry;
  }
  const timer = setInterval(sweep, 10 * 60_000);
  timer.unref();
  return {
    enter(
      client: string,
      boot: string,
      n: number,
    ): "new" | "present" | "below-floor" {
      const entry = state(client, boot);
      if (n <= entry.floor) return "below-floor";
      const ranges = entry.intervals;
      let i = 0;
      while (i < ranges.length && ranges[i]![1] < n - 1) i++;
      const range = ranges[i];
      if (range && range[0] <= n && n <= range[1]) return "present";
      if (range && range[0] <= n + 1) {
        range[0] = Math.min(range[0], n);
        range[1] = Math.max(range[1], n);
      } else ranges.splice(i, 0, [n, n]);
      const next = ranges[i + 1];
      if (next && ranges[i]![1] + 1 >= next[0]) {
        ranges[i]![1] = next[1];
        ranges.splice(i + 1, 1);
      }
      while (ranges.length > maxIntervals) entry.floor = ranges.shift()![1];
      return "new";
    },
    ack(client: string, boot: string): number {
      return state(client, boot).ack;
    },
    acknowledge(client: string, boot: string, d: number): void {
      const entry = state(client, boot);
      entry.ack = Math.max(entry.ack, d);
    },
    /** Compaction can drop a genuine missing request. Never hide that loss. */
    dropped(client: string, boot: string, count: number): void {
      if (!count) return;
      const entry = state(client, boot);
      entry.dropped += count;
      options.log(
        `relay observations: client=${client} boot=${boot.slice(0, 8)} below-floor dropped=${count} total=${entry.dropped}`,
      );
    },
    close(): void {
      clearInterval(timer);
    },
  };
}
export type RelayDedup = ReturnType<typeof createRelayDedup>;
