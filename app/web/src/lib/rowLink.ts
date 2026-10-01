/**
 * The ONE click rule for a link drawn INSIDE a clickable row.
 *
 * Every such link answers the same three questions the same way, and they are
 * easy to get subtly wrong one copy at a time:
 *
 *  - the row underneath must not also act on the click (it would select, open,
 *    or cycle behind the navigation), so the event stops here — always, modifier
 *    or not;
 *  - a modifier click belongs to the BROWSER (new tab, new window, download), so
 *    the app takes no part in it and the `href` does the work;
 *  - an ordinary click is in-app navigation, which means preventing the default
 *    page load and handing the path to the host.
 *
 * It is a pure function over the fields a `MouseEvent` already has rather than a
 * React import, so it can be tested without a DOM and used from any row.
 */
export interface RowLinkClick {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  stopPropagation: () => void;
  preventDefault: () => void;
}

/**
 * Handle a click on a row link. `navigate` absent means the link is off-site (or
 * the host cannot navigate): the click is still stopped, and the browser follows
 * the `href` itself.
 */
export function followRowLink(
  event: RowLinkClick,
  href: string,
  navigate?: (path: string) => void,
): void {
  event.stopPropagation();
  if (
    !navigate ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  navigate(href);
}
