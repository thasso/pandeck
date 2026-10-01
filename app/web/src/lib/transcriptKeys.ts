import type { PaObjectLinkResolution } from "@assistant/shared/objectLinks";

/**
 * Identity key for the transcript prop that is rebuilt far more often than its
 * content actually changes.
 *
 * `paObjectReferences` feeds `Markdown` — whose memo, once broken, re-runs the
 * whole remark → rehype → sanitize pipeline for every message in the transcript
 * — so gating the prop on its CONTENT is what keeps a long chat cheap while the
 * data behind it churns in the background.
 *
 * Keeping the key here, pure and tested, is deliberate: the failure mode of
 * widening it is invisible (everything still renders — just slowly), so the
 * exact set of fields the consumer depends on is a contract worth pinning.
 */

/**
 * What a rendered `pa://` link is made of. A resolution's remaining fields
 * (`href`, `typeLabel`, `objectType`, `id`, `knownType`) are all derived from
 * `uri` (an approval's href from its card's fixed session), so they cannot vary
 * independently of it. `detail` can: it is live state the link shows after
 * its label, an approval card's status.
 *
 * The key is order-INSENSITIVE, because the consumer is: `Markdown` reads these
 * as a `uri → resolution` lookup. The list they are built from is the session
 * list, which is sorted by `updatedAt` — so every agent turn anywhere in the app
 * reorders it, and an order-sensitive key would call that a content change and
 * re-render every message in the open transcript for it.
 */
export function paObjectReferenceKey(
  refs: readonly PaObjectLinkResolution[],
): string {
  return JSON.stringify(
    refs
      .map((ref) => [ref.uri, ref.title, ref.existence, ref.detail ?? null])
      .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? "")),
  );
}

/**
 * The same contract for `sessionReferences` (id + title, the only fields a
 * rendered session autolink shows), keyed off the same churning list.
 */
export function sessionReferenceKey(
  sessions: readonly { id: string; title?: string }[],
): string {
  return JSON.stringify(
    sessions
      .map((session) => [session.id, session.title ?? null])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}
