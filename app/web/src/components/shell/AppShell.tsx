import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  ResizableSeparator,
  RESIZE_KEYBOARD_STEP,
  useResizeDrag,
} from "../ui/ResizableSeparator.tsx";
import { dockMode } from "./dockState.ts";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion.ts";
import {
  dockHasActionRow,
  dockPeekInset,
  ObjectDock,
  type DockPeek,
} from "./ObjectDock.tsx";
import {
  clampPanelWidth,
  maxPanelWidth,
  viewportWidth,
} from "./panelSizing.ts";
import { edgeSwipeParallax } from "./edgeSwipe.ts";
import {
  EDGE_SWIPE_COMMIT_MS,
  EDGE_SWIPE_SETTLE_MS,
  useEdgeSwipeBack,
  type EdgeSwipePhase,
} from "./useEdgeSwipeBack.ts";

const PANEL_ANIMATION_MS = 140;

/** Stable no-op so a shell without a back action does not re-arm the gesture. */
const NO_BACK = () => {};

/**
 * Both layers of an edge-swipe move under one transition: none while the finger
 * has them, and otherwise the hook's own duration for that ending — it is what
 * decides when the navigation happens, so a longer paint would swap the route
 * mid-slide.
 */
function edgeSwipeTransition(phase: EdgeSwipePhase): string | undefined {
  if (phase === "dragging" || phase === "idle") return undefined;
  const ms =
    phase === "committing" ? EDGE_SWIPE_COMMIT_MS : EDGE_SWIPE_SETTLE_MS;
  return `transform ${ms}ms ease-out`;
}

/** One side panel of the shell (left sidebar or right inspector/panel). */
export interface ShellPanel {
  /** Whether the panel is requested open; the shell animates presence. */
  open: boolean;
  /** Requested width in px; the shell clamps it against the viewport. */
  width: number;
  minWidth: number;
  /** Persist a user resize (receives the clamped width). */
  onResize: (width: number) => void;
  /** Animate open/close transitions (subject to prefers-reduced-motion). */
  animate?: boolean;
  /**
   * How the panel presents in mobile (single-pane) mode:
   * - `overlay` (default): a dismissible full-screen overlay over the main pane.
   * - `screen`: a full-screen screen whose visibility the host derives from the
   *   route — it does not animate and Escape does not dismiss it, because there
   *   is no user-owned open state to close (see app/web/docs/ui-shell.md).
   * - `dock`: a resting peek row at the bottom edge that expands into a sheet
   *   (`open` means EXPANDED). The peek is non-modal; the page scrolls behind it.
   */
  mobilePresentation?: "screen" | "overlay" | "dock";
  /**
   * Resting header for `dock` presentation: its PRESENCE enables the resting
   * card, `back` leads its action row and `actions` trails it. Omit it where the
   * screen's bottom edge belongs to something else (a session's composer carries
   * the dock's handle in its own compact bar); the sheet still opens.
   */
  peek?: DockPeek;
  /** For `dock`: no object to inspect on this screen, so no dock at all. */
  mobileDockSuppressed?: boolean;
  /** For `dock`: the peek row asked to expand into the sheet. */
  onExpand?: () => void;
  /** Close request issued by the shell (Escape while a mobile overlay is open). */
  onDismiss?: () => void;
  /** Accessible name of the panel, used for the resize handle. */
  label: string;
  /**
   * Keep the content mounted in a hidden host while this desktop panel is closed.
   * Use this when content publishes state to chrome outside the panel itself.
   */
  keepMountedWhenClosed?: boolean;
  content: ReactNode;
}

interface Props {
  /** Mobile (single-pane) layout mode; see useMobileLayout. */
  mobile: boolean;
  /**
   * App header bar spanning the full shell width. Omitted on small screens, where
   * navigation is the browser screen plus the object dock's row and the bar had
   * nothing left to hold — the shell then owns the top safe-area inset itself.
   */
  header?: ReactNode;
  left?: ShellPanel | undefined;
  right?: ShellPanel | undefined;
  /**
   * The screen's back action, made available as a pull from the leading screen
   * edge on small screens. The shell owns the gesture because the screen it
   * drags is the whole shell and what it reveals is the left panel's content;
   * the host decides only whether this screen HAS a back action and whether the
   * edge is the app's to claim at all (`lib/nativeShell.ts`).
   */
  edgeBack?:
    { enabled: boolean; onBack: () => void | Promise<void> } | undefined;
  /** Main pane content. */
  children: ReactNode;
}

/**
 * Keeps a closing panel mounted until its exit animation finishes, and tags
 * the entering frame so the slide-in class applies exactly once.
 */
function usePanelPresence(open: boolean, animate: boolean) {
  const reducedMotion = usePrefersReducedMotion();
  const shouldAnimate = animate && !reducedMotion;
  const [presence, setPresence] = useState(() => ({
    rendered: open,
    closing: false,
    entering: false,
  }));

  useEffect(() => {
    setPresence((current) => {
      if (open) {
        return {
          rendered: true,
          closing: false,
          entering: !current.rendered && shouldAnimate,
        };
      }
      if (!current.rendered)
        return current.closing || current.entering
          ? { rendered: false, closing: false, entering: false }
          : current;
      if (!shouldAnimate)
        return { rendered: false, closing: false, entering: false };
      return { rendered: true, closing: true, entering: false };
    });
  }, [open, shouldAnimate]);

  useEffect(() => {
    if (!presence.entering && !presence.closing) return;
    const timeout = window.setTimeout(() => {
      setPresence((current) => {
        if (current.entering) return { ...current, entering: false };
        if (current.closing)
          return { rendered: false, closing: false, entering: false };
        return current;
      });
    }, PANEL_ANIMATION_MS);
    return () => window.clearTimeout(timeout);
  }, [presence.entering, presence.closing]);

  return { ...presence, shouldAnimate };
}

type PanelPresence = ReturnType<typeof usePanelPresence>;

function panelAnimationClass(
  presence: PanelPresence,
  side: "left" | "right",
): string {
  if (!presence.shouldAnimate) return "";
  if (presence.closing)
    return `app-sidebar-slide-${side}-out pointer-events-none`;
  if (presence.entering) return `app-sidebar-slide-${side}-in`;
  return "";
}

/**
 * @component AppShell
 * @purpose Generic three-pane application shell frame: header bar, resizable
 * left sidebar, main pane, and resizable right panel, per app/web/docs/ui-shell.md.
 * @useWhen Composing the top-level app layout. Owns pane sizing/clamping,
 * open/close presence animation, mobile overlay presentation, and Escape-to-close
 * for mobile overlays.
 * @avoidWhen Laying out content inside a pane; the shell only frames panes.
 * @intent Panels are controlled from outside (open/width/callbacks) so the shell
 * stays stateless about what the panes contain. On mobile a side panel renders per
 * ShellPanel.mobilePresentation: a dismissible full-screen overlay, a plain
 * route-driven `screen` (the browser), or a bottom `dock` whose peek row rests on
 * screen and expands into a sheet (the object panel).
 * The main pane exposes its width as the --shell-main-width CSS variable for
 * width-clamped content (e.g. wide chat cards).
 */
export function AppShell({
  mobile,
  header,
  left,
  right,
  edgeBack,
  children,
}: Props) {
  // A mobile screen is route-driven: it neither animates (it is not opening over
  // anything, it IS the screen) nor answers Escape.
  const leftIsScreen = mobile && left?.mobilePresentation === "screen";
  const rightIsScreen = mobile && right?.mobilePresentation === "screen";
  // The right panel's mobile form: a bottom dock (peek + sheet) rather than a
  // full-screen overlay. `open` then means EXPANDED.
  const rightIsDock = mobile && right?.mobilePresentation === "dock";
  const rightDock = dockMode({
    mobile,
    browserScreen:
      Boolean(right?.mobileDockSuppressed) ||
      Boolean(left?.open && leftIsScreen),
    expanded: Boolean(right?.open),
    hasPeek: right?.peek != null,
  });
  const bottomChromeInset =
    rightDock !== "hidden" && right?.peek != null
      ? dockPeekInset(dockHasActionRow(right.peek))
      : "var(--app-safe-area-bottom, 0px)";
  useLayoutEffect(() => {
    document.documentElement.style.setProperty(
      "--app-bottom-chrome-inset",
      bottomChromeInset,
    );
    return () => {
      document.documentElement.style.removeProperty(
        "--app-bottom-chrome-inset",
      );
    };
  }, [bottomChromeInset]);
  const inlineLeft = usePanelPresence(
    Boolean(left?.open) && !mobile,
    left?.animate ?? true,
  );
  const overlayLeft = usePanelPresence(
    Boolean(left?.open) && mobile,
    leftIsScreen ? false : (left?.animate ?? true),
  );
  const inlineRight = usePanelPresence(
    Boolean(right?.open) && !mobile,
    right?.animate ?? true,
  );
  const overlayRight = usePanelPresence(
    Boolean(right?.open) && mobile && !rightIsDock,
    rightIsScreen ? false : (right?.animate ?? true),
  );

  // The edge gesture exists only where back is the screen's own answer: not on
  // the browser screen (it IS the destination), and not under a surface stacked
  // over it, whose own dismissal is what a gesture there would have to mean.
  const edgeBackEnabled =
    mobile &&
    Boolean(edgeBack?.enabled) &&
    !overlayLeft.rendered &&
    !overlayRight.rendered &&
    rightDock !== "expanded";
  const edgeSwipe = useEdgeSwipeBack({
    enabled: edgeBackEnabled,
    onBack: edgeBack?.onBack ?? NO_BACK,
  });

  const viewport = viewportWidth();
  const leftWidth = left
    ? clampPanelWidth(left.width, left.minWidth, viewport)
    : 0;
  const leftMax = left ? maxPanelWidth(left.minWidth, viewport) : 0;
  const leftOffset = left && inlineLeft.rendered ? leftWidth : 0;
  const rightWidth = right
    ? clampPanelWidth(right.width, right.minWidth, viewport, leftOffset)
    : 0;
  const rightMax = right
    ? maxPanelWidth(right.minWidth, viewport, leftOffset)
    : 0;
  const mainOffset =
    leftOffset + (right && inlineRight.rendered ? rightWidth : 0);

  // Escape closes mobile overlays (they cover the whole main pane). A mobile
  // screen has no open state of its own, so it is not dismissible.
  useEffect(() => {
    if (!mobile) return;
    const leftDismiss =
      left?.open && !leftIsScreen ? left.onDismiss : undefined;
    const rightDismiss =
      right?.open && !rightIsScreen && !rightIsDock
        ? right.onDismiss
        : undefined;
    if (!leftDismiss && !rightDismiss) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      leftDismiss?.();
      rightDismiss?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    mobile,
    leftIsScreen,
    rightIsScreen,
    rightIsDock,
    left?.open,
    left?.onDismiss,
    right?.open,
    right?.onDismiss,
  ]);

  const leftResize = useResizeDrag({
    onResize: useCallback(
      (clientX: number) => {
        if (!left) return;
        left.onResize(clampPanelWidth(clientX, left.minWidth, viewportWidth()));
      },
      [left],
    ),
  });

  const rightResize = useResizeDrag({
    onResize: useCallback(
      (clientX: number) => {
        if (!right) return;
        right.onResize(
          clampPanelWidth(
            window.innerWidth - clientX,
            right.minWidth,
            viewportWidth(),
            leftOffset,
          ),
        );
      },
      [leftOffset, right],
    ),
  });

  const resizeKeyHandler =
    (side: "left" | "right", panel: ShellPanel, current: number, max: number) =>
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // ArrowRight always moves the divider right: it grows the left panel but
      // shrinks the right panel.
      const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
      const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
      const reserved = side === "right" ? leftOffset : 0;
      const apply = (width: number) =>
        panel.onResize(
          clampPanelWidth(width, panel.minWidth, viewportWidth(), reserved),
        );
      if (event.key === grow) {
        event.preventDefault();
        apply(current + RESIZE_KEYBOARD_STEP);
      } else if (event.key === shrink) {
        event.preventDefault();
        apply(current - RESIZE_KEYBOARD_STEP);
      } else if (event.key === "Home") {
        event.preventDefault();
        apply(panel.minWidth);
      } else if (event.key === "End") {
        event.preventDefault();
        apply(max);
      }
    };

  return (
    <>
      {/* The destination, drawn UNDER the screen the finger is pulling aside:
          the same browser the panel would render, parallaxed in from the left so
          the two layers read as a stack being popped. Mounted only for the
          gesture — at rest this costs nothing, and while it is up the real panel
          is not rendered (the gesture is disabled once it is). */}
      {edgeSwipe.active && left && (
        // Framed exactly as the panel is when the route arrives at it — same
        // safe-area padding, same box — or the destination would step down the
        // height of the notch inset at the moment the navigation lands, which is
        // the one frame the whole gesture exists to make invisible.
        <div
          className={`fixed inset-0 z-0 flex flex-col overflow-hidden bg-surface text-fg ${header ? "" : "pt-[var(--app-safe-area-top)]"}`}
          aria-hidden
          inert
          style={{
            transform: `translate3d(${-edgeSwipeParallax(edgeSwipe.travel, edgeSwipe.width)}px, 0, 0)`,
            transition: edgeSwipeTransition(edgeSwipe.phase),
          }}
        >
          <div className="relative flex min-h-0 flex-1 overflow-hidden">
            {left.content}
          </div>
        </div>
      )}
      {/* With no header, the notch/status bar is the shell's problem: an installed
          standalone PWA draws under it, and every surface below would otherwise
          have to pad its own top edge. */}
      <div
        className={`relative z-10 flex h-full flex-col overflow-hidden bg-surface text-fg ${header ? "" : "pt-[var(--app-safe-area-top)]"}`}
        // Left at `none` at rest, which is every moment but the gesture: a
        // standing transform makes this the containing block for every fixed
        // descendant, and the dock's backdrop is one.
        style={
          edgeSwipe.active
            ? {
                transform: `translate3d(${edgeSwipe.travel}px, 0, 0)`,
                transition: edgeSwipeTransition(edgeSwipe.phase),
                boxShadow: "-12px 0 32px rgba(0, 0, 0, 0.30)",
              }
            : undefined
        }
        ref={edgeSwipe.ref}
      >
        {header}

        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          {left && inlineLeft.rendered && (
            <div
              className={`relative h-full shrink-0 ${panelAnimationClass(inlineLeft, "left")}`}
              style={{ width: leftWidth }}
            >
              {left.content}
              <ResizableSeparator
                edge="right"
                label={left.label}
                min={left.minWidth}
                max={leftMax}
                value={leftWidth}
                resizing={leftResize.resizing}
                onPointerDown={leftResize.onPointerDown}
                onKeyDown={resizeKeyHandler("left", left, leftWidth, leftMax)}
              />
            </div>
          )}

          {left && overlayLeft.rendered && (
            <div
              className={`absolute inset-0 z-50 ${panelAnimationClass(overlayLeft, "left")}`}
            >
              {left.content}
            </div>
          )}

          <div
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            style={
              {
                "--shell-main-width": `calc(100vw - ${mainOffset}px)`,
                // Reserved for as long as this screen HAS a resting dock, expanded or
                // not: releasing it on expand would re-lay out the page behind the
                // sheet and hand it back on collapse.
                ...(rightDock !== "hidden" && right?.peek != null
                  ? {
                      paddingBottom: dockPeekInset(
                        dockHasActionRow(right.peek),
                      ),
                    }
                  : {}),
              } as CSSProperties
            }
            // Fully covered by a mobile screen/overlay: keep it out of the focus
            // order and away from assistive tech instead of leaving a hidden pane
            // tabbable behind the visible one.
            inert={
              mobile &&
              (overlayLeft.rendered ||
                overlayRight.rendered ||
                rightDock === "expanded")
            }
          >
            {children}
          </div>

          {right && rightIsDock && (
            <ObjectDock
              mode={rightDock}
              peek={right.peek}
              onExpand={right.onExpand ?? (() => {})}
              onCollapse={right.onDismiss ?? (() => {})}
              animate={right.animate ?? true}
            >
              {right.content}
            </ObjectDock>
          )}

          {right && overlayRight.rendered && (
            <div
              className={`absolute inset-0 z-50 ${panelAnimationClass(overlayRight, "right")}`}
            >
              {right.content}
            </div>
          )}

          {right && inlineRight.rendered && (
            <div
              className={`relative h-full shrink-0 ${panelAnimationClass(inlineRight, "right")}`}
              style={{ width: rightWidth }}
            >
              <ResizableSeparator
                edge="left"
                label={right.label}
                min={right.minWidth}
                max={rightMax}
                value={rightWidth}
                resizing={rightResize.resizing}
                onPointerDown={rightResize.onPointerDown}
                onKeyDown={resizeKeyHandler(
                  "right",
                  right,
                  rightWidth,
                  rightMax,
                )}
              />
              {right.content}
            </div>
          )}

          {right &&
          !mobile &&
          right.keepMountedWhenClosed &&
          !inlineRight.rendered ? (
            <div className="hidden" aria-hidden inert>
              {right.content}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
