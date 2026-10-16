import type { ComponentProps, KeyboardEventHandler, ReactNode } from "react";
import { Item } from "../ui/item.tsx";
import { useInertOverflow } from "../../hooks/useInertOverflow.ts";
import { CARD_OUTER_ROW, type RowDensity } from "../../lib/rowDensity.ts";

type ContentProps = {
  density?: RowDensity | undefined;
  /** Optional first line. Omit for a one- or two-line row. */
  context?: ReactNode;
  age?: string | undefined;
  ageTitle?: string | undefined;
  leading?: ReactNode;
  leadingTitle?: string | undefined;
  title?: ReactNode;
  /** A domain-owned identity, such as SessionTitleRow, including its glyph. */
  identity?: ReactNode;
  /** Optional last line. Passing null reserves the line without content. */
  signals?: ReactNode;
  /** Important signals that must not wrap out of sight. */
  pinned?: ReactNode;
  /** Fixed controls at the end of the last line, or title for a one-line row. */
  trailing?: ReactNode;
};

type Props = ContentProps &
  Omit<
    ComponentProps<typeof Item>,
    "title" | "children" | "onClick" | "onKeyDown" | "variant" | "size"
  > & {
    active?: boolean;
    /** Off when a parent separates a row together with its expanded children. */
    divider?: boolean;
    ariaLabel?: string;
    rowProps?: Record<`data-${string}`, string | undefined>;
    onOpen?: (() => void) | undefined;
    onFocusSibling?: ((delta: 1 | -1) => void) | undefined;
    onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
    /** Custom presentation around ListRowContent, for a session's actions flip. */
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
  age,
  ageTitle,
  leading,
  leadingTitle,
  title,
  identity,
  signals,
  pinned,
  trailing,
  ...props
}: Props) {
  return (
    <Item
      variant="list"
      size="list"
      role="button"
      tabIndex={onFocusSibling ? -1 : 0}
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
          age={age}
          ageTitle={ageTitle}
          leading={leading}
          leadingTitle={leadingTitle}
          title={title}
          identity={identity}
          signals={signals}
          pinned={pinned}
          trailing={trailing}
        />
      )}
    </Item>
  );
}

/** The same row geometry inside a domain-owned presentation wrapper. */
export function ListRowContent({
  density = "tight",
  context,
  age,
  ageTitle,
  leading,
  leadingTitle,
  title,
  identity,
  signals,
  pinned,
  trailing,
}: ContentProps) {
  const contextRef = useInertOverflow<HTMLDivElement>();
  const signalsRef = useInertOverflow<HTMLDivElement>({ compact: true });
  const hasContext = context !== undefined || age !== undefined;
  const hasSignals = signals !== undefined || pinned !== undefined;
  const lines = 1 + Number(hasContext) + Number(hasSignals);
  return (
    <div
      data-list-row-lines={lines}
      className={`flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-2 ${
        lines === 1
          ? density === "comfortable"
            ? "min-h-11 py-0"
            : "min-h-7 py-0.5"
          : density === "comfortable"
            ? "py-2.5"
            : "pt-1.5 pb-2.5"
      }`}
    >
      {hasContext ? (
        <div
          className={`flex ${CARD_OUTER_ROW[density].row} min-w-0 items-center gap-2 whitespace-nowrap text-xs text-muted-foreground`}
        >
          <div
            ref={contextRef}
            className="flex h-lh min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-4 overflow-hidden"
          >
            {context}
          </div>
          {age ? (
            <span className="shrink-0 tabular-nums" title={ageTitle}>
              {age}
            </span>
          ) : null}
        </div>
      ) : null}
      <div
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
        {!hasSignals && trailing ? (
          <span className="flex shrink-0 items-center gap-1.5">{trailing}</span>
        ) : null}
      </div>
      {hasSignals ? (
        <div
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
    </div>
  );
}
