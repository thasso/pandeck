/**
 * Image previews for prompts THIS browser is sending, kept for the page's
 * lifetime.
 *
 * The optimistic echo of a prompt carries its images by reference only (no
 * bytes), and the durable echo that replaces it is loaded from the session's
 * attachment store by the server's own attachment id. Between the two, the
 * sender already holds the bytes, so the echo shows them — keyed by the
 * optimistic image's OWN identity (`optimisticAttachmentRef`), never by name or
 * size: a later `screenshot.png`, in this session or another, must never stand
 * in for an earlier one. Bounded, page-local, never persisted.
 */

const MAX_PREVIEWS = 40;

const previews = new Map<string, string>();

/** The reference an optimistic prompt's `index`-th image is shown under. */
export function optimisticAttachmentRef(
  clientRequestId: string,
  index: number,
): string {
  return `${clientRequestId}:image-${index}`;
}

/** Remember the bytes of an image the optimistic echo shows under `ref`. */
export function rememberAttachmentPreview(
  ref: string,
  mimeType: string,
  data: string,
): void {
  previews.delete(ref);
  previews.set(ref, `data:${mimeType};base64,${data}`);
  while (previews.size > MAX_PREVIEWS) {
    const oldest = previews.keys().next().value;
    if (oldest === undefined) break;
    previews.delete(oldest);
  }
}

/** The remembered preview for exactly this attachment id, if this browser sent it. */
export function attachmentPreviewSrc(attachmentId: string): string | undefined {
  return previews.get(attachmentId);
}
