import type { ReactNode } from "react";
import {
  ArrowLeft,
  ClipboardList,
  MessageSquare,
  MessageSquareQuote,
  MoreHorizontal,
  SendHorizontal,
  Terminal,
  Wrench,
} from "lucide-react";
import type { AgentType, Harness } from "@assistant/shared";
import { useCommentActuation } from "./review/CommentActuation.tsx";
import {
  primarySlotShowsReview,
  useRoutePrimaryAction,
  useRouteSecondaryActions,
} from "./shell/RoutePrimaryAction.tsx";
import { Popover } from "./Popover.tsx";

/**
 * @component PageHeader
 * @purpose Shared below-topbar header for sub-section / detail surfaces: chat session header, session drawers, Task detail, Project detail, Settings.
 * @useWhen A content surface below the global Header Bar needs a titled header row with a leading icon (or custom control), a title/subtitle block, and trailing actions.
 * @avoidWhen Rendering the global app Header Bar (use AppHeaderBar/Topbar) or the sidebar's navigation zone (use shell/PrimaryNav); those own distinct shells.
 * @intent One coherent taller (min-h-16) below-topbar header treatment shared across detail/sub-section pages (the shell Inspector header matches it). Owns the optional mobile back control, the icon-in-box leading slot, title/subtitle block, and trailing actions row; on wide layouts its shared `…` menu receives secondary actions from the Inspector. Transparent mode reserves the row over an already-visible matching header during overlays/animations.
 * @related AppHeaderBar, SessionContextSections, shell/Inspector.
 */
export type PageHeaderIconTone = "accent" | "workshop" | "developer";

const ICON_TONE_CLASS: Record<PageHeaderIconTone, string> = {
  accent: "bg-accent text-primary",
  workshop: "bg-amber-400/10 text-amber-500",
  developer: "bg-emerald-400/10 text-emerald-500",
};

/**
 * Back affordance of a mobile object screen: it returns to the section's browser
 * screen (its index route), never to `history.back()` — see
 * app/web/docs/ui-shell.md, Small Screens. `label` is the section it returns to.
 */
export interface PageHeaderBack {
  label: string;
  onClick: () => void;
}

/**
 * Back takes the leading position: it REPLACES the decorative icon box (the
 * screen's identity is its title, and 32px of glyph is worth more as title width
 * on a phone) but yields to a functional `leading` control such as the Task
 * detail's status toggle, which it then precedes.
 */
export function PageHeaderBackButton({ label, onClick }: PageHeaderBack) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Back to ${label}`}
      aria-label={`Back to ${label}`}
      className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-panel hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <ArrowLeft size={18} />
    </button>
  );
}

interface PageHeaderProps {
  /** Standard colored icon box content. Ignored when `leading` is provided. */
  icon?: ReactNode;
  iconTone?: PageHeaderIconTone;
  /**
   * Makes the icon box a button. For the one control that belongs ON the identity
   * rather than beside it — copying the session id, which is what identifies this
   * session to a human. A phone header has no second row to spend on it.
   */
  onIconClick?: (() => void) | undefined;
  /** Accessible name/tooltip for a clickable icon box. */
  iconLabel?: string | undefined;
  /**
   * `compact` is one shorter identity row: no subtitle (it is IGNORED, not
   * stacked), tighter padding, ~44px instead of 64px. Use it where metadata has
   * a richer home elsewhere, on either viewport — see `app/web/docs/ui-shell.md`.
   */
  density?: "default" | "compact";
  /** Custom leading slot replacing the icon box (status toggle, back arrow, …). */
  leading?: ReactNode;
  /** Mobile screen back control; replaces `icon`, precedes a custom `leading`. */
  back?: PageHeaderBack | undefined;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Trailing action controls (archive/delete/review, …). */
  actions?: ReactNode;
  /**
   * The control that dismisses the surface. It is drawn LAST, after the object's
   * own comment and primary controls, so Close is always the header's final
   * control (the phone's dock row ends the same way).
   */
  close?: ReactNode;
  /** Chat supplies its own combined `…` menu; other pages use the shared one. */
  objectOverflow?: boolean;
  safeAreaTop?: boolean;
  transparent?: boolean;
  ariaHidden?: boolean;
}

export function PageHeader({
  icon,
  iconTone = "accent",
  onIconClick,
  iconLabel,
  density = "default",
  leading,
  back,
  title,
  subtitle,
  actions,
  close,
  objectOverflow = true,
  safeAreaTop = false,
  transparent = false,
  ariaHidden = false,
}: PageHeaderProps) {
  const compact = density === "compact";
  const verticalPadding = compact ? "pb-1.5" : "pb-3";
  const topPadding = safeAreaTop
    ? `pt-[calc(${compact ? "0.375rem" : "0.75rem"}_+_var(--app-safe-area-top))]`
    : compact
      ? "pt-1.5"
      : "pt-3";
  const chromeClass = transparent
    ? "pointer-events-none border-b border-transparent bg-transparent sm:bg-transparent sm:backdrop-blur-none"
    : "border-b border-line bg-surface sm:bg-surface/80 sm:backdrop-blur";
  const iconBoxClass = `flex size-8 shrink-0 items-center justify-center rounded-lg ${ICON_TONE_CLASS[iconTone]}`;
  return (
    <header
      aria-hidden={ariaHidden || transparent || undefined}
      className={`flex items-center px-3 ${compact ? "min-h-11 gap-2 sm:h-11" : "min-h-16 gap-3 sm:h-16"} ${verticalPadding} ${topPadding} sm:py-0 ${chromeClass}`}
    >
      {back ? <PageHeaderBackButton {...back} /> : null}
      {leading ??
        (icon && !back ? (
          onIconClick ? (
            <button
              type="button"
              onClick={onIconClick}
              title={iconLabel}
              aria-label={iconLabel}
              className={`${iconBoxClass} transition-transform active:scale-95`}
            >
              {icon}
            </button>
          ) : (
            <div className={iconBoxClass}>{icon}</div>
          )
        ) : null)}
      <div className="min-w-0 flex-1">
        {typeof title === "string" ? (
          <h2 className="truncate text-sm font-semibold tracking-tight text-fg">
            {title}
          </h2>
        ) : (
          title
        )}
        {/* A compact header is ONE row: a subtitle there would defeat the point, so
            it is dropped rather than squeezed. */}
        {subtitle != null && !compact ? (
          typeof subtitle === "string" ? (
            <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
          ) : (
            subtitle
          )
        ) : null}
      </div>
      {actions}
      <PageHeaderObjectActions showOverflow={objectOverflow} />
      {close}
    </header>
  );
}

const HEADER_ACTION_CLASS =
  "relative flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-panel hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-30";

/**
 * What this page's OBJECT offers, in the wide header: Add comment where the
 * surface takes comments, then the primary slot.
 *
 * Only when the header is wide — a phone folds all of it into the object dock's
 * action row, which draws the same pair in the same order (ui-shell.md, Small
 * Screens). The primary slot swaps to Submit review while comments are waiting;
 * the object panel lists the primary again whenever this is not showing it.
 */
function PageHeaderObjectActions({ showOverflow }: { showOverflow: boolean }) {
  const actuation = useCommentActuation();
  const primary = useRoutePrimaryAction();
  const secondary = useRouteSecondaryActions();
  const pendingCount = Math.max(0, actuation?.pendingCount ?? 0);
  const showComment = Boolean(actuation?.onComment);
  const submit =
    actuation?.onSubmitReview && primarySlotShowsReview(pendingCount)
      ? actuation.onSubmitReview
      : undefined;
  if (
    !showComment &&
    !submit &&
    !primary &&
    (!showOverflow || secondary.length === 0)
  )
    return null;

  const canComment = actuation?.canComment === true;
  return (
    <div className="hidden shrink-0 items-center gap-1 md:flex">
      {showComment ? (
        <span title={canComment ? "Add comment" : "Select text to comment"}>
          <button
            type="button"
            data-comment-actuation
            onPointerDown={(event) => event.preventDefault()}
            onClick={actuation?.onComment}
            disabled={!canComment}
            aria-label="Add comment"
            className={HEADER_ACTION_CLASS}
          >
            <MessageSquareQuote size={16} />
          </button>
        </span>
      ) : null}
      {submit ? (
        <button
          type="button"
          data-comment-actuation
          onPointerDown={(event) => event.preventDefault()}
          onClick={submit}
          title={actuation?.submitLabel ?? "Submit review"}
          aria-label={`${actuation?.submitLabel ?? "Submit review"} (${pendingCount} pending)`}
          className={HEADER_ACTION_CLASS}
        >
          <SendHorizontal size={16} />
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-xs font-semibold text-primary-foreground">
            {pendingCount}
          </span>
        </button>
      ) : primary ? (
        <button
          type="button"
          onClick={primary.onRun}
          title={primary.label}
          aria-label={primary.label}
          className={HEADER_ACTION_CLASS}
        >
          {primary.icon}
        </button>
      ) : null}
      {showOverflow && secondary.length > 0 ? (
        <Popover
          align="right"
          placement="bottom"
          title="Inspector actions"
          className={HEADER_ACTION_CLASS}
          button={<MoreHorizontal size={16} />}
        >
          {(close) => (
            <div className="py-0.5 text-sm" role="menu">
              {secondary.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  role="menuitem"
                  disabled={action.busy || action.disabled}
                  title={action.disabledReason}
                  onClick={() => {
                    close();
                    action.onRun();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-muted-foreground transition-colors hover:bg-raised hover:text-fg disabled:pointer-events-none disabled:opacity-40"
                >
                  {action.icon ? (
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {action.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">
                    {action.label}
                  </span>
                  {action.hint ? (
                    <span className="shrink-0 text-sm text-faint">
                      {action.hint}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </Popover>
      ) : null}
    </div>
  );
}

/**
 * Icon + tone for the chat/session header, keyed on the session's PERSONA
 * (agentType), independent of harness: the Workshop persona gets the Wrench +
 * workshop tone, the Assistant persona the plain bubble + accent tone. A
 * Claude-SDK assistant is an assistant, so it reads as one (the harness/provider
 * is surfaced separately by the model indicator, not the persona glyph).
 */
export function sessionHeaderIcon(
  variant: "session" | "context",
  identity: { harness?: Harness; agentType?: AgentType } | undefined,
): { icon: ReactNode; iconTone: PageHeaderIconTone } {
  if (variant === "context")
    return { icon: <ClipboardList size={16} />, iconTone: "accent" };
  if (identity?.agentType === "workshop")
    return { icon: <Wrench size={16} />, iconTone: "workshop" };
  if (identity?.agentType === "developer")
    return { icon: <Terminal size={16} />, iconTone: "developer" };
  return { icon: <MessageSquare size={16} />, iconTone: "accent" };
}
