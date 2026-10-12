/**
 * What the Sessions inbox's counts bar says, handed from the inbox (which
 * shapes the list the counts come from) to the host that draws the bar above
 * its scroll container (`Sidebar.tsx`).
 *
 * A store rather than host state: the counts move with the session list, and
 * only the bar has to redraw for them — never the host around the list, whose
 * every prop is held referentially stable (`app/web/src/CLAUDE.md`). An
 * unchanged answer notifies no one.
 */
interface SessionInboxBarFacts {
  needsYou: number;
  working: number;
  background: { activeCount: number; ownerCount: number };
  /** Focuses the first card the Needs-you count stands for. Stable. */
  onNeedsYou: () => void;
}

export interface SessionInboxBarStore {
  get: () => SessionInboxBarFacts | null;
  set: (facts: SessionInboxBarFacts | null) => void;
  subscribe: (listener: () => void) => () => void;
}

function sameFacts(
  a: SessionInboxBarFacts | null,
  b: SessionInboxBarFacts | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.needsYou === b.needsYou &&
    a.working === b.working &&
    a.background.activeCount === b.background.activeCount &&
    a.background.ownerCount === b.background.ownerCount &&
    a.onNeedsYou === b.onNeedsYou
  );
}

export function createSessionInboxBarStore(): SessionInboxBarStore {
  let facts: SessionInboxBarFacts | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => facts,
    set: (next) => {
      if (sameFacts(facts, next)) return;
      facts = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
