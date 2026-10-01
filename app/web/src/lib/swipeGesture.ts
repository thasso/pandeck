/**
 * @module swipeGesture
 * @purpose The math behind a horizontal row swipe: whether a touch may start
 *   one, which of the row's two actions it is reaching for, when it becomes a
 *   swipe rather than a scroll, how far the row follows the finger, and whether
 *   a release commits.
 * @intent A row may carry an action on EACH side, so direction is part of every
 *   question here rather than an assumption baked into the signs. Which
 *   directions exist is the caller's to say (`SwipeAllowed`): a row that can
 *   only be swiped one way must not claim a touch — and so kill a scroll — for
 *   a side that would reveal nothing.
 * @intent Pure, so the thresholds are unit-tested rather than tuned by feel in a
 *   component — the shell's rule that gesture math lives in a tested module.
 *   The component around it owns only the DOM.
 */

/** Which way the finger went. A row may offer an action for each. */
export type SwipeDirection = "left" | "right";

/** Which directions this row actually has an action for. */
export interface SwipeAllowed {
  left: boolean;
  right: boolean;
}

/**
 * A touch that starts within this many px of a screen edge belongs to whoever
 * owns BACK there, which is never this row: in a browser it is the platform,
 * since iOS drives back/forward from both edges even in a Home Screen app, and
 * in the native shell it is the app's own edge-swipe, which claims a strip of
 * its own at the leading edge (`components/shell/edgeSwipe.ts`).
 *
 * This guard used to be a courtesy — the row swipe was leftward-only, so it and
 * the edge's rightward pull could not both commit even where their strips
 * overlapped. Now that a row is archived by a RIGHTWARD swipe the two want the
 * same gesture, and the guard is the only thing keeping one finger from
 * arming both the shell's back and a row's archive. It is therefore wider than
 * `EDGE_SWIPE_ZONE_PX`, not narrower, with a few px to spare for a thumb that
 * lands on the boundary; `swipeGesture.test.ts` pins that relationship, because
 * nothing else would notice if the edge strip grew past it.
 */
export const SWIPE_EDGE_GUARD_PX = 36;

/** Horizontal travel at which the row starts following the finger. */
export const SWIPE_ENGAGE_PX = 12;

/**
 * Horizontal travel at which the touch is CLAIMED from the scroller it started
 * in — deliberately shorter than the engage threshold, because the browser
 * decides whether a touch pans within its first few px of movement and a pan
 * that has started can no longer be taken back.
 *
 * Same number and same reasoning as the edge gesture's
 * (`components/shell/edgeSwipe.ts`), kept as its own constant because the two
 * are not the same bet. That one only ever judges touches that landed in a
 * reserved 28px strip, where nothing else lives; this one is asked about EVERY
 * touch that lands on a row, i.e. about every list scroll. What keeps the
 * exposure honest is the lean rule below rather than the distance.
 */
export const SWIPE_CLAIM_PX = 6;

/**
 * Vertical travel before the scroller may take an UNCLAIMED gesture, and how
 * far the vertical must then out-run the horizontal to do it.
 *
 * A thumb does not swipe along a ruler: a one-handed left pull arcs, and the
 * first few px of it are mostly noise, so judging the two axes against each
 * other while both are small rejects swipes that were never scrolls. Vertical
 * has to be BOTH unmistakable in its own right and clearly the larger motion
 * before it wins.
 */
export const SWIPE_VERTICAL_YIELD_PX = 24;
const SWIPE_VERTICAL_DOMINANCE = 2;

/** Travel that arms the row, and the share of a narrow row that does. */
export const SWIPE_COMMIT_PX = 96;
const SWIPE_COMMIT_RATIO = 0.35;
/** An arming threshold never drops below this, however narrow the row. */
const SWIPE_COMMIT_MIN_PX = 48;

/**
 * A flick this fast (px/ms) commits by DIRECTION, wherever the row is: a finger
 * that leaves the glass at speed has said which way it meant, and asking it for
 * distance as well is what makes a gesture feel unresponsive.
 *
 * Same number as the edge gesture's, and for the same reason rather than for
 * symmetry: 1 px/ms is a whole phone width in under half a second — an
 * unmistakable throw, not the deliberate pull that a distance is the honest
 * measure of. That the row's own travel is far shorter does not change where
 * the line sits, because the line is drawn on the SPEED at the release, which
 * is what separates the two gestures a hand actually makes. Set it lower and
 * distance stops deciding anything, because an ordinary pull already ends
 * faster than that.
 */
const SWIPE_FLICK_VELOCITY = 1;

/** Travel at which the row stops following the finger 1:1. */
export const SWIPE_RUBBER_BAND_PX = 128;
const SWIPE_RUBBER_BAND_FACTOR = 0.3;

/** May a touch starting at `clientX` become a row swipe? */
export function swipeStartAllowed(
  clientX: number,
  viewportWidth: number,
): boolean {
  return (
    clientX >= SWIPE_EDGE_GUARD_PX &&
    clientX <= viewportWidth - SWIPE_EDGE_GUARD_PX
  );
}

/** Is `dx` leaning the way an action lies? */
function leansToAnAction(dx: number, allowed: SwipeAllowed): boolean {
  return dx < 0 ? allowed.left : allowed.right;
}

/**
 * Has this drag leaned far enough, toward an action this row HAS, to take the
 * touch away from the scroller it started in — the moment `SwipeRow` starts
 * calling `preventDefault`?
 *
 * The claim is what makes the gesture land. Judged on the raw lean rather than
 * a cone, and answered EARLY, because the browser has already made up its mind
 * by the time a finger has travelled `SWIPE_ENGAGE_PX`: a pull that arced
 * downward for its first few px would find the list scrolling under it, and a
 * started pan takes the pointer with it (`pointercancel`) — a swipe that dies
 * for reasons the hand cannot see or correct, which is what made this gesture
 * unreliable while `touch-action: pan-y` was the only arbitration.
 *
 * A tie goes to the gesture, as it does everywhere else here. The cost of
 * claiming a touch that turns out to be a scroll is that the touch does nothing
 * at all, since scrolling cannot be handed back — and that cost is paid on a
 * row, not in a reserved strip. What bounds it is the LEAN: 6px of travel with
 * the horizontal at least matching the vertical is not how a list scroll
 * begins, however much a thumb arcs on its way down.
 *
 * `allowed` is what keeps that cost from being paid for nothing. A row with
 * only one of the two actions must not kill a scroll by leaning toward the side
 * where it has nothing to reveal, so the direction is asked here, at the claim,
 * and not only later at the engage.
 */
export function swipeClaimsTouch(
  dx: number,
  dy: number,
  allowed: SwipeAllowed,
): boolean {
  if (!leansToAnAction(dx, allowed)) return false;
  return Math.abs(dx) >= SWIPE_CLAIM_PX && Math.abs(dx) >= Math.abs(dy);
}

/**
 * `pending` — too small to mean anything yet, keep watching;
 * a DIRECTION — the row should follow the finger and reveal that side's action;
 * `abandoned` — a scroll, or a pull toward a side with no action on it.
 */
export type SwipeDecision = "pending" | "abandoned" | SwipeDirection;

/**
 * The scroller is asked first, and only a MOSTLY vertical drag takes the
 * gesture — not any drag with vertical in it.
 *
 * A tight cone rejects the swipe people actually make, since a thumb arcs. A
 * generous one costs a panel visible for the length of the decision on a drag
 * that then goes back to the scroller. Ties therefore go to the swipe: a 45°
 * pull is a swipe with drift in it, and the finger that made it meant the one
 * action the row has.
 *
 * `claimed` says the scroller has already been cut out of this touch (see
 * `swipeClaimsTouch`). Vertical movement then decides NOTHING: there is nothing
 * left for it to mean — the page cannot start panning any more — and a gesture
 * that abandoned there would strand a finger that is still pulling. Asking a
 * thumb to hold a direction for the length of a row is what made this gesture
 * feel unhittable; the yield cone is for the touch that has not been taken yet,
 * not for the one already following.
 */
export function classifySwipeMove(
  dx: number,
  dy: number,
  allowed: SwipeAllowed,
  claimed = false,
): SwipeDecision {
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (
    !claimed &&
    vertical >= SWIPE_VERTICAL_YIELD_PX &&
    vertical >= horizontal * SWIPE_VERTICAL_DOMINANCE
  )
    return "abandoned";
  // Judged on the horizontal alone: vertical drift no longer decides anything
  // until it is large enough to have failed the test above, so a swipe that
  // starts with a downward wobble is still waiting rather than already dead.
  if (horizontal < SWIPE_ENGAGE_PX) return "pending";
  // A side with no action behind it is not a swipe, it is a drag over a row.
  // Abandoning rather than waiting matters at the START of a gesture: an
  // unclaimed pull that way has to be handed back while the scroller can still
  // take it.
  if (!leansToAnAction(dx, allowed)) return "abandoned";
  return dx < 0 ? "left" : "right";
}

/**
 * How far the row is drawn, SIGNED as the finger moved: negative leftward,
 * positive rightward. Past the rubber-band point the row keeps moving but
 * visibly resists, which is how a finger learns there is nothing further to
 * pull.
 *
 * Travel is clamped to the direction the gesture ENGAGED in: dragging back
 * through the start point does not open the other side's action. A gesture
 * means one thing, and a finger that wandered past zero is taking this one back
 * (which is what the spring-back and the retracting flick are for), not asking
 * for the opposite one — which on these rows is the difference between
 * archiving a Task and deleting it.
 */
export function swipeTravel(dx: number, direction: SwipeDirection): number {
  const raw = direction === "left" ? Math.max(0, -dx) : Math.max(0, dx);
  const eased =
    raw <= SWIPE_RUBBER_BAND_PX
      ? raw
      : SWIPE_RUBBER_BAND_PX +
        (raw - SWIPE_RUBBER_BAND_PX) * SWIPE_RUBBER_BAND_FACTOR;
  // Explicitly, so a row at rest reads as 0 rather than -0: the two are equal
  // to `===` but not to `Object.is`, which is what "is this row home" is asked
  // with in more places than it looks.
  if (eased === 0) return 0;
  return direction === "left" ? -eased : eased;
}

/** The travel that arms the row, for a row this wide. */
export function swipeCommitThreshold(rowWidth: number): number {
  return Math.min(
    SWIPE_COMMIT_PX,
    Math.max(SWIPE_COMMIT_MIN_PX, rowWidth * SWIPE_COMMIT_RATIO),
  );
}

/**
 * Is the row pulled far enough that letting go NOW runs the action? This is the
 * VISIBLE promise — the panel's armed treatment is exactly this answer — so it
 * asks about distance alone, which is the only part of it a reader can see.
 */
export function swipeArms(travel: number, rowWidth: number): boolean {
  return Math.abs(travel) >= swipeCommitThreshold(rowWidth);
}

/**
 * Does releasing here run the action, or spring the row back?
 *
 * Distance alone is not enough: a flick leaves the glass early, and refusing
 * the most decisive gesture there is feels broken. The armed threshold is
 * therefore a promise rather than the whole rule — everything it says commits
 * does commit, and a flick commits BELOW it as well. So the action can run
 * without the panel ever having armed, which errs in the direction that
 * matters: the armed state never claims a release that was going to be refused.
 *
 * The same speed decides the other way. A finger already past the threshold
 * that throws the row BACK — against the direction it engaged in — has
 * retracted the swipe, whatever the panel promised a moment ago, and reading
 * that as a commit would run the action on the gesture a hand makes to say no.
 * `velocity` is px/ms, negative leftward, and it is judged against the
 * gesture's own direction rather than against leftward: on a row where one way
 * archives and the other deletes, "away from where this started" is the only
 * reading of a throw-back that cannot run the wrong action.
 */
export function swipeCommits(input: {
  travel: number;
  rowWidth: number;
  velocity: number;
  direction: SwipeDirection;
}): boolean {
  if (Math.abs(input.velocity) >= SWIPE_FLICK_VELOCITY)
    return input.direction === "left" ? input.velocity < 0 : input.velocity > 0;
  return swipeArms(input.travel, input.rowWidth);
}
