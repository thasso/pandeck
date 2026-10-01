import { useSyncExternalStore } from "react";
import { subscribeHistoryNav } from "../lib/historyNav.ts";

/**
 * The URL's fragment, as a value that changes whenever the browser moves.
 *
 * A fragment is the one part of the address that can move under an UNCHANGED
 * route (`/sessions/:id#m-<entryId>` — see `app/web/docs/ui-shell.md`), so
 * nothing derived from the parsed route notices it: back/forward between two
 * messages of one session changes no route field at all. Reading it through an
 * external store is what makes it observable, because every source of the change
 * is outside React.
 *
 * All three sources are subscribed, because each covers a case the others miss:
 * `popstate` for the arrows, `hashchange` for a fragment edited or linked
 * bare — and `historyNav` for the app's own `pushState`, which fires neither.
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener("hashchange", onChange);
  const unsubscribeNav = subscribeHistoryNav(onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener("hashchange", onChange);
    unsubscribeNav();
  };
}

export function useLocationHash(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
}
