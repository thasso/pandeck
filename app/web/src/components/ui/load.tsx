import { LoaderCircle } from "lucide-react";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

/**
 * The app's loading, empty and error presentation (Task-361 / Task-383).
 *
 * This is the ONLY module allowed to spin, pulse or draw a dashed box:
 * `loadingStateAudit.test.ts` forbids `animate-spin`, `animate-pulse`,
 * `LoaderCircle`/`Loader2` and `border-dashed` everywhere else with no
 * exceptions, so a surface gets its five states from here or not at all. The
 * two treatments that are NOT loading states — a dashed edge that means
 * something other than empty, a pulse that means live — are named class tokens
 * here (`DASHED_EDGE`, `LIVE_PULSE`) rather than an audit bypass. Sizes are
 * tokens, not per-caller numbers — the pre-Task-383 code used every value
 * between 9 and 22 and no two spinners matched.
 *
 * Every animation is `motion-safe:` (R6) and every indicator carries a
 * `role="status"` with a label, so a fetch is announced without any surface
 * having to remember to. The model is `app/web/docs/loading-states.md`.
 */

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * The dashed edge itself, for the surfaces that draw one and are NOT empty
 * states. `EmptyBox` is the empty state; a dashed border anywhere else in this
 * app means one of exactly three other things, and each takes the token from
 * here so the audit still has ONE owner and a reviewer sees the import:
 *
 *  - a FILLABLE SLOT — the outline of something you can make
 *    (`NewSessionQuickStart`'s "New worktree" and "More…");
 *  - a PROVISIONAL object — a prompt that exists but has not been sent yet
 *    (`MessageList`'s queued bubble, `PeerPromptCard`);
 *  - an UNRESOLVED reference — `ProjectBadge`'s unknown project id.
 *
 * A region with nothing in it is not on that list: it uses `EmptyBox`.
 */
export const DASHED_EDGE = "border-dashed";

/**
 * The pulse of something LIVE, which is not a loading state and must not be
 * read as one: the dictation `Mic` while the microphone is opening (nothing has
 * been asked for, so a spinner would pose a question the user cannot answer).
 * Waiting for an ANSWER is `Spinner`; standing in for content that has not arrived is
 * `Skeleton`.
 */
export const LIVE_PULSE = "motion-safe:animate-pulse";

type SpinnerSize = "xs" | "sm" | "md" | "lg";

/**
 * Pixel sizes for the spinner tokens: `xs` fits inside `text-micro` chrome (a
 * card's state badge), `sm` sits inline in a caption row, `md` matches a
 * control's icon, `lg` is the whole-pane one.
 */
const SPINNER_PX: Record<SpinnerSize, number> = {
  xs: 10,
  sm: 13,
  md: 16,
  lg: 22,
};

/**
 * The ring variant sizes a border box rather than an SVG, so it takes the same
 * tokens as pixels. One frozen object per token: these sit on the transcript's
 * hottest render paths (every streaming tool call and thinking block), and an
 * inline object literal would allocate on each of them.
 */
const RING_STYLE: Record<SpinnerSize, CSSProperties> = {
  xs: { width: SPINNER_PX.xs, height: SPINNER_PX.xs },
  sm: { width: SPINNER_PX.sm, height: SPINNER_PX.sm },
  md: { width: SPINNER_PX.md, height: SPINNER_PX.md },
  lg: { width: SPINNER_PX.lg, height: SPINNER_PX.lg },
};

/**
 * `glyph` is the app's spinner everywhere; `ring` is the transcript's — the
 * bordered circle the tool-call and thinking headers drew by hand, kept as a
 * variant so those two hot paths render ONE element with no icon module behind
 * it (Task-390) instead of buying an audit exemption.
 */
type SpinnerVariant = "glyph" | "ring";

export interface SpinnerProps {
  size?: SpinnerSize;
  variant?: SpinnerVariant;
  className?: string;
}

/**
 * The app's one spinner. Decorative by construction (`aria-hidden`): the region
 * around it owns the announcement, so a spinner never reads out on its own and
 * two nested ones never announce twice.
 */
export function Spinner({
  size = "md",
  variant = "glyph",
  className,
}: SpinnerProps) {
  if (variant === "ring") {
    return (
      <span
        aria-hidden
        style={RING_STYLE[size]}
        className={cx(
          "inline-block shrink-0 rounded-full border-2 border-line border-t-primary motion-safe:animate-spin",
          className,
        )}
      />
    );
  }
  return (
    <LoaderCircle
      size={SPINNER_PX[size]}
      aria-hidden
      className={cx("shrink-0 motion-safe:animate-spin", className)}
    />
  );
}

export interface PaneLoadingProps {
  /** Announced and shown under the spinner. */
  label?: string;
  className?: string;
}

/**
 * A whole pane's first load. Use it only where the surface has no stable
 * silhouette to reserve — where it has one, `Skeleton` rows keep the layout
 * still and are the better answer (R4).
 *
 * It announces and it is NOT `aria-busy`: this element is a live region, and
 * `aria-busy` on a live region tells assistive tech it may hold the output back
 * until busy clears — which never happens here, because the pane unmounts this
 * whole node the moment the data lands. The busy flag belongs on the PERSISTENT
 * container whose content is being swapped, where it really does go true→false
 * (`QuickRow`'s `busy`, a transcript block's body element while its children
 * are deferred). See R6 in the model.
 */
export function PaneLoading({
  label = "Loading…",
  className,
}: PaneLoadingProps) {
  return (
    <div
      role="status"
      className={cx(
        "flex flex-1 flex-col items-center justify-center gap-2 p-6 text-caption text-faint",
        className,
      )}
    >
      <Spinner size="lg" />
      <span>{label}</span>
    </div>
  );
}

export type SkeletonProps = HTMLAttributes<HTMLElement> & {
  /**
   * Render a `span` instead of the default `div`, for a skeleton that stands
   * inside phrasing content — a button's label, a meter track, a text row. The
   * caller gives it `block`/`inline-block` where it needs box geometry.
   */
  as?: "div" | "span";
};

/**
 * A layout-stable placeholder block: the caller sizes it with `className` to
 * the height of the content it stands in for, so nothing jumps when the data
 * lands. Decorative — the surrounding region carries the `role="status"`.
 */
export function Skeleton({
  as: Tag = "div",
  className,
  ...rest
}: SkeletonProps) {
  return (
    <Tag
      aria-hidden
      className={cx(
        "rounded-md bg-raised motion-safe:animate-pulse",
        className,
      )}
      {...rest}
    />
  );
}

export interface RefreshIndicatorProps {
  /** Announced; not drawn, so it fits in a header or a corner. */
  label?: string;
  size?: SpinnerSize;
  className?: string;
}

/**
 * The stale-while-refresh marker (R2): a small spinner next to content that
 * STAYS on screen while a fetch for the same query runs.
 */
export function RefreshIndicator({
  label = "Refreshing",
  size = "sm",
  className,
}: RefreshIndicatorProps) {
  return (
    <span
      role="status"
      className={cx("inline-flex items-center text-faint", className)}
    >
      <Spinner size={size} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * `box` is the empty state: a full-width centred card standing where the
 * content would be. `inline` is the same box at a caption's height, for an
 * empty state inside a panel section rather than in place of a pane. `item` is
 * the one that is neither: an empty state that is a ROW in a horizontal
 * scroller (`NewSessionQuickStart`'s worktree row), so it has to carry the
 * snapping and the two-line geometry of the cards it sits beside — the height
 * of a `box` in that row would resize the whole scroller.
 */
type EmptyBoxVariant = "box" | "inline" | "item";

const EMPTY_BOX_CLASS: Record<EmptyBoxVariant, string> = {
  box: `rounded-xl border ${DASHED_EDGE} border-line px-3 py-6 text-center text-caption text-faint`,
  inline: `rounded-xl border ${DASHED_EDGE} border-line px-3 py-2 text-caption text-faint`,
  item: `flex min-w-[9.5rem] shrink-0 snap-start flex-col rounded-xl border ${DASHED_EDGE} border-line px-3 py-2.5 text-caption text-faint`,
};

/** The message wrapper, where the variant needs one of its own. */
const EMPTY_BOX_BODY: Partial<Record<EmptyBoxVariant, string>> = {
  item: "flex w-full min-w-0 flex-col items-start gap-1",
};

export interface EmptyBoxProps {
  /** What is not here, and how to get one — a sentence, not a word. */
  children: ReactNode;
  /** The way out of the empty state, normally a small `Button`. */
  action?: ReactNode;
  variant?: EmptyBoxVariant;
  className?: string;
}

/**
 * The app's one empty state. Render it ONLY when the source has authoritatively
 * answered with nothing (R1); while the answer is outstanding the region is
 * still loading, and "No X yet" would be a lie.
 */
export function EmptyBox({
  children,
  action,
  variant = "box",
  className,
}: EmptyBoxProps) {
  return (
    <div className={cx(EMPTY_BOX_CLASS[variant], className)}>
      <div className={EMPTY_BOX_BODY[variant]}>{children}</div>
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}

export interface ErrorNoteProps {
  message: ReactNode;
  /** Renders the retry affordance; omit it where there is nothing to retry. */
  onRetry?: (() => void) | undefined;
  retryLabel?: string;
  className?: string;
}

/**
 * A failure that has a home on screen. Inline beside (or instead of) the
 * content it belongs to — a toast is for fire-and-forget acts whose surface is
 * already gone. It never replaces retained data: under R2 a refresh that fails
 * keeps the stale content and adds this note above it.
 */
export function ErrorNote({
  message,
  onRetry,
  retryLabel = "Retry",
  className,
}: ErrorNoteProps) {
  return (
    <div
      role="alert"
      className={cx(
        "flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-2 text-caption text-danger",
        className,
      )}
    >
      <span className="min-w-0 flex-1 text-left">{message}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 font-medium underline underline-offset-2 hover:opacity-80"
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
