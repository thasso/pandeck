/**
 * Where we are in the app's own history, so back/forward controls can be drawn
 * as enabled or disabled.
 *
 * The platform gives no answer to "is there anything behind me?" — `history` is
 * write-only about its shape, deliberately, because reading it would leak the
 * user's browsing. So the app counts its OWN entries: every entry it creates is
 * stamped with an index, `deepest` remembers how far forward the user has ever
 * been, and the two together say which arrow is live. That is exact for
 * navigation inside the app, which is all the arrows claim to cover — an entry
 * from before the app loaded is simply not counted, and back stops there rather
 * than walking out of the app.
 *
 * Every history write goes through {@link pushEntry} / {@link replaceEntry}. A
 * bare `history.pushState` elsewhere is not a smaller version of this; it is an
 * entry with no index, which silently freezes the counter and leaves the arrows
 * pointing at the wrong places.
 *
 * `deepest` is kept in `sessionStorage` because a reload — now one keystroke
 * away in the native shell — resets module state while the forward entries it
 * describes survive in the real history.
 */

const DEEPEST_KEY = "assistant:nav-deepest";

export interface DocumentHistoryOrigin {
  /** App-owned history index of the route that opened the document. */
  index: number;
  /** Exact path, query and fragment used when no traversal is available. */
  href: string;
}

interface NavState {
  navIndex?: number;
  documentOrigin?: DocumentHistoryOrigin;
  documentScroll?: { top: number; left: number };
}

let index = 0;
let deepest = 0;
const listeners = new Set<() => void>();
/** Bumped on every change; the external-store snapshot has to be a value. */
let version = 0;
let pendingDocumentScroll:
  { entryIndex: number; top: number; left: number } | undefined;
let cancelDocumentScrollIdle: (() => void) | undefined;

function clearDocumentScrollTimer(): void {
  cancelDocumentScrollIdle?.();
  cancelDocumentScrollIdle = undefined;
}

/** Persist the latest coalesced outer-viewer offset, if still on its entry. */
export function flushDocumentScroll(): void {
  clearDocumentScrollTimer();
  const pending = pendingDocumentScroll;
  pendingDocumentScroll = undefined;
  if (!pending || currentIndex() !== pending.entryIndex) return;
  const state = window.history.state as NavState | null;
  window.history.replaceState(
    {
      ...state,
      navIndex: index,
      documentScroll: { top: pending.top, left: pending.left },
    },
    "",
  );
}

function readDeepest(): number {
  try {
    const raw = window.sessionStorage.getItem(DEEPEST_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    // Storage is unavailable in hardened/private modes. Forward simply stays
    // disabled after a reload, which is the conservative half of being wrong.
    return 0;
  }
}

function writeDeepest(value: number): void {
  try {
    window.sessionStorage.setItem(DEEPEST_KEY, String(value));
  } catch {
    // See readDeepest.
  }
}

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function currentIndex(): number {
  const state = window.history.state as NavState | null;
  return typeof state?.navIndex === "number" ? state.navIndex : 0;
}

/**
 * Adopt the entry the page loaded on. Called once at startup: a fresh load has
 * no index (start at zero), while a reload lands back on an entry that already
 * carries one and must resume from it rather than restart the count.
 */
export function initHistoryNav(): void {
  const state = window.history.state as NavState | null;
  if (typeof state?.navIndex === "number") index = state.navIndex;
  else {
    index = 0;
    window.history.replaceState({ ...state, navIndex: 0 }, "");
  }
  deepest = Math.max(index, readDeepest());
  writeDeepest(deepest);
  window.addEventListener("popstate", () => {
    index = currentIndex();
    if (pendingDocumentScroll?.entryIndex !== index) {
      pendingDocumentScroll = undefined;
      clearDocumentScrollTimer();
    }
    notify();
  });
  notify();
}

/** A new entry. Anything that was forward of here is gone, as in any browser. */
export function pushEntry(path: string): void {
  flushDocumentScroll();
  index += 1;
  deepest = index;
  writeDeepest(deepest);
  window.history.pushState({ navIndex: index }, "", path);
  notify();
}

/**
 * Open another internal document. The first document records the exact entry
 * that opened it; document-to-document pushes carry that origin forward so
 * Close and Back stay different operations.
 */
export function pushDocumentEntry(path: string): void {
  flushDocumentScroll();
  const state = window.history.state as NavState | null;
  const documentOrigin = state?.documentOrigin ?? {
    index,
    href: `${window.location.pathname}${window.location.search}${window.location.hash}`,
  };
  index += 1;
  deepest = index;
  writeDeepest(deepest);
  window.history.pushState({ navIndex: index, documentOrigin }, "", path);
  notify();
}

export function pushDocumentEntryAndAnnounce(path: string): void {
  pushDocumentEntry(path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Push an entry AND announce it, for a component with no access to the routing
 * hook's `navigate` — a served-file card rendered deep inside Markdown, whose
 * host chain carries no navigation prop. `useSessionRouting` adopts a popped
 * URL by re-parsing `location` and cancelling any armed staged send, which is
 * exactly what `navigate` does, so the route state, the address bar and the
 * header's arrows stay in agreement. Prefer `navigate` wherever it is in scope.
 */
export function pushEntryAndAnnounce(path: string): void {
  pushEntry(path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Rewrite the current entry in place; the position does not move. */
export function replaceEntry(path: string): void {
  flushDocumentScroll();
  const state = window.history.state as NavState | null;
  window.history.replaceState({ ...state, navIndex: index }, "", path);
}

export function historyNavVersion(): number {
  return version;
}

export function canGoBack(): boolean {
  return index > 0;
}

export function canGoForward(): boolean {
  return index < deepest;
}

const HISTORY_TRAVERSAL_SETTLE_MS = 500;

/** Traverse Back and settle after popstate, with a bounded webview backstop. */
export function goBack(): void | Promise<void> {
  if (!canGoBack()) return;
  flushDocumentScroll();
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      window.removeEventListener("popstate", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, HISTORY_TRAVERSAL_SETTLE_MS);
    window.addEventListener("popstate", finish);
    window.history.back();
  });
}

export function goForward(): void {
  if (!canGoForward()) return;
  flushDocumentScroll();
  window.history.forward();
}

export function currentDocumentOrigin(): DocumentHistoryOrigin | undefined {
  const state = window.history.state as NavState | null;
  return state?.documentOrigin;
}

export function currentDocumentScroll():
  { top: number; left: number } | undefined {
  const state = window.history.state as NavState | null;
  return state?.documentScroll;
}

export function saveDocumentScroll(top: number, left: number): void {
  pendingDocumentScroll = { entryIndex: index, top, left };
  if (cancelDocumentScrollIdle) return;
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(flushDocumentScroll, {
      timeout: 250,
    });
    cancelDocumentScrollIdle = () => window.cancelIdleCallback(handle);
    return;
  }
  const handle = window.setTimeout(flushDocumentScroll, 150);
  cancelDocumentScrollIdle = () => window.clearTimeout(handle);
}

/** Close the document stack without consuming its entries, preserving Forward. */
export function closeDocument(fallback: string): void {
  flushDocumentScroll();
  const origin = currentDocumentOrigin();
  if (origin && origin.index < index) {
    window.history.go(origin.index - index);
    return;
  }
  pushEntryAndAnnounce(origin?.href ?? fallback);
}

export function subscribeHistoryNav(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: the module's counters are process-wide by design. */
export function resetHistoryNavForTests(): void {
  clearDocumentScrollTimer();
  pendingDocumentScroll = undefined;
  index = 0;
  deepest = 0;
  version = 0;
  listeners.clear();
}
