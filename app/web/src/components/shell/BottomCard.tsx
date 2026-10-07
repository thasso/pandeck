import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import {
  BOTTOM_SHEET_GUTTER,
  BOTTOM_SHEET_MAX_HEIGHT_CLASS,
  BOTTOM_SHEET_SKIRT_CLASS,
  BOTTOM_SHEET_SURFACE_CLASS,
} from "../ui/bottomSheet.ts";
import { clampDockDragOffset, resolveDockDrag } from "./dockDrag.ts";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion.ts";

/** The grabber strip: an `h-1` pill in `py-2`, the card's top edge in BOTH states. */
const BOTTOM_CARD_GRABBER_PX = 20;
/** One row under it: a `size-9` control plus the row's bottom padding. */
const BOTTOM_CARD_ROW_PX = 40;
/** How long the card takes to reach the rest position a gesture or a tap chose. */
const SETTLE_MS = 190;
const SETTLE_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";
/**
 * Below this the pointer is still a tap. The grabber and the bare header ARE the
 * drag surface, so they give in early — but a mouse is precise where a finger is
 * not, and 3px of roll on a touch screen is a tap by any reasonable reading.
 */
const DRAG_SLOP_MOUSE_PX = 3;
const DRAG_SLOP_TOUCH_PX = 10;
/**
 * A gesture that starts ON one of the row's controls is a TAP until it is
 * unmistakably not: pressing a 36px button and rolling is normal, and losing that
 * press to the click guard means the button simply does not work — the worst
 * outcome available here, since the card can always be dragged by the grabber or
 * the empty space beside the controls. So the threshold is most of the button's
 * own height, and it only counts TOWARDS the other rest position: at peek there is
 * nowhere to go but up, so downward roll must never start a drag (and vice versa).
 */
const CONTROL_DRAG_SLOP_PX = 32;
/** Controls in the header that a press should run rather than drag from. */
const CONTROL_SELECTOR = "button, a, [role='button'], input, select, textarea";

/**
 * Height of a card at rest — the grabber plus its header row, which is exactly
 * what stays on screen. Numbers rather than a Tailwind class because the surface
 * behind has to reserve the same space, and a class assembled at runtime is
 * invisible to Tailwind. Keep it in step with the classes below; the card measures
 * itself for the gesture, so a drift here costs the reservation, not the motion.
 */
function bottomCardRestingPx(hasRow: boolean): number {
  return BOTTOM_CARD_GRABBER_PX + (hasRow ? BOTTOM_CARD_ROW_PX : 0);
}

/**
 * Space the surface behind must reserve while a card rests over it. The card is an
 * overlay (so expanding and collapsing never re-lay out the page), which means the
 * surface has to keep its last rows clear of it by itself.
 */
export function bottomCardInset(hasRow: boolean): string {
  return `calc(${bottomCardRestingPx(hasRow)}px + var(--app-safe-area-bottom, 0px))`;
}

/**
 * @component BottomCard
 * @purpose The app's small-screen bottom surface: ONE card that rests showing its
 * header and slides up into a sheet (app/web/docs/ui-shell.md, Small Screens).
 * @useWhen A phone screen needs a resting row at the bottom edge that expands into
 * more of the same subject — the object dock's Details, the navigation bar's folded
 * slots.
 * @avoidWhen A transient modal surface with a title and a close button: that is
 * `ui/Sheet`. This one RESTS on screen and must not be modal until it is open.
 * @intent ONE element in two positions, not two surfaces handing over to each
 * other — that split is what made the gesture feel clunky, because a resting row
 * and a portaled sheet are different elements and neither can be grown live. The
 * card always carries its header and translates between fully open and "only the
 * header showing", so a drag tracks the finger continuously in both directions and
 * whatever is in that header stays put and usable at both ends. The whole header
 * drags, so the target is the full card width and however many rows tall it is, and
 * a tap on the grabber toggles: the gesture is never the only way.
 *
 * Content-agnostic: hosts supply the header row and the body, and the body gets
 * `collapse` so acting inside it can reveal the result underneath. What the hosts
 * share is not a look (`ui/bottomSheet.ts` tokens already give every bottom surface
 * that) but the MECHANICS: travel, thresholds, the click guard, the entrance.
 *
 * Positioned inside its host's box rather than portaled: `position: fixed` resolves
 * against the LAYOUT viewport, so a fixed card bleeds behind iOS Safari's floating
 * address bar — right for a transient sheet's background, wrong for a header you
 * have to be able to hit. Only the BACKDROP is fixed (and stays inside this box, so
 * it cannot end up above the card through some ancestor's stacking context), which
 * keeps the dimming covering everything the way a modal should. The home-indicator
 * inset is likewise a strip of the card's own background below it rather than empty
 * space, so the card reads as docked without its content entering the inset.
 */
export function BottomCard({
  mode,
  header,
  renderBody,
  onExpand,
  onCollapse,
  animate = true,
  expandBlocked = false,
  blockedReason,
  openLabel,
  collapseLabel,
}: {
  /** `hidden` renders nothing, `peek` rests showing the header, `expanded` is open. */
  mode: "hidden" | "peek" | "expanded";
  /** The row(s) under the grabber. Visible in BOTH positions, and part of the drag target. */
  header?: ReactNode;
  /** The expanded body. `collapse` lets it get out of the way after acting. */
  renderBody: (collapse: () => void) => ReactNode;
  onExpand: () => void;
  onCollapse: () => void;
  /** Subject to prefers-reduced-motion, like the shell's panel presence. */
  animate?: boolean;
  /** The host claims the row for itself (a session recording); opening is refused. */
  expandBlocked?: boolean;
  /** Why opening is refused, shown on the grabber instead of its usual hint. */
  blockedReason?: string;
  openLabel: string;
  collapseLabel: string;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const shouldAnimate = animate && !reducedMotion;

  /**
   * The card can only travel once it HAS its open height, so the body must be
   * mounted before a drag starts — but mounting it at rest would run whatever work
   * the body does (an inspector's data fetches) for a panel nobody opened. So it is
   * mounted while a finger rests on the header (`warm`), early enough that the work
   * lands in the gap before the finger moves rather than on the drag's first frame,
   * and released again if that touch turns out to have been a tap.
   */
  const [warm, setWarm] = useState(false);
  /** A drag is in flight: the page behind the card is dimmed for the duration. */
  const [dragging, setDragging] = useState(false);
  const bodyMounted = mode === "expanded" || warm;
  const overlay = mode === "expanded" || dragging;
  const bodyMountedRef = useRef(bodyMounted);
  useLayoutEffect(() => {
    bodyMountedRef.current = bodyMounted;
  }, [bodyMounted]);

  // A drag or a settle animation owns the card's transform while it runs; the
  // effect below must not fight it (it would restart the motion mid-gesture).
  const transformLockedRef = useRef(false);
  // A completed drag must not also fire the click the finger started on — the
  // grabber's toggle, or a control it began over. `preventDefault` on pointerup
  // does not reliably suppress the synthesized click, so the header swallows it in
  // the capture phase instead.
  const draggedRef = useRef(false);
  const settleTimerRef = useRef<number | undefined>(undefined);
  const previousModeRef = useRef(mode);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== undefined)
      window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = undefined;
  }, []);

  useEffect(() => clearSettleTimer, [clearSettleTimer]);

  /** Distance between the two rest positions: everything below the header. */
  const travelPx = useCallback((): number => {
    const card = cardRef.current;
    const head = headerRef.current;
    if (!card || !head) return 0;
    return Math.max(
      0,
      card.getBoundingClientRect().height - head.getBoundingClientRect().height,
    );
  }, []);

  /**
   * Hold the card at the position its state implies, and animate the entrance when
   * a tap (rather than a drag) opened it.
   *
   * The card is anchored to the bottom edge, so mounting the body makes it grow
   * UPWARD: a resting card whose body is mounted must be pushed back down by exactly
   * the body's height, or the header jumps up from under the finger still resting on
   * it — which also moves the click target out from under the release and swallows
   * the tap entirely.
   */
  useLayoutEffect(() => {
    const entering =
      previousModeRef.current !== "expanded" && mode === "expanded";
    previousModeRef.current = mode;
    const card = cardRef.current;
    if (!card || transformLockedRef.current) return;
    const park = (offset: number) => {
      card.style.transition = "none";
      card.style.transform = `translateY(${offset}px)`;
    };
    if (mode !== "expanded") {
      park(bodyMounted ? travelPx() : 0);
      return;
    }
    const travel = travelPx();
    if (!entering || !shouldAnimate || travel <= 0) {
      park(0);
      return;
    }
    park(travel);
    const frame = requestAnimationFrame(() => {
      card.style.transition = `transform ${SETTLE_MS}ms ${SETTLE_EASE}`;
      card.style.transform = "translateY(0)";
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, bodyMounted, shouldAnimate, travelPx]);

  /**
   * Slide the card down to the resting position and only then tell the host it
   * closed: unmounting the body first would leave a header-tall card translated a
   * whole sheet-height down, which is a card nobody can see.
   */
  const collapse = useCallback(() => {
    const card = cardRef.current;
    const travel = travelPx();
    const land = () => {
      transformLockedRef.current = false;
      // Synchronous, so the body unmounts and the transform resets in one paint.
      flushSync(() => {
        setWarm(false);
        setDragging(false);
        onCollapse();
      });
      card?.style.setProperty("transition", "none");
      card?.style.setProperty("transform", "translateY(0)");
    };
    if (!card || !shouldAnimate || travel <= 0) {
      land();
      return;
    }
    clearSettleTimer();
    transformLockedRef.current = true;
    card.style.transition = `transform ${SETTLE_MS}ms ${SETTLE_EASE}`;
    card.style.transform = `translateY(${travel}px)`;
    settleTimerRef.current = window.setTimeout(land, SETTLE_MS);
  }, [clearSettleTimer, onCollapse, shouldAnimate, travelPx]);

  useEffect(() => {
    if (mode !== "expanded") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") collapse();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode, collapse]);

  /**
   * The whole header drags — grabber and row alike — in both directions, so the
   * target is the card's full width and every row of it. Never the body below it:
   * that scrolls, and a pull-to-dismiss competing with an inner scroll is how a
   * sheet ends up feeling stuck. The gesture writes `transform` DIRECTLY to the
   * DOM, since a React state update per pointermove would re-render the whole body
   * on every frame of a 60Hz drag.
   *
   * A press that lands on one of the row's CONTROLS is biased hard towards being a
   * tap (`CONTROL_DRAG_SLOP_PX`, and only towards the reachable rest position):
   * dragging is always available from the grabber and the space between the
   * controls, so there is nothing to win by stealing a button press and a working
   * button to lose.
   */
  const onHeaderPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const card = cardRef.current;
      if (!card || event.button !== 0) return;
      // The host can claim the row: a session's dictation takes it over, and opening
      // the card mid-sentence would put a screen of content under the thumb that is
      // aiming for Stop.
      if (mode !== "expanded" && expandBlocked) return;
      const pointerId = event.pointerId;
      const startY = event.clientY;
      const startedExpanded = mode === "expanded";
      // Where the card can still travel: up from peek, down from expanded. Only
      // movement that way can be a drag at all — the other direction is overshoot,
      // which is worth a rubber band from the drag surface and nothing from a
      // control, whose press must survive it.
      const towards = startedExpanded ? 1 : -1;
      const target = event.target instanceof Element ? event.target : null;
      const control = target?.closest(CONTROL_SELECTOR);
      const fromControl =
        Boolean(control) && !control?.hasAttribute("data-card-grabber");
      const slop =
        event.pointerType === "mouse" ? DRAG_SLOP_MOUSE_PX : DRAG_SLOP_TOUCH_PX;
      const startsDrag = (delta: number) =>
        fromControl
          ? delta * towards >= CONTROL_DRAG_SLOP_PX
          : Math.abs(delta) >= slop;
      let travel = 0;
      let startOffset = 0;
      let offset = 0;
      let lastY = startY;
      let lastAt = event.timeStamp;
      let velocity = 0;
      let moved = false;

      draggedRef.current = false;
      clearSettleTimer();
      // Mount the body now, while the finger is still deciding whether this is a
      // drag; the effect above holds the card down, so nothing appears to move.
      // NOT for a press on a control: that is a tap until proven otherwise, and
      // mounting an inspector (which fetches, and grows as it lands) under a finger
      // about to lift is wasted work whose growth the parked card does not follow —
      // one of the ways this row twitched when you only meant to press it. Such a
      // press warms below instead, once it starts moving the right way.
      if (!startedExpanded && !fromControl) setWarm(true);

      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientY - startY;
        if (!moved) {
          // Moving off a control: probably a drag after all, so start the body now
          // rather than at the (much larger) threshold it still has to cross.
          if (
            fromControl &&
            !startedExpanded &&
            delta * towards >= DRAG_SLOP_TOUCH_PX
          )
            setWarm(true);
          if (!startsDrag(delta)) return;
          moved = true;
          draggedRef.current = true;
          transformLockedRef.current = true;
          setDragging(true);
          // Only needed when the pointerdown mount has not committed yet: a drag
          // that got going before React caught up.
          if (!bodyMountedRef.current) flushSync(() => setWarm(true));
          travel = travelPx();
          startOffset = startedExpanded ? 0 : travel;
          card.style.transition = "none";
          card.style.transform = `translateY(${startOffset}px)`;
          // Retarget the synthesized click to the card, so a drag that began on a
          // control in the header does not also run it.
          card.setPointerCapture(pointerId);
        }
        const dt = moveEvent.timeStamp - lastAt;
        if (dt > 0) velocity = (moveEvent.clientY - lastY) / dt;
        lastY = moveEvent.clientY;
        lastAt = moveEvent.timeStamp;
        offset = clampDockDragOffset(startOffset + delta, travel);
        card.style.transform = `translateY(${offset}px)`;
      };

      const detach = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        if (card.hasPointerCapture(pointerId))
          card.releasePointerCapture(pointerId);
      };

      /** Ride the remaining distance out to the rest position the release chose. */
      const settle = (next: "expanded" | "peek") => {
        if (next === "peek") {
          collapse();
          return;
        }
        // Flip the host state NOW, while the lock is still held: the layout effect
        // then leaves the transform alone and this animation finishes the motion.
        if (!startedExpanded) onExpand();
        const land = () => {
          transformLockedRef.current = false;
          setDragging(false);
          setWarm(false);
        };
        if (!shouldAnimate) {
          card.style.transition = "none";
          card.style.transform = "translateY(0)";
          land();
          return;
        }
        card.style.transition = `transform ${SETTLE_MS}ms ${SETTLE_EASE}`;
        card.style.transform = "translateY(0)";
        settleTimerRef.current = window.setTimeout(land, SETTLE_MS);
      };

      const finish = () => {
        detach();
        if (!moved) {
          // A tap: the click that follows decides what happens, so let go of the
          // body warmed up for a drag that never came.
          if (!startedExpanded) setWarm(false);
          return;
        }
        settle(resolveDockDrag({ offset, travel, velocity }));
      };

      const cancel = () => {
        detach();
        if (!moved) {
          if (!startedExpanded) setWarm(false);
          return;
        }
        settle(startedExpanded ? "expanded" : "peek");
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
    },
    [
      clearSettleTimer,
      collapse,
      expandBlocked,
      mode,
      onExpand,
      shouldAnimate,
      travelPx,
    ],
  );

  const onHeaderClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!draggedRef.current) return;
      // The gesture already decided what happens; the click it left behind must not
      // toggle the card back or run the control the finger started on.
      draggedRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );

  if (mode === "hidden") return null;

  const expanded = mode === "expanded";

  return (
    /* Full-height positioning box so the card has room to grow into, but
       `pointer-events-none` so the surface behind a resting card stays live. */
    <div
      className={`pointer-events-none absolute inset-0 flex flex-col justify-end ${BOTTOM_SHEET_GUTTER} ${overlay ? "z-[66]" : "z-40"}`}
    >
      {overlay ? (
        <div
          className="pointer-events-auto fixed inset-0 bg-black/40"
          onClick={expanded ? collapse : undefined}
          // Purely a dimmed dismissal target; the card carries the dialog role.
          aria-hidden="true"
        />
      ) : null}

      <div
        ref={cardRef}
        // Modal only at the top of its travel: at rest this is a row like any other
        // and the surface behind it is still the thing being used.
        role={expanded ? "dialog" : undefined}
        aria-modal={expanded ? true : undefined}
        className={`pointer-events-auto relative flex w-full flex-col overflow-hidden ${BOTTOM_SHEET_SURFACE_CLASS} ${BOTTOM_SHEET_MAX_HEIGHT_CLASS}`}
      >
        {/* The header is the card's top edge in both positions: the grabber never
            moves as the card grows, and the row below keeps its full width for the
            host's own controls. All of it drags. */}
        <div
          ref={headerRef}
          onPointerDown={onHeaderPointerDown}
          onClickCapture={onHeaderClickCapture}
          className="flex shrink-0 touch-none flex-col"
        >
          <button
            type="button"
            // This one IS the drag surface, so it keeps the low threshold while
            // every other control in the header is treated as a press.
            data-card-grabber=""
            onClick={() => (expanded ? collapse() : onExpand())}
            disabled={!expanded && expandBlocked}
            aria-label={expanded ? collapseLabel : openLabel}
            aria-expanded={expanded}
            title={
              expanded
                ? `Drag down or tap to close — ${collapseLabel}`
                : expandBlocked
                  ? (blockedReason ?? openLabel)
                  : `Drag up or tap to open — ${openLabel}`
            }
            className="group flex w-full items-center justify-center py-2 disabled:cursor-default"
          >
            <span className="h-1 w-10 rounded-full bg-line-strong transition-colors group-hover:bg-muted-foreground" />
          </button>
          {header}
        </div>
        {bodyMounted ? (
          <div className="min-h-0 flex-1 overflow-hidden pb-3">
            {renderBody(collapse)}
          </div>
        ) : null}
      </div>

      {/* The home-indicator inset, as a strip rather than padding on the box: the
          card's CONTENT stops above it (so the row stays reachable), while its
          background carries on to the bottom of the screen. Without this the card
          floats a thumb's width off the edge on an installed iOS Home Screen app,
          with the page scrolling past underneath a bar that is meant to be docked. */}
      <div
        aria-hidden
        className={`relative h-[var(--app-safe-area-bottom,0px)] shrink-0 ${BOTTOM_SHEET_SKIRT_CLASS}`}
      />
    </div>
  );
}
