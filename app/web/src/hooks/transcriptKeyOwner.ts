const transcripts = new Set<HTMLElement>();

/**
 * The transcript the reader last touched. A scroll key with nothing focused in a
 * transcript scrolls this one, so a second transcript on the page (a right-panel
 * chat) must not take that key for its own reader's input.
 */
let owner: HTMLElement | null = null;

function isOnScreen(element: HTMLElement | null): boolean {
  return Boolean(element?.isConnected && element.getClientRects().length > 0);
}

/** A mounted transcript, known so a key inside it is its own. */
export function trackTranscript(element: HTMLElement): () => void {
  transcripts.add(element);
  return () => {
    transcripts.delete(element);
    if (owner === element) owner = null;
  };
}

export function claimScrollKeys(element: HTMLElement): void {
  owner = element;
}

/**
 * Whether a scroll key at `target` moves this transcript. Every transcript's
 * document listener asks about the same key, so the answer cannot depend on who
 * asks first: a target inside a transcript settles it for all of them.
 */
export function ownsScrollKey(
  element: HTMLElement,
  target: HTMLElement | null,
): boolean {
  const holder =
    target && [...transcripts].find((item) => item.contains(target));
  if (holder) owner = holder;
  // A retained panel stays mounted behind its tab, and its listener still runs.
  else if (!isOnScreen(owner) && isOnScreen(element)) owner = element;
  return owner === element && isOnScreen(element);
}
