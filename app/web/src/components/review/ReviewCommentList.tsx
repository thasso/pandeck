import { useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, CircleDot, Crosshair, Unlink } from "lucide-react";
import {
  dispatchableThreads,
  groupReviewThreads,
  type ReviewThreadView,
} from "./reviewThread.ts";

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
    return <p className="px-1 text-caption text-faint">{emptyLabel}</p>;

  const group = (
    label: string,
    rows: ReviewThreadView[],
    icon: ReactNode,
    extra?: ReactNode,
  ) => {
    if (rows.length === 0) return null;
    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-1.5 px-1 py-1 text-micro font-medium uppercase tracking-wide text-faint">
          <span className="flex size-4 items-center justify-center">
            {icon}
          </span>
          {label}
          <span className="text-faint/80">{rows.length}</span>
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
    <QuickSelect
      label="All"
      onClick={() =>
        setSelected(new Set(dispatchable.map((thread) => thread.id)))
      }
    />
  ) : undefined;

  return (
    <div className="flex flex-col gap-1">
      {group(
        "Open",
        groups.open,
        <CircleDot size={12} className="text-accent" />,
        quickSelect,
      )}
      {group(
        "Unanchored",
        groups.orphaned,
        <Unlink size={12} className="text-amber-500" />,
      )}
      {group(
        "Resolved",
        groups.resolved,
        <CheckCircle2 size={12} className="text-emerald-500" />,
      )}
      {onSend && activeSelection.length > 0 ? (
        <div className="sticky bottom-0 flex items-center gap-2 border-t border-line bg-panel/95 px-1 py-1.5 backdrop-blur">
          <span className="min-w-0 flex-1 truncate text-caption text-muted">
            {activeSelection.length} selected
          </span>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="rounded-md px-2 py-1 text-caption text-muted transition-colors hover:bg-raised hover:text-fg"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => {
              onSend(activeSelection);
              setSelected(new Set());
            }}
            className="rounded-lg bg-accent px-2.5 py-1 text-caption font-medium text-accent-fg transition-colors hover:bg-accent/90"
          >
            Send to agent…
          </button>
        </div>
      ) : null}
    </div>
  );
}

function QuickSelect({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded px-1.5 py-0.5 text-micro font-medium normal-case tracking-normal text-accent transition-colors hover:bg-accent-soft"
    >
      {label}
    </button>
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
      <div
        className={`group flex items-start gap-1.5 rounded-lg px-1 py-1 transition-colors ${expanded ? "bg-raised" : "hover:bg-raised"}`}
      >
        {onToggleSelected ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            aria-label={`Select comment: ${thread.firstLine}`}
            className="mt-1 size-3.5 shrink-0 accent-[var(--accent)]"
          />
        ) : null}
        <button
          type="button"
          onClick={onActivate}
          className="min-w-0 flex-1 text-left"
          aria-expanded={link ? undefined : expanded}
        >
          <span
            className={`block truncate text-caption ${thread.state === "resolved" ? "text-muted" : "text-fg"}`}
          >
            {thread.firstLine || "(empty comment)"}
          </span>
          <span className="block truncate text-micro text-faint">
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
          </span>
        </button>
        {/* In link mode the whole row is already the jump, so it carries no
            separate control for it. */}
        {!link && thread.locate ? (
          <button
            type="button"
            onClick={thread.locate}
            title="Jump to text"
            aria-label="Jump to text"
            className="mt-0.5 shrink-0 rounded-md p-1 text-faint opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Crosshair size={12} />
          </button>
        ) : null}
      </div>
      {renderThread && expanded ? (
        <div className="pb-1 pl-1 pr-1">{renderThread(thread.id)}</div>
      ) : null}
    </div>
  );
}
