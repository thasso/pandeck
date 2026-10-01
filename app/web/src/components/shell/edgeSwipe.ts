/**
 * Math for the screen-edge back gesture: which touches start one, when a drag
 * becomes the gesture rather than a scroll, how far the screen follows the
 * finger, and whether a release commits.
 *
 * Separate from `lib/swipeGesture.ts` (the LIST ROW swipe) on purpose: the two
 * gestures are mirror images that must not share thresholds. A row swipe is
 * leftward, lives inside a scroller and keeps OFF the edges precisely because
 * this one owns them; this one is rightward, starts in the edge strip a row
 * swipe refuses, and is judged against the viewport rather than a row's width.
 *
 * Pure, so the thresholds are unit-tested rather than tuned by feel in a
 * component — the shell's rule that gesture math lives in a tested module.
 */

/**
 * Width of the strip at the leading edge in which a touch may become the back
 * gesture, in px. Roughly Apple's own screen-edge recognizer: wide enough for a
 * thumb that lands short of the glass edge, narrow enough that a control at the
 * screen's left margin is still tappable, since a touch here only DEFERS to the
 * gesture — it commits nothing until the finger has travelled.
 */
export const EDGE_SWIPE_ZONE_PX = 28;

/** Horizontal travel that claims the gesture from whatever is under the finger. */
const EDGE_SWIPE_ENGAGE_PX = 12;

/**
 * Rightward travel at which the touch is CLAIMED from the browser's scroller —
 * deliberately shorter than the engage threshold, because the browser decides
 * whether a touch scrolls within its first few px of movement and a scroll that
 * has started can no longer be taken back.
 */
const EDGE_SWIPE_CLAIM_PX = 6;

/**
 * Vertical travel before a scroller may claim the gesture, and how far the
 * vertical must then out-run the horizontal to do it. Same shape and reasoning
 * as the row swipe's yield: a thumb arcs, so both axes are judged only once the
 * vertical is unmistakable in its own right.
 *
 * These only ever decide an UNCLAIMED touch (see `edgeSwipeClaimsTouch`): once
 * the scroller has been cut out there is no second gesture left to yield to.
 */
const EDGE_SWIPE_VERTICAL_YIELD_PX = 24;
const EDGE_SWIPE_VERTICAL_DOMINANCE = 2;

/** Share of the viewport a slow release must have crossed to commit. */
const EDGE_SWIPE_COMMIT_RATIO = 0.32;
/**
 * A flick this fast (px/ms) commits by DIRECTION, wherever the screen is: a
 * finger that leaves the glass at speed has said which way it meant, and asking
 * it for distance as well is what makes a gesture feel unresponsive.
 *
 * 1 px/ms is a whole phone width in under half a second — an unmistakable
 * throw, not the deliberate pull that a screen's width of travel is the honest
 * measure of. Set it lower and DISTANCE stops deciding anything, because an
 * ordinary swipe already moves faster than that.
 */
const EDGE_SWIPE_FLICK_VELOCITY = 1;

/** Travel past which the screen resists, having nowhere further to go. */
const EDGE_SWIPE_RUBBER_BAND_RATIO = 0.9;
const EDGE_SWIPE_RUBBER_BAND_FACTOR = 0.25;

/** May a touch starting at `clientX` become the back gesture? */
export function edgeSwipeStartAllowed(clientX: number): boolean {
  return clientX >= 0 && clientX <= EDGE_SWIPE_ZONE_PX;
}

/**
 * Has this drag leaned rightward far enough to take the touch away from the
 * scroller under it — the moment the hook starts calling `preventDefault`?
 *
 * The claim is what makes the gesture forgiving. Judged on the raw lean rather
 * than a cone, and answered EARLY, because the browser has already made up its
 * mind by the time a finger has travelled `EDGE_SWIPE_ENGAGE_PX`: a pull that
 * arced downward for its first few px would find the page scrolling under it,
 * and a started scroll takes the pointer with it (`pointercancel`) — which is
 * the aim a thumb cannot hit twice in a row.
 *
 * A tie goes to the gesture, as it does for the row swipe. The cost of claiming
 * a touch that turns out to be a scroll is that the touch does nothing at all,
 * since scrolling cannot be handed back; a touch this far into the leading
 * strip that is already leaning rightward has all but said which one it is.
 */
export function edgeSwipeClaimsTouch(dx: number, dy: number): boolean {
  return dx >= EDGE_SWIPE_CLAIM_PX && dx >= Math.abs(dy);
}

/**
 * `pending` — too small to mean anything yet, keep watching;
 * `engaged` — a rightward pull, the screen should follow;
 * `abandoned` — a scroll, or a leftward drag, and this pointer is not ours.
 */
export type EdgeSwipeDecision = "pending" | "engaged" | "abandoned";

/**
 * `claimed` says the scroller has already been cut out of this touch. Vertical
 * movement then decides NOTHING: there is nothing left for it to mean, and a
 * gesture that abandoned there would strand a finger that is still pulling.
 */
export function classifyEdgeSwipeMove(
  dx: number,
  dy: number,
  claimed = false,
): EdgeSwipeDecision {
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (
    !claimed &&
    vertical >= EDGE_SWIPE_VERTICAL_YIELD_PX &&
    vertical >= horizontal * EDGE_SWIPE_VERTICAL_DOMINANCE
  )
    return "abandoned";
  if (horizontal < EDGE_SWIPE_ENGAGE_PX) return "pending";
  // Rightward only. A leftward drag from the leading edge is a pull back into
  // the screen the finger is already on, which is nothing.
  return dx > 0 ? "engaged" : "abandoned";
}

/**
 * How far the screen is drawn, in px of rightward travel (never negative).
 * Near the far edge it keeps moving but visibly resists: the destination is
 * fully revealed by then, and a screen that slides clean off leaves the finger
 * dragging nothing.
 */
export function edgeSwipeTravel(dx: number, viewportWidth: number): number {
  const raw = Math.max(0, dx);
  const limit = viewportWidth * EDGE_SWIPE_RUBBER_BAND_RATIO;
  if (raw <= limit) return raw;
  return limit + (raw - limit) * EDGE_SWIPE_RUBBER_BAND_FACTOR;
}

/**
 * Does releasing here navigate, or spring the screen back?
 *
 * Distance alone is not enough: a fast flick leaves the glass early, and
 * refusing to act on the most decisive gesture there is feels broken.
 * `velocity` is px/ms, positive rightward.
 */
export function edgeSwipeCommits(input: {
  travel: number;
  viewportWidth: number;
  velocity: number;
}): boolean {
  if (Math.abs(input.velocity) >= EDGE_SWIPE_FLICK_VELOCITY)
    return input.velocity > 0;
  return input.travel >= input.viewportWidth * EDGE_SWIPE_COMMIT_RATIO;
}

/**
 * How far the destination underneath is drawn back from its resting place, in
 * px: it starts a third of the viewport to the left and arrives as the screen
 * above it leaves. The parallax is what makes the two layers read as one stack
 * being popped rather than a card sliding over a static background.
 */
export function edgeSwipeParallax(
  travel: number,
  viewportWidth: number,
): number {
  const depth = viewportWidth * 0.3;
  const progress = viewportWidth > 0 ? Math.min(1, travel / viewportWidth) : 1;
  return depth * (1 - progress);
}
