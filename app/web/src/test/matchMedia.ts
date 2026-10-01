/**
 * jsdom has no `window.matchMedia`. This installs one whose queries answer
 * `matches(query)`, read on every access so a test can flip it, and returns the
 * way to tell a query's listeners that its answer changed.
 */
export function stubMatchMedia(
  matches: (query: string) => boolean = () => false,
): (query: string) => void {
  const listeners = new Map<string, Set<() => void>>();
  const of = (query: string) => {
    let set = listeners.get(query);
    if (!set) listeners.set(query, (set = new Set()));
    return set;
  };
  window.matchMedia = ((query: string) => ({
    get matches() {
      return matches(query);
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: () => void) =>
      of(query).add(listener),
    removeEventListener: (_type: string, listener: () => void) =>
      of(query).delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return (query) => {
    for (const listener of [...of(query)]) listener();
  };
}
