import type { SelectedLineRange } from "@pierre/diffs";
import type { DocumentLineAnchor } from "@assistant/shared/documentTargets";
import { shownAnchorRange } from "../../lib/documentRange.ts";

/**
 * The `#L…` anchor as a pierre selection, bounded like every other source: a
 * `#L1-L500000` address selects (and so draws) at most
 * `MAX_DOCUMENT_ANCHOR_LINES` lines from the first addressed one. Both
 * surfaces call this, so the file and diff views cannot answer the same
 * address differently (`docs/document-presentation.md`).
 */
export function anchorSelection(
  anchor: DocumentLineAnchor | undefined,
  side?: "additions",
): SelectedLineRange | null {
  const shown = shownAnchorRange(anchor);
  if (!shown) return null;
  return {
    start: shown.start,
    end: shown.end,
    ...(side ? { side } : {}),
  };
}
