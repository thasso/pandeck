import type { ComponentProps, KeyboardEventHandler, ReactNode } from "react";
import { Item } from "../ui/item.tsx";
import { useInertOverflow } from "../../hooks/useInertOverflow.ts";
import { CARD_OUTER_ROW, type RowDensity } from "../../lib/rowDensity.ts";

type ContentProps = {
  density?: RowDensity | undefined;
  /** Optional first line. Omit for a one- or two-line row. */
  context?: ReactNode;
  /** Fixed right-hand context, such as a durable object id. */
  contextTrailing?: ReactNode;
  age?: string | undefined;
  ageTitle?: string | undefined;
  leading?: ReactNode;
  leadingTitle?: string | undefined;
  title?: ReactNode;
  /** A domain-owned identity, such as SessionTitleRow, including its glyph. */
  identity?: ReactNode;
  /** Supporting line below the title, such as Task metadata. */
  details?: ReactNode;
  /** Optional last line. Passing null reserves the line without content. */
  signals?: ReactNode;
  /** Important signals that must not wrap out of sight. */
  pinned?: ReactNode;
  /** Fixed controls at the end of the last line, or title for a one-line row. */
  trailing?: ReactNode;
  /** Right-aligned actions; two-line items keep their context line full-width. */
  actions?: ReactNode;
  /** Include context in the action column instead of only the final content lines. */
  actionSpan?: "content" | "all" | undefined;
};

type Props = ContentProps &
  Omit<
    ComponentProps<typeof Item>,
    "title" | "children" | "onClick" | "onKeyDown" | "variant" | "size"
  > & {
    active?: boolean;
    /** Content owns real links and controls; the frame is not an ARIA button. */
    interaction?: "row" | "content";
    /** Off when a parent separates a row together with its expanded children. */
    divider?: boolean;
    ariaLabel?: string;
    rowProps?: Record<`data-${string}`, string | undefined>;
    onOpen?: (() => void) | undefined;
    onFocusSibling?: ((delta: 1 | -1) => void) | undefined;
    onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
    /** Custom domain presentation around ListRowContent. */
    children?: ReactNode;
  };

/**
 * @component ListRow
 * @purpose Edge-to-edge browser rows with one identity line and optional
 * context and signal lines. Owns geometry, selection, focus and activation;
 * callers own domain content, shortcuts, disclosure, swipe and drag behavior.
 * @useWhen Settings, session history, Attention, Pull Requests or idle worktrees.
 */
export function ListRow({
  active = false,
  interaction = "row",
  divider = true,
  ariaLabel,
  rowProps,
  onOpen,
  onFocusSibling,
  onKeyDown,
  children,
  className,
  density,
  context,
  contextTrailing,
  age,
  ageTitle,
  leading,
  leadingTitle,
  title,
  identity,
  details,
  signals,
  pinned,
  trailing,
  actions,
  actionSpan,
  ...props
}: Props) {
  return (
    <Item
      variant="list"
      size="list"
      role={interaction === "row" ? "button" : undefined}
      tabIndex={interaction === "row" ? (onFocusSibling ? -1 : 0) : undefined}
      {...props}
      {...rowProps}
      aria-label={ariaLabel ?? props["aria-label"]}
      data-active={active || undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if ((event.key === "Enter" || event.key === " ") && onOpen) {
          event.preventDefault();
          onOpen();
        } else if (
          onFocusSibling &&
          (event.key === "ArrowDown" || event.key === "ArrowUp")
        ) {
          event.preventDefault();
          onFocusSibling(event.key === "ArrowDown" ? 1 : -1);
        }
      }}
      className={`${divider ? "border-b border-border/60" : ""} ${className ?? ""}`}
    >
      {children ?? (
        <ListRowContent
          density={density}
          context={context}
          contextTrailing={contextTrailing}
          age={age}
          ageTitle={ageTitle}
          leading={leading}
          leadingTitle={leadingTitle}
          title={title}
          identity={identity}
          details={details}
          signals={signals}
          pinned={pinned}
          trailing={trailing}
          actions={actions}
          actionSpan={actionSpan}
        />
      )}
    </Item>
  );
}

/** The same row geometry inside a domain-owned presentation wrapper. */
export function ListRowContent({
  density = "tight",
  context,
  contextTrailing,
  age,
  ageTitle,
  leading,
  leadingTitle,
  title,
  identity,
  details,
  signals,
  pinned,
  trailing,
  actions,
  actionSpan = "content",
}: ContentProps) {
  const contextRef = useInertOverflow<HTMLDivElement>();
  const signalsRef = useInertOverflow<HTMLDivElement>({ compact: true });
  const detailsRef = useInertOverflow<HTMLDivElement>();
  const hasContext =
    context !== undefined || contextTrailing !== undefined || age !== undefined;
  const hasSignals = signals !== undefined || pinned !== undefined;
  const hasDetails = details !== undefined;
  const lines =
    1 + Number(hasContext) + Number(hasDetails) + Number(hasSignals);
  const actionStart =
    actionSpan === "all" ? 1 : Math.max(hasContext ? 2 : 1, lines - 1);
  const lineStyle = (line: number) => ({
    gridRow: line,
    gridColumn: actions && line >= actionStart ? "1" : "1 / -1",
  });
  return (
    <div
      data-list-row-lines={lines}
      className={`grid min-w-0 flex-1 content-center gap-x-1.5 gap-y-0 px-2 ${actions ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)]"} ${
        lines === 1
          ? density === "comfortable"
            ? "min-h-11 py-0"
            : "min-h-7 py-0.5"
          : density === "comfortable"
            ? "py-1"
            : "py-0.5"
      }`}
    >
      {hasContext ? (
        <div
          style={lineStyle(1)}
          className={`flex ${CARD_OUTER_ROW[density].row} min-w-0 items-center gap-2 whitespace-nowrap text-xs text-muted-foreground`}
        >
          <div
            ref={contextRef}
            className="flex h-5 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-4 overflow-hidden"
          >
            {context}
          </div>
          {contextTrailing !== undefined ? (
            <span className="flex shrink-0 items-center">
              {contextTrailing}
            </span>
          ) : age ? (
            <span className="shrink-0 tabular-nums" title={ageTitle}>
              {age}
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        style={lineStyle(1 + Number(hasContext))}
        className={`flex min-w-0 items-center gap-1.5 ${lines > 1 ? "py-1" : ""}`}
      >
        {identity ?? (
          <>
            {leading ? (
              <span
                className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4"
                title={leadingTitle}
              >
                {leading}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {title}
            </span>
          </>
        )}
        {!hasSignals && !hasDetails && trailing ? (
          <span className="flex shrink-0 items-center gap-1.5">{trailing}</span>
        ) : null}
      </div>
      {hasDetails ? (
        <div
          style={lineStyle(2 + Number(hasContext))}
          className={`flex ${CARD_OUTER_ROW[density].row} min-w-0 items-center gap-1.5 text-xs text-muted-foreground`}
        >
          <div
            ref={detailsRef}
            className="flex h-5 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-4 overflow-hidden whitespace-nowrap"
          >
            {details}
          </div>
          {!hasSignals && trailing ? (
            <span className="flex shrink-0 items-center gap-1.5">
              {trailing}
            </span>
          ) : null}
        </div>
      ) : null}
      {hasSignals ? (
        <div
          style={lineStyle(lines)}
          className={`flex ${CARD_OUTER_ROW[density].min} min-w-0 items-center gap-1.5 text-xs`}
        >
          <div className="session-card-status-line flex h-5 min-w-0 flex-1 items-center gap-x-1.5 text-muted-foreground">
            <div
              ref={signalsRef}
              className="list-card-signals flex h-5 min-w-0 flex-1 basis-0 flex-wrap items-center gap-x-2.5 gap-y-4 overflow-hidden"
            >
              {signals}
            </div>
            {pinned ? (
              <div className="flex min-w-0 items-center gap-x-1.5">
                {pinned}
              </div>
            ) : null}
          </div>
          {trailing ? (
            <span className="flex shrink-0 items-center gap-1.5">
              {trailing}
            </span>
          ) : null}
        </div>
      ) : null}
      {actions ? (
        <div
          className="flex shrink-0 items-stretch justify-end self-stretch"
          style={{ gridColumn: 2, gridRow: `${actionStart} / ${lines + 1}` }}
          onClick={(event) => event.stopPropagation()}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
