/**
 * Where an open request from OUTSIDE the app should land.
 *
 * Two things ask, and they name the destination differently. A notification
 * carries the server's `navigatePath` — already a canonical route, and the only
 * form that can express a surface with no object behind it (the permanent
 * assistant). A `pa://` deep link names an OBJECT, because it was written into a
 * document months ago and must survive the routes moving underneath it.
 *
 * Both arrive as one string, told apart by their first character: a `pa://` URI
 * never starts with `/`. The shell deliberately does not know this — teaching it
 * the route table would mean rebuilding the shell whenever a route moves, which
 * is the one thing a remote-URL shell exists to avoid.
 *
 * Anything unrecognized resolves to null and is DROPPED. This input crosses a
 * trust boundary: a `pa://` URL can be handed to the app by any other program on
 * the machine, so "navigate wherever the string says" would let it aim the app —
 * including at an off-site URL — from outside. Only the two known shapes pass.
 */
import { paObjectHref, parsePaObjectLink } from "@assistant/shared/objectLinks";

export function pathFromOpenTarget(target: string): string | null {
  const value = target.trim();
  if (!value) return null;

  if (value.toLowerCase().startsWith("pa://")) {
    const link = parsePaObjectLink(value);
    if (!link) return null;
    const href = paObjectHref(link);
    // An unknown object type resolves to a `#unresolved-pa-link:` marker, which
    // is a rendering affordance for prose, not somewhere to navigate to.
    return href.startsWith("/") ? href : null;
  }

  // A same-document path, and only that: a leading `//` is a protocol-relative
  // URL, which the browser would resolve against another host entirely.
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  // `\` is a path separator to browsers when normalizing, so `/\evil.com` is
  // another way to spell an off-site URL.
  if (value.includes("\\")) return null;
  return value;
}
