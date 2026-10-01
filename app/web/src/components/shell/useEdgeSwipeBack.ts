import { useCallback, useEffect, useRef, useState } from "react";
import {
  classifyEdgeSwipeMove,
  edgeSwipeClaimsTouch,
  edgeSwipeCommits,
  edgeSwipeStartAllowed,
  edgeSwipeTravel,
} from "./edgeSwipe.ts";
import { viewportWidth } from "./panelSizing.ts";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion.ts";

/**
 * How long a committed screen takes to finish leaving, and how long one springs
 * home. Exported because they are also the CSS transition the shell paints:
 * this hook decides when the navigation happens, so a transition that outlived
 * the timer would swap the route mid-slide.
 */
export const EDGE_SWIPE_COMMIT_MS = 200;
export const EDGE_SWIPE_SETTLE_MS = 180;

/**
 * A finger that has not moved for this long is standing still, whatever its
 * last sample said: without this, holding the screen halfway and lifting would
 * be judged by the speed it arrived at, which is a flick the hand did not make.
 */
const EDGE_SWIPE_VELOCITY_STALE_MS = 80;

/**
 * `dragging` — under the finger, no transition;
 * `committing` — running out to the far edge, navigation happens when it lands;
 * `settling` — springing home, the gesture came to nothing.
 */
export type EdgeSwipePhase = "idle" | "dragging" | "committing" | "settling";

export interface EdgeSwipeState {
  phase: EdgeSwipePhase;
  /** px the leaving screen is drawn to the right of its resting place. */
  travel: number;
  /** The viewport width the current gesture is measured against. */
  width: number;
  /** Whether the destination underneath should be mounted and drawn. */
  active: boolean;
  /** Put on the element the gesture drags; it is also the element it listens on. */
  ref: (node: HTMLElement | null) => void;
}

/**
 * Whether a touch landed on the SCREEN, or on something stacked over it.
 *
 * The gesture drags one box and may only be started by a touch that belongs to
 * that box. Two things can be over it, and this rules out both by construction
 * rather than by a register every new surface has to remember to join — the
 * failure mode of a list of exceptions is silent, and it is a modal that
 * navigates out from under the hand:
 *
 * - A PORTALED layer (every modal sheet, dialog and popover in `components/`
 *   portals to `document.body`) is not a DOM descendant of the host at all, so
 *   the walk runs off the top and ends at `null`. Note this is a real answer,
 *   not a coincidence of listeners: React synthetic events would have carried
 *   those touches to the host through the REACT tree, which is why the gesture
 *   listens on the DOM instead.
 * - An IN-TREE layer over the screen is `position: fixed` — that is what makes
 *   it a layer rather than page content (`WorktreeDialogs`, the Usage export
 *   dialog, `SendCommentsSheet`, the dock's backdrop, floating chrome).
 *
 * The walk costs a `getComputedStyle` per ancestor, and runs only for a touch
 * that already landed in the leading strip — not on the scroll path.
 */
function startsOnTheScreen(
  target: EventTarget | null,
  host: HTMLElement,
): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== host) {
    if (window.getComputedStyle(node).position === "fixed") return false;
    node = node.parentElement;
  }
  return node === host;
}

/**
 * The screen-edge back gesture: a rightward pull from the leading edge that
 * runs the screen's ONE back action (`app/web/docs/ui-shell.md`, Small Screens).
 *
 * TOUCH only, and only where the host says the edge is ours — in an ordinary
 * browser it belongs to the platform's own back/forward gesture and this hook
 * stays asleep (`lib/nativeShell.ts`). The math is in `edgeSwipe.ts`; what is
 * here is the DOM: the element the gesture listens on (see `startsOnTheScreen`
 * for why that is the DOM and not React's event tree), which pointer it owns,
 * the velocity a release is judged by, and the ordering that makes the
 * navigation invisible — the leaving screen finishes its run FIRST, and
 * `onBack` fires in the same batch that drops the transform, so the destination
 * is never seen sliding out.
 */
export function useEdgeSwipeBack({
  enabled,
  onBack,
}: {
  enabled: boolean;
  onBack: () => void | Promise<void>;
}): EdgeSwipeState {
  const startRef = useRef<{
    id: number;
    x: number;
    y: number;
    width: number;
  } | null>(null);
  const engagedRef = useRef(false);
  // Whether the scroller has been cut out of this touch (`preventDefault` on
  // its moves). Set before the gesture engages, and the reason the rest of the
  // pull may wander vertically as much as a thumb naturally does.
  const claimedRef = useRef(false);
  // Last two samples, for the release velocity: a flick delivers little travel
  // before the finger leaves the glass, so distance alone would refuse it.
  const sampleRef = useRef<{ x: number; t: number } | null>(null);
  const velocityRef = useRef(0);
  // Travel is mirrored into state for the transform but READ from the ref on
  // release: a flick can deliver its last move and the release in one batch,
  // and a release judged by the rendered value is a frame behind the finger.
  const travelRef = useRef(0);
  // A gesture that engaged is followed by a click on whatever was under the
  // finger, so the fact that it happened has to outlive it by one event.
  const swipedRef = useRef(false);
  const hostRef = useRef<HTMLElement | null>(null);
  const onBackRef = useRef(onBack);
  const [phase, setPhase] = useState<EdgeSwipePhase>("idle");
  const [travel, setTravel] = useState(0);
  const [width, setWidth] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  const reset = useCallback(() => {
    startRef.current = null;
    engagedRef.current = false;
    claimedRef.current = false;
    sampleRef.current = null;
    velocityRef.current = 0;
    travelRef.current = 0;
  }, []);

  // A gesture in flight when the screen stops having a back action — a route
  // change from anywhere else, a rotation into the wide layout — is abandoned
  // outright rather than left holding the shell off its resting transform.
  useEffect(() => {
    if (enabled) return;
    reset();
    setPhase("idle");
    setTravel(0);
  }, [enabled, reset]);

  // The two endings are timed rather than driven by `transitionend`: an
  // interrupted transition never fires one, and a screen stuck off-frame is the
  // one failure this gesture must not have.
  useEffect(() => {
    if (phase !== "committing" && phase !== "settling") return;
    const committing = phase === "committing";
    let live = true;
    const finish = () => {
      if (!live) return;
      setPhase("idle");
      setTravel(0);
    };
    const timer = window.setTimeout(
      () => {
        if (!committing) {
          finish();
          return;
        }
        const navigation = onBackRef.current();
        if (
          navigation &&
          typeof (navigation as Promise<void>).then === "function"
        )
          void navigation.then(finish, finish);
        else finish();
      },
      committing ? EDGE_SWIPE_COMMIT_MS : EDGE_SWIPE_SETTLE_MS,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [phase]);

  // Listeners live on the DOM node, in the capture phase: capture so an inner
  // scroller cannot hide the gesture behind a `stopPropagation`, and the DOM so
  // the host's subtree is the honest boundary of what may start one.
  const [host, setHost] = useState<HTMLElement | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    hostRef.current = node;
    setHost(node);
  }, []);

  useEffect(() => {
    if (!host) return;

    const onPointerDown = (event: PointerEvent) => {
      swipedRef.current = false;
      if (!enabled || event.pointerType !== "touch") return;
      if (!edgeSwipeStartAllowed(event.clientX)) return;
      if (!startsOnTheScreen(event.target, host)) return;
      const measured = viewportWidth();
      startRef.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        width: measured,
      };
      engagedRef.current = false;
      claimedRef.current = false;
      sampleRef.current = { x: event.clientX, t: event.timeStamp };
      velocityRef.current = 0;
    };

    const onPointerMove = (event: PointerEvent) => {
      const start = startRef.current;
      if (!start || event.pointerId !== start.id) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      // Claimed before engaged, and never given back: the browser starts a pan
      // within the first few px of movement, so the touch has to be taken while
      // its moves are still cancelable.
      if (!claimedRef.current && edgeSwipeClaimsTouch(dx, dy))
        claimedRef.current = true;
      if (!engagedRef.current) {
        const decision = classifyEdgeSwipeMove(dx, dy, claimedRef.current);
        if (decision === "pending") return;
        if (decision === "abandoned") {
          reset();
          return;
        }
        engagedRef.current = true;
        swipedRef.current = true;
        setWidth(start.width);
        setPhase("dragging");
        // Own the pointer from here: the screen keeps receiving moves once the
        // finger has left the element it started on, and a gesture that stopped
        // hearing about its own finger cannot be released.
        host.setPointerCapture?.(event.pointerId);
      }
      const previous = sampleRef.current;
      if (previous) {
        const elapsed = event.timeStamp - previous.t;
        if (elapsed > 0)
          velocityRef.current = (event.clientX - previous.x) / elapsed;
      }
      sampleRef.current = { x: event.clientX, t: event.timeStamp };
      const next = edgeSwipeTravel(dx, start.width);
      travelRef.current = next;
      setTravel(next);
    };

    /**
     * The veto that keeps the page still under a claimed touch. Pointer events
     * cannot say this — only the touch stream is cancelable — and it has to be
     * said on the FIRST move that leans our way: preventing a cancelable
     * `touchmove` stops the sequence from ever scrolling, while a pan already
     * under way ignores it and takes the pointer with it.
     *
     * It answers the claim from its OWN coordinates rather than trusting the
     * pointer move to have run first. The spec orders it that way, but a frame
     * of the wrong answer here is a scroll that has already started, and this
     * gesture has exactly one chance to say no.
     */
    const onTouchMove = (event: TouchEvent) => {
      const start = startRef.current;
      if (!start) return;
      if (!claimedRef.current && !engagedRef.current) {
        const touch = event.touches.item(0);
        if (!touch) return;
        if (
          !edgeSwipeClaimsTouch(
            touch.clientX - start.x,
            touch.clientY - start.y,
          )
        )
          return;
        claimedRef.current = true;
      }
      if (event.cancelable) event.preventDefault();
    };

    const onPointerUp = (event: PointerEvent) => {
      const start = startRef.current;
      if (!start || event.pointerId !== start.id) return;
      const engaged = engagedRef.current;
      const measured = start.width;
      const idleFor =
        event.timeStamp - (sampleRef.current?.t ?? event.timeStamp);
      const committed =
        engaged &&
        edgeSwipeCommits({
          travel: travelRef.current,
          viewportWidth: measured,
          velocity:
            idleFor > EDGE_SWIPE_VELOCITY_STALE_MS ? 0 : velocityRef.current,
        });
      reset();
      if (!engaged) {
        setPhase("idle");
        return;
      }
      if (reducedMotion) {
        // No run-out to watch: the navigation IS the answer.
        if (committed) void onBackRef.current();
        setPhase("idle");
        setTravel(0);
        return;
      }
      setPhase(committed ? "committing" : "settling");
      setTravel(committed ? measured : 0);
    };

    const onPointerCancel = (event: PointerEvent) => {
      const start = startRef.current;
      if (!start || event.pointerId !== start.id) return;
      const engaged = engagedRef.current;
      reset();
      if (!engaged) {
        setPhase("idle");
        return;
      }
      setPhase(reducedMotion ? "idle" : "settling");
      setTravel(0);
    };

    const onClick = (event: MouseEvent) => {
      if (!swipedRef.current) return;
      swipedRef.current = false;
      // Whatever the finger came down on is not what it went on to do.
      event.preventDefault();
      event.stopPropagation();
    };

    host.addEventListener("pointerdown", onPointerDown, true);
    host.addEventListener("pointermove", onPointerMove, true);
    // Non-passive, or `preventDefault` is ignored. Capture, and ahead of the
    // touch stream's own default: the pointer moves land first, so the claim is
    // already decided by the time this runs.
    host.addEventListener("touchmove", onTouchMove, {
      capture: true,
      passive: false,
    });
    host.addEventListener("pointerup", onPointerUp, true);
    host.addEventListener("pointercancel", onPointerCancel, true);
    host.addEventListener("click", onClick, true);
    return () => {
      host.removeEventListener("pointerdown", onPointerDown, true);
      host.removeEventListener("pointermove", onPointerMove, true);
      host.removeEventListener("touchmove", onTouchMove, true);
      host.removeEventListener("pointerup", onPointerUp, true);
      host.removeEventListener("pointercancel", onPointerCancel, true);
      host.removeEventListener("click", onClick, true);
    };
  }, [host, enabled, reducedMotion, reset]);

  return {
    phase,
    travel,
    width,
    active: phase !== "idle",
    ref,
  };
}
