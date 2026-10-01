/**
 * Fit math for the composer's bottom row: does the inline runtime strip (mode,
 * agent type, model, thinking) still fit beside the leading buttons and the
 * send cluster, or does it have to fold into the single Runtime sheet trigger?
 *
 * Kept framework-free so the fold point is unit-testable, and kept a pure
 * function of MEASUREMENTS rather than a breakpoint: the strip's width is
 * driven by data (model name, agent label) and by the `--text-scale`
 * preference, so no constant could predict it. The one thing that must hold is
 * that every input is independent of the fold itself — the leading buttons and
 * the send cluster do not change when the strip folds, and the strip's own
 * width is remembered from the last render that showed it — otherwise the
 * decision would oscillate.
 *
 * The two gap constants mirror the row's Tailwind classes in `Composer.tsx`
 * (`gap-2` between the row's two groups, `gap-1` inside the left group).
 */

/** Gap between the row's left group and the trailing send cluster (`gap-2`). */
export const COMPOSER_ROW_GAP = 8;
/** Gap between the leading buttons and the runtime slot (`gap-1`). */
export const COMPOSER_GROUP_GAP = 4;

export interface ComposerRuntimeFit {
  /** What was on screen when `controlsWidth` was measured; see `Composer.tsx`. */
  signature: string;
  /** Inner width of the whole bottom row. */
  rowWidth: number;
  /** Attachment + context buttons, which never fold. */
  leadWidth: number;
  /** Branches, context meter, dictation, refine and send, which never fold. */
  trailWidth: number;
  /** Natural width of the inline runtime strip, measured while it was shown. */
  controlsWidth: number;
}

/**
 * Whether the inline runtime strip fits the measured row.
 *
 * An unmeasured row (`0`, e.g. a composer that has never been laid out) and an
 * unmeasured strip both answer `true`: the strip renders, gets measured, and
 * the next pass decides for real — a fold is never guessed from nothing.
 */
export function runtimeControlsFit(fit: ComposerRuntimeFit): boolean {
  if (fit.rowWidth <= 0 || fit.controlsWidth <= 0) return true;
  return (
    fit.leadWidth +
      COMPOSER_GROUP_GAP +
      fit.controlsWidth +
      COMPOSER_ROW_GAP +
      fit.trailWidth <=
    fit.rowWidth
  );
}

/** Measurement equality, so a re-measure that changed nothing skips the render. */
export function sameComposerRuntimeFit(
  a: ComposerRuntimeFit,
  b: ComposerRuntimeFit,
): boolean {
  return (
    a.signature === b.signature &&
    a.rowWidth === b.rowWidth &&
    a.leadWidth === b.leadWidth &&
    a.trailWidth === b.trailWidth &&
    a.controlsWidth === b.controlsWidth
  );
}
