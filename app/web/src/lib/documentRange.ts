import {
  boundedDocumentLineRange,
  type DocumentLineAnchor,
} from "@assistant/shared/documentTargets";

/**
 * One place for what a `#L…` range COSTS on screen, so the sources cannot
 * drift: every line-oriented renderer draws and marks
 * `MAX_DOCUMENT_ANCHOR_LINES` lines at most, and says the same sentence when it
 * shows less than the address asked for. The address itself is never rewritten
 * (`docs/document-presentation.md`).
 */

/** The lines a renderer may draw for an anchor, or `null` without one. */
export function shownAnchorRange(
  anchor: DocumentLineAnchor | undefined,
): { start: number; end: number; truncated: boolean } | null {
  return anchor ? boundedDocumentLineRange(anchor) : null;
}

/**
 * What to tell a reader who asked for more lines than are on screen, or `null`
 * when the whole requested range is shown. `shown` is in the reader's own
 * numbering: file lines, not offsets into a window.
 */
export function partialRangeNotice(
  requested: { start: number; end?: number | undefined } | undefined,
  shown: { start: number; end: number } | undefined,
): string | null {
  if (!requested || !shown) return null;
  const requestedEnd = Math.max(
    requested.end ?? requested.start,
    requested.start,
  );
  if (requested.start >= shown.start && requestedEnd <= shown.end) return null;
  return `only lines ${shown.start}–${shown.end} of the requested L${requested.start}–L${requestedEnd} are shown`;
}
