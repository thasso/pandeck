/**
 * Image previews for attachments THIS browser sent, kept for the page's
 * lifetime.
 *
 * The durable transcript stores a prompt image by reference only — no bytes and
 * no URL (`displayMapping.userBlocks`) — so without this a just-sent image would
 * collapse to a bare chip the moment the server's echo replaces the optimistic
 * one. The sender already holds the bytes; remembering them keeps the picture on
 * screen for this session of the page. Another device, or a reload, still sees
 * the chip. Bounded, page-local, never persisted.
 */

interface PreviewSource {
  name: string;
  mimeType: string;
  size: number;
}

const MAX_PREVIEWS = 40;

/** Exact match first; the echo's size may be recomputed, so name+type next. */
const byExact = new Map<string, string>();
const byName = new Map<string, string>();

const exactKey = (a: PreviewSource) => `${a.mimeType}|${a.name}|${a.size}`;
const nameKey = (a: PreviewSource) => `${a.mimeType}|${a.name}`;

function remember(map: Map<string, string>, key: string, src: string) {
  map.delete(key);
  map.set(key, src);
  while (map.size > MAX_PREVIEWS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Remember the image attachments of a prompt this browser is sending. */
export function rememberAttachmentPreviews(
  attachments: readonly (PreviewSource & { data: string; role?: string })[],
): void {
  for (const a of attachments) {
    if (a.role || !a.mimeType.startsWith("image/") || !a.data) continue;
    const src = `data:${a.mimeType};base64,${a.data}`;
    remember(byExact, exactKey(a), src);
    remember(byName, nameKey(a), src);
  }
}

/** The remembered preview for an attachment, when this browser sent it. */
export function attachmentPreviewSrc(a: PreviewSource): string | undefined {
  return byExact.get(exactKey(a)) ?? byName.get(nameKey(a));
}
