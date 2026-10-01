/**
 * Which links in content are candidates for the desktop port forward.
 *
 * An agent working on the server writes `http://localhost:5173` into a message
 * meaning "the dev server I just started", and on the laptop that address is
 * nothing. The shell can make it real by forwarding the same port, so a click
 * on such a link is worth intercepting — but only on exactly that shape: an
 * explicit `http:`/`https:` URL, a loopback host, an explicit port the shell
 * may bind. Anything else stays an ordinary link. These are pure transforms;
 * `nativeShell.ts` decides whether the runtime can act on them.
 */
import { isPortForwardPort } from "@assistant/shared/portForwarding";

/** The loopback names an author writes. IPv6 keeps the URL API's brackets. */
const LOOPBACK_HOSTNAMES: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "[::1]",
];

export interface LoopbackLink {
  /** The explicit port the author wrote, inside the forwardable range. */
  port: number;
  /** The same URL with its host rewritten to `localhost`; everything else kept. */
  localUrl: string;
}

/** Whether a URL hostname, as the URL API reports it, is the local machine. */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.includes(hostname.toLowerCase());
}

/**
 * The forwardable reading of a link, or null when it is not one. Relative
 * links, other schemes, credentials in the URL, a missing or default port, and
 * a port outside the range are all null: the link then behaves as it always
 * has.
 */
export function parseLoopbackLink(href: string): LoopbackLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!isLoopbackHostname(url.hostname)) return null;
  // `port` is empty for the scheme default, which is below the range anyway.
  if (!/^\d+$/.test(url.port)) return null;
  const port = Number(url.port);
  if (!isPortForwardPort(port)) return null;
  url.hostname = "localhost";
  return { port, localUrl: url.href };
}

/**
 * An ordinary click: the primary button with no modifier, which is the only
 * one whose meaning the app may take over. A modified click asks the browser
 * for a tab or a download, and that request is honoured as written.
 */
export function isPlainPrimaryClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}
