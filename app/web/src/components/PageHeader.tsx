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
import { IconButton } from "./common/IconButton.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
  workshop: "bg-warning-soft text-warning",
  developer: "bg-success-soft text-success",
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
    <IconButton
      label={`Back to ${label}`}
      size="icon-lg"
      onClick={onClick}
      className="-ml-1"
    >
      <ArrowLeft />
    </IconButton>
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
    : "border-b border-border bg-background sm:bg-background/80 sm:backdrop-blur";
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
            <IconButton
              label={iconLabel ?? ""}
              size="icon"
              onClick={onIconClick}
              className={ICON_TONE_CLASS[iconTone]}
            >
              {icon}
            </IconButton>
          ) : (
            <div className={iconBoxClass}>{icon}</div>
          )
        ) : null)}
      <div className="min-w-0 flex-1">
        {typeof title === "string" ? (
          <h2 className="truncate text-sm font-semibold tracking-tight text-foreground">
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
        // The title sits on a wrapper: a disabled button takes no pointer
        // events, and its tooltip is the one place the gesture is named.
        <span title={canComment ? "Add comment" : "Select text to comment"}>
          <Button
            variant="ghost"
            size="icon"
            data-comment-actuation
            onPointerDown={(event) => event.preventDefault()}
            onClick={actuation?.onComment}
            disabled={!canComment}
            aria-label="Add comment"
          >
            <MessageSquareQuote />
          </Button>
        </span>
      ) : null}
      {submit ? (
        <IconButton
          label={`${actuation?.submitLabel ?? "Submit review"} (${pendingCount} pending)`}
          size="icon"
          data-comment-actuation
          onPointerDown={(event) => event.preventDefault()}
          onClick={submit}
          className="relative"
        >
          <SendHorizontal />
          <Badge className="absolute -right-1 -top-1">{pendingCount}</Badge>
        </IconButton>
      ) : primary ? (
        <IconButton label={primary.label} size="icon" onClick={primary.onRun}>
          {primary.icon}
        </IconButton>
      ) : null}
      {showOverflow && secondary.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                title="Inspector actions"
                aria-label="Inspector actions"
              />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {secondary.map((action) => (
              <DropdownMenuItem
                key={action.key}
                disabled={action.busy || action.disabled}
                title={action.disabledReason}
                onClick={action.onRun}
              >
                {action.icon}
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                {action.hint ? (
                  <DropdownMenuShortcut>{action.hint}</DropdownMenuShortcut>
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
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
