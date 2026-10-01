/**
 * Drag math for the mobile object dock (Task-196).
 *
 * The dock is ONE card that slides between two rest positions: fully open
 * (`offset` 0) and resting as the peek row (`offset` = `travel`, the height of
 * everything below the header). A drag is therefore a single continuous
 * quantity in both directions, and these are the only decisions it needs:
 * how far the card may go past either end, and which end a release belongs to.
 *
 * Pure so the thresholds are testable and stay honest — "how far is far enough"
 * is the whole design. Distance alone is not enough: a fast flick travels little
 * before the finger leaves the glass, and refusing to act on it feels broken.
 */

/** Past this fraction of the travel a slow release falls back instead of opening. */
const COMMIT_FRACTION = 0.5;
/** A flick this fast (px/ms) decides by DIRECTION, wherever the card happens to be. */
const FLICK_VELOCITY = 0.5;
/** Resistance past either end, so the card acknowledges the pull without tearing loose. */
const OVERSHOOT_DAMPING = 0.12;

/**
 * Where a released drag belongs. `offset`/`travel` use the card's own
 * coordinates (0 = open, `travel` = peek) and `velocity` is px/ms, positive
 * downward — one convention for both directions, unlike the two mirrored
 * gestures this replaced.
 */
export function resolveDockDrag(input: {
  offset: number;
  travel: number;
  velocity: number;
}): "expanded" | "peek" {
  if (input.travel <= 0) return "expanded";
  if (Math.abs(input.velocity) >= FLICK_VELOCITY)
    return input.velocity > 0 ? "peek" : "expanded";
  return input.offset <= input.travel * COMMIT_FRACTION ? "expanded" : "peek";
}

/**
 * The offset the card actually renders for a raw finger position: 1:1 between
 * the two rest states — the surface must feel attached — and damped beyond them,
 * since there is no taller state to drag into and a sheet that lifts off its own
 * bottom edge looks broken.
 */
export function clampDockDragOffset(offset: number, travel: number): number {
  if (offset < 0) return offset * OVERSHOOT_DAMPING;
  if (offset > travel) return travel + (offset - travel) * OVERSHOOT_DAMPING;
  return offset;
}
