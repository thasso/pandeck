import type { ReactNode } from "react";
import { useInertOverflow } from "../hooks/useInertOverflow.ts";
import { CARD_OUTER_ROW, type RowDensity } from "../lib/rowDensity.ts";

/**
 * @component ListCardRow
 * @purpose The attention inbox's three-row card for an edge-to-edge sidebar
 * list (the Pull Requests rail): context with the age closing the line,
 * identity with a glyph in the leading slot, then signals.
 * @useWhen A row in a list whose rows are divided by hairlines and grouped by
 * `ListGroupSection` — a pull request, an idle worktree beside them.
 * @intent One frame so every row in one list reads the same: the slots are
 * the caller's, the geometry is not. The context and signal lines are one line
 * tall and wrap onto a hidden second line, so an item shows whole or not at
 * all and DOM order is the drop order; only an item the caller makes
 * `flex-1 basis-0` (a branch) shortens. Before the signal line drops anything
 * it compacts, as the session cards do: a signal marked
 * `session-status-responsive-badge` with its words in
 * `session-status-badge-label` keeps only its icon (`index.css`). It owns the row's open and keyboard
 * behaviour and nothing else — it closes over no list.
 */
export function ListCardRow({
  rowProps,
  ariaLabel,
  active = false,
  density,
  onOpen,
  onFocusSibling,
  context,
  age,
  ageTitle,
  leading,
  leadingTitle,
  title,
  signals,
  trailing,
}: {
  /** `data-*` attributes the list addresses the row by. */
  rowProps: Record<`data-${string}`, string | undefined>;
  ariaLabel: string;
  active?: boolean;
  density: RowDensity;
  onOpen: () => void;
  onFocusSibling?: ((delta: 1 | -1) => void) | undefined;
  /** Top line: where it lives and whose it is. */
  context: ReactNode;
  /** Closes the top line at the right edge. */
  age?: string | undefined;
  ageTitle?: string | undefined;
  /** The identity line's leading glyph (a state). */
  leading: ReactNode;
  leadingTitle?: string | undefined;
  title: ReactNode;
  /** Bottom line, in drop order. */
  signals: ReactNode;
  /**
   * Closes the bottom line at the right edge, as the age closes the top one;
   * never dropped (a pull request's CI).
   */
  trailing?: ReactNode;
}) {
  const contextRef = useInertOverflow<HTMLDivElement>();
  const signalsRef = useInertOverflow<HTMLDivElement>({ compact: true });
  return (
    <div
      {...rowProps}
      role="button"
      tabIndex={-1}
      aria-label={ariaLabel}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          onFocusSibling?.(event.key === "ArrowDown" ? 1 : -1);
        }
      }}
      className={`flex w-full cursor-pointer select-none overflow-hidden border-b border-border/60 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 ${
        active ? "bg-muted" : "hover:bg-muted"
      }`}
    >
      <div
        className={`flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-2 ${density === "comfortable" ? "py-2.5" : "py-2"}`}
      >
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

        <div className="flex min-w-0 items-center gap-1.5 py-0.5">
          <span
            className="flex size-4 shrink-0 items-center justify-center"
            title={leadingTitle}
          >
            {leading}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {title}
          </span>
        </div>

        <div
          className={`flex ${CARD_OUTER_ROW[density].min} min-w-0 items-center text-xs`}
        >
          <div
            ref={signalsRef}
            className="list-card-signals flex h-5 min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-4 overflow-hidden text-muted-foreground"
          >
            {signals}
          </div>
          {trailing ? (
            <span className="flex shrink-0 items-center pl-2">{trailing}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
