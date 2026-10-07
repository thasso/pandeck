import { useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, CircleDot, Crosshair, Unlink } from "lucide-react";
import {
  dispatchableThreads,
  groupReviewThreads,
  type ReviewThreadView,
} from "./reviewThread.ts";
import { IconButton } from "../common/IconButton.tsx";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Item, ItemContent, ItemDescription, ItemTitle } from "../ui/item.tsx";

/**
 * @component ReviewCommentList
 * @purpose The ONE roster of review comments: two-line rows grouped into the
 *   working set, the unreachable, and the history, with selection and bulk
 *   dispatch.
 * @useWhen Any surface that lists comment threads for triage — a Knowledge
 *   entry's or a worktree diff's panel/sheet section and page section.
 * @avoidWhen Rendering a thread IN the content it annotates; that is the
 *   document's own inline annotation (see `diff/comments.tsx`).
 * @intent A list row's job is to get you to the passage and to let you pick
 *   threads, so it shows the comment's first line and where it sits — not the
 *   quote, which is what jumping is for. Resolved threads stay, collapsed,
 *   because history is why this list exists at all once the work is done.
 *
 *   A row does ONE of two things with a tap, and the host picks which. Where the
 *   list sits WITH the content (a page section), the row EXPANDS (`renderThread`)
 *   so you can read and answer without leaving it. Where the list sits BESIDE the
 *   content (the object panel, a sheet over the document), the row is a LINK
 *   (`onOpen`): it opens the thread on its passage in the main view, because a
 *   second place to read and answer the same comment is one place too many.
 */
export function ReviewCommentList({
  threads,
  renderThread,
  onOpen,
  onSend,
  emptyLabel = "No comments yet.",
}: {
  threads: ReviewThreadView[];
  /** Dispatch the selected threads to an agent. Absent = no selection UI. */
  onSend?: ((threadIds: string[]) => void) | undefined;
  emptyLabel?: string;
} & (
  | {
      /** The domain's full thread rendering, shown for the expanded row. */
      renderThread: (threadId: string) => ReactNode;
      onOpen?: never;
    }
  | {
      /** Open this thread where it lives; the row is a link, not a container. */
      onOpen: (threadId: string) => void;
      renderThread?: never;
    }
)) {
  const groups = useMemo(() => groupReviewThreads(threads), [threads]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const dispatchable = dispatchableThreads(groups);
  // Picking a SUBSET is an editing act, so it belongs where threads are read and
  // answered — the expanding page list. A panel of links offers no editing UI.
  const selectable =
    onSend != null && renderThread != null && dispatchable.length > 0;
  // Selection may only ever hold threads that are still offerable.
  const activeSelection = [...selected].filter((id) =>
    dispatchable.some((thread) => thread.id === id),
  );
  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (threads.length === 0)
    return <p className="px-1 text-sm text-muted-foreground">{emptyLabel}</p>;

  const group = (
    label: string,
    rows: ReviewThreadView[],
    icon: ReactNode,
    extra?: ReactNode,
  ) => {
    if (rows.length === 0) return null;
    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-1.5 px-1 py-1 text-xs font-medium text-muted-foreground">
          <span className="flex size-4 items-center justify-center">
            {icon}
          </span>
          {label}
          <span className="text-muted-foreground/80">{rows.length}</span>
          {extra ? (
            <span className="ml-auto flex items-center gap-1">{extra}</span>
          ) : null}
        </div>
        {rows.map((thread) => (
          <Row
            key={thread.id}
            thread={thread}
            expanded={expanded === thread.id}
            onActivate={
              onOpen
                ? () => onOpen(thread.id)
                : () =>
                    setExpanded((current) =>
                      current === thread.id ? null : thread.id,
                    )
            }
            selected={selected.has(thread.id)}
            onToggleSelected={
              selectable && thread.state === "open"
                ? () => toggle(thread.id)
                : undefined
            }
            renderThread={renderThread}
          />
        ))}
      </div>
    );
  };

  // Just "All" here: the host's CommentBar submits the pending set, and a second
  // control for the same set was noise.
  const quickSelect = selectable ? (
    <Button
      variant="ghost"
      size="xs"
      onClick={() =>
        setSelected(new Set(dispatchable.map((thread) => thread.id)))
      }
    >
      All
    </Button>
  ) : undefined;

  return (
    <div className="flex flex-col gap-1">
      {group(
        "Open",
        groups.open,
        <CircleDot size={12} className="text-primary" />,
        quickSelect,
      )}
      {group(
        "Unanchored",
        groups.orphaned,
        <Unlink size={12} className="text-warning" />,
      )}
      {group(
        "Resolved",
        groups.resolved,
        <CheckCircle2 size={12} className="text-success" />,
      )}
      {onSend && activeSelection.length > 0 ? (
        <div className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-card/95 px-1 py-1.5 backdrop-blur">
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {activeSelection.length} selected
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onSend(activeSelection);
              setSelected(new Set());
            }}
          >
            Send to agent…
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Row({
  thread,
  expanded,
  onActivate,
  selected,
  onToggleSelected,
  renderThread,
}: {
  thread: ReviewThreadView;
  expanded: boolean;
  /** Expand the row in place, or follow it — see the component's `onOpen`. */
  onActivate: () => void;
  selected: boolean;
  onToggleSelected?: (() => void) | undefined;
  /** Absent in link mode, where the thread opens in the content instead. */
  renderThread?: ((threadId: string) => ReactNode) | undefined;
}) {
  const link = renderThread == null;
  return (
    <div>
      <div className="group flex items-start gap-1.5">
        {onToggleSelected ? (
          <Checkbox
            checked={selected}
            onCheckedChange={onToggleSelected}
            aria-label={`Select comment: ${thread.firstLine}`}
            className="mt-2.5 ml-1"
          />
        ) : null}
        <Item
          size="xs"
          variant={expanded ? "muted" : "default"}
          render={<button type="button" />}
          onClick={onActivate}
          aria-expanded={link ? undefined : expanded}
          className="min-w-0 flex-1 flex-nowrap text-left hover:bg-muted"
        >
          <ItemContent className="min-w-0">
            <ItemTitle
              className={`w-full font-normal ${thread.state === "resolved" ? "text-muted-foreground" : ""}`}
            >
              <span className="truncate">
                {thread.firstLine || "(empty comment)"}
              </span>
            </ItemTitle>
            <ItemDescription className="truncate">
              {[
                thread.anchorLabel,
                thread.author,
                thread.replies
                  ? `${thread.replies} ${thread.replies === 1 ? "reply" : "replies"}`
                  : null,
                thread.moved ? "moved" : null,
                thread.sent ? "sent" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </ItemDescription>
          </ItemContent>
        </Item>
        {/* In link mode the whole row is already the jump, so it carries no
            separate control for it. */}
        {!link && thread.locate ? (
          <IconButton
            label="Jump to text"
            size="icon-xs"
            onClick={thread.locate}
            className="mt-1 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Crosshair />
          </IconButton>
        ) : null}
      </div>
      {renderThread && expanded ? (
        <div className="pb-1 pl-1 pr-1">{renderThread(thread.id)}</div>
      ) : null}
    </div>
  );
}
