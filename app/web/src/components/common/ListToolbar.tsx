import type { ReactNode } from "react";
import {
  OverflowActionItems,
  OverflowMenu,
  type OverflowAction,
} from "./OverflowMenu.tsx";

/**
 * @component ListToolbar
 * @purpose The one header bar above a sidebar browser's scroll container
 * (Sessions, Tasks, Pull Requests): the list's own controls on the left, its
 * filter and its actions on the right.
 * @useWhen A browser section needs a bar of controls about the LIST it heads —
 * a view or grouping switch, counts, a refresh indicator, filters, and actions
 * on the whole list such as Refresh.
 * @avoidWhen Actions about one object (those belong to its page header, whose
 * `⋯` the inspector fills) or anything app-wide (the app header and the
 * sidebar's navigation bar own those).
 * @intent Three bars had grown three copies of the same row, and a list action
 * had nowhere to go. The slots fix the order so every browser reads alike:
 * `children` lead, `filter` is pushed to the right edge, and the `actions`
 * menu is the LAST control, as every `OverflowMenu` is. `actions` is data, not
 * nodes, so each section names only what it offers and the menu draws busy,
 * disabled and hints the same way the page header's does; no actions renders
 * no `⋯`. The bar is a constant `h-11` — the compact `PageHeader`'s height, so
 * its border lines up with the chat title bar's — and it is drawn ABOVE the
 * scroll container (`Sidebar.tsx`), never as a sticky row inside it, so the
 * list cannot push it around and the scrollbar never runs through it.
 * @related ListFilterPopover, OverflowMenu, PageHeader, Sidebar.
 */
export function ListToolbar({
  inset = "control",
  filter,
  actions,
  actionsLabel = "More list actions",
  children,
}: {
  /**
   * `control` when the bar starts with a ghost button, whose own padding
   * already insets its content; `chip` when it starts with badges, which need
   * the bar to inset them.
   */
  inset?: "control" | "chip";
  /** The browser's filter control, normally `ListFilterPopover`. */
  filter?: ReactNode;
  /** Actions on the whole list. Empty or absent renders no `⋯`. */
  actions?: readonly OverflowAction[] | undefined;
  /** Names what the menu holds: "More pull request actions". */
  actionsLabel?: string;
  /** The leading controls: a view or grouping switch, counts, indicators. */
  children?: ReactNode;
}) {
  const hasActions = actions !== undefined && actions.length > 0;
  return (
    <div
      className={`flex h-11 items-center gap-1 border-b border-border bg-card ${
        inset === "chip" ? "px-2 sm:px-3" : "px-1.5 sm:px-2"
      }`}
    >
      {children}
      {filter || hasActions ? (
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {filter}
          {hasActions ? (
            <OverflowMenu label={actionsLabel} contentClassName="min-w-48">
              <OverflowActionItems actions={actions} />
            </OverflowMenu>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
