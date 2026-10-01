/** Sessions navigation surface (sidebar/sheet open + focused). */
export const SESSIONS_PATH = "/sessions";
/** Empty-bootstrap assistant landing ("new chat"). */
export const SESSIONS_CREATE_PATH = "/sessions/create";

export function sessionPath(id: string): string {
  return `${SESSIONS_PATH}/${encodeURIComponent(id)}`;
}

/**
 * One message inside a session, as a URL fragment: `/sessions/<id>#m-<entryId>`.
 * The route shape stays canonical (the fragment addresses a part of the object,
 * not another object), and the id is OUR durable log entry id — the same id the
 * transcript rows carry — so the address survives a reload and a share.
 *
 * The fragment is an address, never the mechanism: the transcript is windowed
 * and owns its own scroll position, so nothing here relies on the browser's
 * native fragment scrolling.
 */
export function messageHash(sessionId: string, entryId: string): string {
  return `${sessionId}#${entryId}`;
}

/** The entry id a `#m-<entryId>` fragment addresses, or null for any other hash. */
export function entryIdFromHash(hash: string): string | null {
  const match = hash.match(/^#m-(.+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** Extract the canonical session id from `/sessions/<id>`. */
export function sessionIdFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/sessions\/([^/]+)\/?$/);
  if (!match?.[1] || match[1] === "create") return null;
  return decodeURIComponent(match[1]);
}
