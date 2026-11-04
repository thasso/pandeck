/**
 * The transcript the reader last touched. A scroll key with nothing focused in a
 * transcript scrolls this one, so a second transcript on the page (a right-panel
 * chat) must not take that key for its own reader's input.
 */
let owner: HTMLElement | null = null;

function isOnScreen(element: HTMLElement | null): boolean {
  return Boolean(element?.isConnected && element.getClientRects().length > 0);
}

export function claimScrollKeys(element: HTMLElement): void {
  owner = element;
}

/** Whether a scroll key at `target` moves this transcript. */
export function ownsScrollKey(
  element: HTMLElement,
  target: HTMLElement | null,
): boolean {
  if ((target && element.contains(target)) || !isOnScreen(owner))
    owner = element;
  return owner === element;
}
