import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  classifySwipeMove,
  swipeArms,
  swipeClaimsTouch,
  swipeCommits,
  swipeStartAllowed,
  swipeTravel,
  type SwipeAllowed,
  type SwipeDirection,
} from "../../lib/swipeGesture.ts";
import { usePrefersReducedMotion } from "../shell/usePrefersReducedMotion.ts";

/** How long the row takes to slide home from a released swipe. */
const SPRING_BACK_MS = 150;
/** How long a committed row takes to leave, carrying on in the swipe direction. */
const EXIT_SLIDE_MS = 160;
/** How long the gap it leaves takes to close, drawing the list up behind it. */
const EXIT_CLOSE_MS = 180;
/**
 * A row whose action removed it is unmounted by its list a frame or two after
 * `onExited`. One still mounted this long afterwards is a row the action did NOT
 * remove — a write the server rejected, a list that came back unchanged — and an
 * invisible row is worse than one that reappears, so it comes back.
 *
 * Not tuned to the animation, which is long over: this is a ceiling on how long
 * the ANSWER may take, so it is generous on purpose. The row it is waiting on is
 * zero-height and inert, i.e. the wait costs nothing to look at, while ending it
 * early on a slow link would flash a row back into a list that is about to drop
 * it — an archive that worked, drawn as one that failed. A host holding the row
 * for its exit must release it before the row gives up (`BacklogTreePane`'s
 * `LEAVING_MAX_MS`), so a hold never resurrects a row already drawn back. That
 * ordering is not in the two numbers, which are equal: it comes from this timer
 * starting only at `gone`, i.e. a whole exit later. Reduced motion has no such
 * head start and both land in one timer flush — harmless, since the hold is
 * scheduled first and both run before paint, but do not narrow the gap on the
 * assumption that the constants carry it.
 */
const EXIT_ABANDON_MS = 1000;

/**
 * A finger that has not moved for this long is standing still, whatever its
 * last sample said: without this, pulling the row open, holding it there and
 * lifting would be judged by the speed it arrived at, which is a flick the hand
 * did not make. Same reasoning and same number as the edge gesture's.
 */
const SWIPE_VELOCITY_STALE_MS = 80;

/**
 * A committed row leaving the list: it carries on in the swipe direction
 * (`sliding`), then its height closes so the rows below rise into the gap
 * (`closing`), and `gone` is the zero-height wait for the list to drop it.
 */
type ExitPhase = "sliding" | "closing" | "gone";

/** One side's action: what it is called, and what running it does. */
export interface SwipeAction {
  /**
   * What the revealed action does, shown behind the row. It is the SAME word
   * for the whole gesture: the panel names the action, and arming is a change
   * of treatment, not of wording — a label that rewrites itself mid-swipe makes
   * the reader re-read the panel to find out that nothing about the action
   * changed.
   */
  label: string;
  icon?: ReactNode;
  /**
   * A DESTRUCTIVE action is painted in the danger colour rather than the accent
   * from the first px of travel, because on a row with two of these the panel's
   * colour is what tells a thumb which one it is opening — and it has to say so
   * while there is still time to pull back, not at the threshold.
   */
  tone?: "default" | "danger";
  /**
   * Run the action. Return `true` when it TOOK the row out of the list: the row
   * then leaves in the swipe direction and the gap closes behind it, instead of
   * springing home to be deleted out from under the finger. Anything else keeps
   * the spring-back, so a caller that cannot answer yet — one that has still to
   * ASK, say — says nothing and gets a row that goes home rather than one that
   * vanishes on a write that never happened.
   */
  run: () => boolean | void;
}

/**
 * @component SwipeRow
 * @purpose Reveal an action on EACH side of a list row — one for a leftward
 * pull, one for a rightward — committing on a release that has either passed
 * the threshold or flicked that way at speed.
 * @useWhen A list row has one or two obvious actions that a phone should be
 * able to run without opening the object first.
 * @avoidWhen The action is neither reversible nor confirmed, or is not obvious
 * from the row: a swipe cannot ask a question by itself, so an irreversible one
 * commits to a CONFIRMATION (`run` returning false, the dialog doing the rest)
 * and a reversible one pairs with an Undo receipt. What must not happen is an
 * unrecoverable act on a gesture a thumb can make by accident.
 * @intent Two sides, so the panel's COLOUR carries which action is opening —
 * see `SwipeAction.tone`. Direction is settled once, at the engage, and the
 * travel is clamped to it: dragging back through the start point springs the
 * row home rather than opening the other action, because one gesture means one
 * thing and the two sides here are not neighbours in consequence.
 * @intent An action that REMOVES the row (`run` returning true) is finished
 * by the row itself: it carries on in the swipe direction and its height closes,
 * drawing the rows below into the gap, so the removal is the end of the gesture
 * rather than a row that springs home and is then deleted out from under the
 * finger. The list is told when that is done (`onExited`) and must keep the row
 * mounted until then — an archive is answered by a fresh list within a frame or
 * two, long before a hand can see it.
 * @intent The pull is aimed ONCE. A touch that leans toward a side this row HAS
 * an action on is CLAIMED from the scroller under it with a non-passive
 * `touchmove` `preventDefault`, before the row engages and while the browser can
 * still be told not to pan; from then on the gesture is judged on the horizontal
 * alone, however far the thumb arcs. Without that, `touch-action: pan-y` was the
 * whole arbitration and a pan could start under a swipe already in flight,
 * taking the pointer with it — a gesture that failed for a reason the hand could
 * neither see nor correct. Same mechanism as the shell's edge-swipe back
 * (`components/shell/edgeSwipe.ts`), whose strip a row swipe still refuses to
 * start in: that gesture is rightward too, and only the edge guard keeps one
 * finger from arming both.
 * @intent TOUCH ONLY. A mouse keeps the row's ordinary click/drag behaviour —
 * pointer swiping with a mouse is not a gesture anyone performs, and claiming
 * mouse drags here would fight the tree's drag-to-reorder. Vertical scrolling
 * stays native for every touch the row does NOT claim, and the gesture math
 * (edge guard, claim, engage/commit thresholds) lives in `lib/swipeGesture.ts`.
 * @related lib/swipeGesture.ts, components/common/Tree.tsx
 */
export function SwipeRow({
  left,
  right,
  onExited,
  disabled = false,
  children,
}: {
  /** The action a LEFTWARD pull reveals, on the row's right-hand edge. */
  left?: SwipeAction | undefined;
  /** The action a RIGHTWARD pull reveals, on the row's left-hand edge. */
  right?: SwipeAction | undefined;
  /**
   * The row has finished leaving and stands at zero height. A host that held
   * the row back for the animation (see `Tree`'s `rowSwipe`) drops it HERE, so
   * the unmount is invisible rather than a jump.
   */
  onExited?: (() => void) | undefined;
  /**
   * Hand this pointer to something else — the host's drag, today. A gesture in
   * flight is ABANDONED when this turns true, because by then two mechanisms
   * are reading the same finger and only one of them can be what was meant.
   */
  disabled?: boolean | undefined;
  children: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ id: number; x: number; y: number } | null>(null);
  // The direction this gesture engaged in, and the whole of "is it engaged":
  // there is no engaged swipe without a side, and reading the side from the
  // travel's sign would let a finger that dragged back through zero repaint the
  // panel as the other action mid-gesture.
  const directionRef = useRef<SwipeDirection | null>(null);
  // Whether the scroller has been cut out of this touch (`preventDefault` on
  // its moves). Set before the gesture engages, and the reason the rest of the
  // pull may wander vertically as much as a thumb naturally does.
  const claimedRef = useRef(false);
  // Last sample and the speed derived from it, for the release velocity: a
  // flick delivers little travel before the finger leaves the glass, so
  // distance alone would refuse it.
  const sampleRef = useRef<{ x: number; t: number } | null>(null);
  const velocityRef = useRef(0);
  // Travel lives in a ref and is MIRRORED into state for the transform: a flick
  // can deliver its last move and the release in one batch, and a release that
  // read the rendered value would then judge the swipe by where it was a frame
  // ago and spring back under the finger. Signed, as the finger moved.
  const travelRef = useRef(0);
  // A completed swipe is followed by a click on whatever was under the finger,
  // by which time the row has already sprung back — so the fact that a swipe
  // happened has to outlive it by one event.
  const swipedRef = useRef(false);
  // The row's width, measured when a gesture ENGAGES: the commit threshold
  // scales with it, and arming is judged during the gesture now, so the width
  // has to exist before the release rather than being taken at it.
  const widthRef = useRef(0);
  const [travel, setTravel] = useState(0);
  const [direction, setDirection] = useState<SwipeDirection | null>(null);
  const [dragging, setDragging] = useState(false);
  // Past the arming threshold: letting go NOW runs the action. Not the only way
  // to run it — a flick commits below this and arms it at the release instead —
  // because the panel may promise only what travel makes visible. Kept apart
  // from travel because it outlives the release (see `reset`). It is only ever
  // READ on a panel that exists, and the move that gives the panel its width
  // sets it in the same batch — so a value left over from a previous gesture
  // cannot be painted.
  const [armed, setArmed] = useState(false);
  // The row is back under the finger's release but still animating there.
  const [settling, setSettling] = useState(false);
  // Set once the action has answered that the row is leaving; `null` on every
  // row that is staying, which is every row most of the time.
  const [exit, setExit] = useState<ExitPhase | null>(null);
  // The height the gap has to close FROM, measured while the row still has one.
  const exitHeightRef = useRef(0);
  const onExitedRef = useRef(onExited);
  const reducedMotion = usePrefersReducedMotion();

  // Which sides have an action, for the gesture math. Held in a ref because the
  // `touchmove` veto below is a native listener registered once per node: a
  // dependency on this would tear the listener down and rebuild it every time a
  // list re-renders with a new action object.
  const allowedRef = useRef<SwipeAllowed>({ left: !!left, right: !!right });
  allowedRef.current = { left: !!left, right: !!right };

  useEffect(() => {
    onExitedRef.current = onExited;
  }, [onExited]);

  // One phase per timer, so each leg animates from the value the previous leg
  // painted: height is explicit before it closes, because `auto` does not
  // transition, and the slide is over before the gap starts to close (the row
  // has to be GONE from the space it is giving up, or the two motions read as
  // one shrinking row).
  useEffect(() => {
    if (!exit) return;
    if (exit === "gone") {
      onExitedRef.current?.();
      const abandon = window.setTimeout(() => setExit(null), EXIT_ABANDON_MS);
      return () => window.clearTimeout(abandon);
    }
    const timer = window.setTimeout(
      () => setExit(exit === "sliding" ? "closing" : "gone"),
      exit === "sliding" ? EXIT_SLIDE_MS : EXIT_CLOSE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [exit]);

  useEffect(() => {
    if (!settling) return;
    const timer = window.setTimeout(() => {
      setSettling(false);
      // A finger that came back down inside the spring-back owns `armed` now:
      // disarming here would drop the state of a gesture already past the
      // threshold, and a finger holding still sends no move to restore it.
      if (!startRef.current) setArmed(false);
    }, SPRING_BACK_MS);
    return () => window.clearTimeout(timer);
  }, [settling]);

  const setTravelTo = useCallback((next: number) => {
    travelRef.current = next;
    setTravel(next);
  }, []);

  /**
   * `committed` keeps the armed treatment on through the spring-back: dropping
   * it the instant the finger lifts would repaint the panel neutral just as the
   * action runs, which reads as a refusal. A gesture that ends any other way —
   * short, cancelled, taken over — goes neutral immediately, because an accent
   * flash on the way home would claim an archive that did not happen.
   *
   * `leaving` is the third ending: the row is not going home at all, so there is
   * no spring-back to run. Travel still returns to zero — the exit transform
   * replaces it, and a transition starts from what was PAINTED, which is where
   * the finger left the row.
   *
   * The DIRECTION outlives all three, because every one of them still has the
   * panel on screen: the spring-back animates it closed, and the exit fills it.
   * It is cleared when the row is finally at rest (see the `settling` effect's
   * neighbour below), not here.
   */
  const reset = useCallback(
    (committed = false, leaving = false) => {
      startRef.current = null;
      directionRef.current = null;
      claimedRef.current = false;
      sampleRef.current = null;
      velocityRef.current = 0;
      if (travelRef.current !== 0 && !reducedMotion && !leaving)
        setSettling(true);
      if (!committed) setArmed(false);
      setDragging(false);
      setTravelTo(0);
    },
    [reducedMotion, setTravelTo],
  );

  // The panel is unmounted once the row is home, and only then does the side it
  // was on stop meaning anything.
  useEffect(() => {
    if (settling || exit || travel !== 0 || dragging) return;
    setDirection(null);
  }, [settling, exit, travel, dragging]);

  // A long press that becomes a drag-to-reorder activates the host's sensor at
  // its own delay, and the same finger is still ours: without this, resting and
  // THEN pulling would reorder the row and act on it from one gesture.
  useEffect(() => {
    if (!disabled) return;
    swipedRef.current = false;
    reset();
    // `reset` is a `useCallback` on `reducedMotion` alone, so this still fires
    // on the transition into `disabled` and not on any ordinary re-render.
  }, [disabled, reset]);

  // The node is held in state as well as in a ref because the veto below is a
  // NATIVE listener: React registers `touchmove` passively at the root, so a
  // `preventDefault` from an `onTouchMove` prop is ignored with a console
  // warning and the page scrolls anyway.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const setHostNode = useCallback((node: HTMLDivElement | null) => {
    hostRef.current = node;
    setHost(node);
  }, []);

  /**
   * The veto that keeps the list still under a claimed touch. Pointer events
   * cannot say this — only the touch stream is cancelable — and it has to be
   * said on the FIRST move that leans our way: preventing a cancelable
   * `touchmove` stops the sequence from ever scrolling, while a pan already
   * under way ignores it and takes the pointer with it.
   *
   * It answers the claim from its OWN coordinates rather than trusting the
   * pointer move to have run first. The spec orders it that way, but a frame of
   * the wrong answer here is a scroll that has already started, and this
   * gesture has exactly one chance to say no. Once ENGAGED it prevents
   * unconditionally: a gesture the row is already following has no business
   * scrolling the list, whether or not the lean ever qualified.
   *
   * Capture, so an inner scroller cannot hide the gesture behind a
   * `stopPropagation`. `startRef` is the only guard it needs: a row that is
   * disabled, exiting, or was never touched has none.
   */
  useEffect(() => {
    if (!host) return;
    const onTouchMove = (event: TouchEvent) => {
      const start = startRef.current;
      if (!start) return;
      if (!claimedRef.current && !directionRef.current) {
        const touch = event.touches.item(0);
        if (!touch) return;
        if (
          !swipeClaimsTouch(
            touch.clientX - start.x,
            touch.clientY - start.y,
            allowedRef.current,
          )
        )
          return;
        claimedRef.current = true;
      }
      if (event.cancelable) event.preventDefault();
    };
    host.addEventListener("touchmove", onTouchMove, {
      passive: false,
      capture: true,
    });
    return () =>
      host.removeEventListener("touchmove", onTouchMove, { capture: true });
  }, [host]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    swipedRef.current = false;
    // A row on its way out is not a row anyone can swipe again, and a row with
    // no actions is not a swipe surface at all.
    if (disabled || exit) return;
    if (!left && !right) return;
    if (event.pointerType !== "touch") return;
    if (!swipeStartAllowed(event.clientX, window.innerWidth)) return;
    startRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    directionRef.current = null;
    claimedRef.current = false;
    sampleRef.current = { x: event.clientX, t: event.timeStamp };
    velocityRef.current = 0;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (disabled || !start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const allowed = allowedRef.current;
    // Claimed before engaged, and never given back: the browser starts a pan
    // within the first few px of movement, so the touch has to be taken while
    // its moves are still cancelable.
    if (!claimedRef.current && swipeClaimsTouch(dx, dy, allowed))
      claimedRef.current = true;
    if (!directionRef.current) {
      const decision = classifySwipeMove(dx, dy, allowed, claimedRef.current);
      if (decision === "pending") return;
      if (decision === "abandoned") {
        reset();
        return;
      }
      directionRef.current = decision;
      swipedRef.current = true;
      setDirection(decision);
      setDragging(true);
      // Measured here rather than at touchdown: every tap and every list scroll
      // starts with one of those, and a forced layout before the gesture is even
      // known to be horizontal is a reflow on the scroll path. A row that
      // measures zero is not a row anyone swiped; fall back to the viewport
      // rather than letting the threshold collapse to its floor.
      widthRef.current = hostRef.current?.offsetWidth || window.innerWidth;
      // Own the pointer from here: the row keeps receiving moves even when the
      // finger leaves it, so a diagonal swipe cannot strand a half-open row.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const previous = sampleRef.current;
    if (previous) {
      const elapsed = event.timeStamp - previous.t;
      if (elapsed > 0)
        velocityRef.current = (event.clientX - previous.x) / elapsed;
    }
    sampleRef.current = { x: event.clientX, t: event.timeStamp };
    const next = swipeTravel(dx, directionRef.current);
    setTravelTo(next);
    // Judged on every move, in both directions: pulling back under the
    // threshold has to take the promise away again, or the panel would keep
    // promising an archive the release will decline. Distance only — the panel
    // shows what a reader can see, and a flick's speed is not that.
    setArmed(swipeArms(next, widthRef.current));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (disabled || !start || event.pointerId !== start.id) return;
    const engaged = directionRef.current;
    const idleFor = event.timeStamp - (sampleRef.current?.t ?? event.timeStamp);
    const commit =
      engaged !== null &&
      swipeCommits({
        travel: travelRef.current,
        rowWidth: widthRef.current,
        velocity: idleFor > SWIPE_VELOCITY_STALE_MS ? 0 : velocityRef.current,
        direction: engaged,
      });
    if (!commit || !engaged) {
      reset();
      return;
    }
    // A flick commits below the arming threshold, so the panel may never have
    // armed. Arm it now: the confirmation that survives the spring-back is the
    // only thing that says the action is running, and a neutral panel springing
    // home reads as a refusal.
    setArmed(true);
    // Measured before the action runs, while the row still occupies its height:
    // by the next paint the list may already have answered.
    const height = hostRef.current?.offsetHeight ?? 0;
    const leaving = (engaged === "left" ? left : right)?.run() === true;
    reset(true, leaving);
    if (!leaving) return;
    exitHeightRef.current = height;
    // Reduced motion still removes the row — it just does not travel to say so.
    setExit(reducedMotion ? "gone" : "sliding");
  };

  // The panel is a full-width layer parked just past the edge it enters from,
  // and it moves on the row's OWN transform: its inner edge is glued to the
  // row's outer edge, so it slides in from the side with the finger rather
  // than appearing under it. It never overlaps the row either, which matters
  // because a row body is transparent and a layer behind it would show THROUGH.
  // Sharing the transform is also what fills the row's whole width on the exit,
  // and what makes a declined swipe carry it back out on the same curve.
  const springing = !dragging && !reducedMotion && !exit;
  const closing = exit === "closing" || exit === "gone";
  const action =
    direction === "left" ? left : direction === "right" ? right : undefined;
  const danger = action?.tone === "danger";
  const slide: CSSProperties = {
    // The exit carries on where the finger stopped — the transition starts from
    // the painted transform, not from a fresh zero.
    transform: exit
      ? `translateX(${direction === "left" ? "-100%" : "100%"})`
      : travel
        ? `translateX(${travel}px)`
        : undefined,
    transition:
      exit === "sliding"
        ? `transform ${EXIT_SLIDE_MS}ms ease-in`
        : springing
          ? `transform ${SPRING_BACK_MS}ms ease-out`
          : undefined,
  };
  return (
    <div
      ref={setHostNode}
      // `pan-y` hands vertical scrolling back to the browser while horizontal
      // movement arrives here as pointer events instead of scrolling the page.
      // It is the resting state, not the arbitration: it lets the UA pan a
      // touch this row has not claimed, and a claimed one is held still by the
      // `touchmove` veto above.
      className="relative touch-pan-y overflow-hidden"
      // A row that has left is still MOUNTED until the list drops it, so it has
      // to stop being a row: `inert` takes the whole subtree out of the focus
      // order and the accessibility tree in one, which `aria-hidden` cannot do
      // — the row's buttons are focusable, and focusable content inside
      // `aria-hidden` is the a11y failure, not the fix. `pointerEvents` stays
      // alongside it because `inert` only promises about clicks, and a drag
      // sensor reads pointerdown.
      inert={exit ? true : undefined}
      data-swipe-exit={exit ?? undefined}
      style={
        exit
          ? {
              height: closing ? 0 : exitHeightRef.current,
              transition:
                exit === "closing"
                  ? `height ${EXIT_CLOSE_MS}ms ease-out`
                  : undefined,
              pointerEvents: "none",
            }
          : undefined
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        // Nothing follows a cancel, so the swallow flag has nothing to swallow
        // and must not survive into an unrelated click.
        swipedRef.current = false;
        reset();
      }}
      // A swipe must not also select/open the row it just acted on.
      onClickCapture={(event) => {
        if (!swipedRef.current) return;
        swipedRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {action && (travel !== 0 || settling || exit) ? (
        <div
          aria-hidden
          // The armed state is deliberately over-stated: filled colour, bolder
          // text and a larger icon, so "release now" survives a bright screen,
          // a colour-blind eye and a thumb covering half the panel. Everything
          // but the WORD changes — the label is what the action is, which arming
          // does not alter. It flips INSTANTLY: a threshold is a line, and a
          // treatment fading across it is a boundary you can misjudge
          // mid-gesture. The panel is square and borderless like the row it
          // extends: it reads as the row's far side, not a box laid over it.
          //
          // WHICH action is carried by the colour from the first px, not by the
          // arming: with a side each, a thumb has to be able to see that it is
          // opening the destructive one while it can still pull back.
          data-swipe-state={armed ? "armed" : "pending"}
          data-swipe-side={direction}
          data-swipe-tone={danger ? "danger" : undefined}
          className={`absolute inset-y-0 flex w-full items-center gap-1.5 px-3 text-sm ${
            direction === "left" ? "left-full" : "right-full"
          } ${
            armed
              ? danger
                ? "bg-danger font-semibold text-white"
                : "bg-primary font-semibold text-primary-foreground"
              : danger
                ? "bg-danger/25 font-medium text-danger"
                : "bg-line-strong font-medium text-fg"
          }`}
          style={slide}
        >
          {/* Pinned to the edge that leads the panel in, against the row: it
              is the part uncovered first, so icon then word ride in with the
              finger instead of waiting at the far edge. */}
          <span
            className={`flex items-center gap-1.5 whitespace-nowrap ${
              direction === "left" ? "mr-auto" : "ml-auto flex-row-reverse"
            }`}
          >
            {/* The icon grows with the arming, which is the cue that reaches a
                thumb still moving; it is nearest the row, ahead of the word. */}
            {action.icon ? (
              <span
                data-swipe-icon
                className={`flex items-center ${armed ? "scale-125" : ""}`}
              >
                {action.icon}
              </span>
            ) : null}
            {action.label}
          </span>
        </div>
      ) : null}
      <div style={slide}>{children}</div>
    </div>
  );
}
