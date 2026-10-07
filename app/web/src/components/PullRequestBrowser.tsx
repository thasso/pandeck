import { memo, useCallback, useMemo, useState } from "react";
import {
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  Search,
} from "lucide-react";
import type {
  ProjectRecord,
  PullRequestInventoryItem,
} from "@assistant/shared";
import {
  EmptyBox,
  ErrorNote,
  RefreshIndicator,
  Skeleton,
} from "./common/load.tsx";
import {
  buildPullRequestInbox,
  pullRequestCiState,
  pullRequestReviewState,
  pullRequestRowId,
  pullRequestStateLabel,
  pullRequestTargetOf,
  isPullRequestTarget,
  type PullRequestCiTone,
  type PullRequestReviewTone,
  type PullRequestTarget,
} from "../lib/pullRequestInbox.ts";
import {
  dataOf,
  errorOf,
  isPending,
  type LoadState,
} from "../lib/loadState.ts";
import { projectColor, projectDisplayKey } from "../lib/projectDisplay.ts";
import type { RowDensity } from "../lib/rowDensity.ts";
import { useShortcuts, type ShortcutGroup } from "./common/shortcuts.tsx";

const PULL_REQUEST_SHORTCUTS: ShortcutGroup = {
  title: "Pull Requests",
  shortcuts: [
    { keys: ["↑", "↓"], label: "Move between pull request rows" },
    { keys: ["enter"], label: "Open the focused pull request" },
  ],
};

/** Resolved once by the browser, never per row. */
interface RowProject {
  key: string;
  name: string;
  color: string;
}

const CI_CLASS: Record<PullRequestCiTone, string> = {
  success: "text-success",
  failure: "text-destructive",
  pending: "text-primary",
  error: "text-destructive",
  none: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

const REVIEW_CLASS: Record<PullRequestReviewTone, string> = {
  "changes-requested": "text-destructive",
  unresolved: "text-warning",
  requested: "text-primary",
  clear: "text-success",
  unknown: "text-muted-foreground",
};

/**
 * The state glyph, which is also the row's leading identity: an open pull
 * request, a draft, a merged one and a closed one are four different things and
 * the list is read by scanning this column.
 */
function StateIcon({ item }: { item: PullRequestInventoryItem }) {
  const size = 13;
  if (item.state === "merged")
    return (
      <GitMerge size={size} className="shrink-0 text-purple-400" aria-hidden />
    );
  if (item.state === "closed")
    return (
      <GitPullRequestClosed
        size={size}
        className="shrink-0 text-destructive"
        aria-hidden
      />
    );
  if (item.draft)
    return (
      <GitPullRequestDraft
        size={size}
        className="shrink-0 text-muted-foreground"
        aria-hidden
      />
    );
  return (
    <GitPullRequest size={size} className="shrink-0 text-success" aria-hidden />
  );
}

/**
 * One row. Memoized and id-taking by the rule in `components/CLAUDE.md`: it
 * closes over nothing from the list and its handler receives the target, so the
 * browser can hand every row the same stable callback.
 */
const PullRequestRow = memo(function PullRequestRow({
  item,
  project,
  active,
  density,
  onOpen,
  onFocusSibling,
}: {
  item: PullRequestInventoryItem;
  project?: RowProject | undefined;
  active: boolean;
  density: RowDensity;
  onOpen: (target: PullRequestTarget) => void;
  onFocusSibling?: ((delta: 1 | -1) => void) | undefined;
}) {
  const ci = pullRequestCiState(item);
  const review = pullRequestReviewState(item);
  const state = pullRequestStateLabel(item);
  const open = () => onOpen(pullRequestTargetOf(item));
  return (
    <div
      data-pull-request-row
      data-list-row-id={pullRequestRowId(item)}
      data-pull-request-row-active={active ? "true" : undefined}
      role="button"
      tabIndex={-1}
      aria-label={`Pull request #${item.number} ${item.title} — ${state.label}, ${ci.label}, ${review.label}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          onFocusSibling?.(event.key === "ArrowDown" ? 1 : -1);
        }
      }}
      className={`group flex min-w-0 cursor-pointer select-none flex-col gap-0.5 rounded-md px-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40 ${
        density === "comfortable" ? "py-2" : "py-1.5"
      } ${active ? "bg-accent/60" : "hover:bg-muted"}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <StateIcon item={item} />
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          #{item.number}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {item.title}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-[1.15rem]">
        {project ? (
          <span
            className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
            title={project.name}
          >
            <span
              className="size-1.5 rounded-full"
              style={{ backgroundColor: project.color }}
              aria-hidden
            />
            {project.key}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {item.headBranch}
        </span>
        {item.draft ? (
          <span className="shrink-0 text-xs font-medium text-muted-foreground">
            Draft
          </span>
        ) : null}
        {item.worktreeId ? (
          // The one relation a ROW states: this pull request has a checkout on
          // this machine, which is what makes it actionable from here.
          <span
            className="shrink-0 text-xs font-medium text-primary"
            title="A local worktree holds this branch"
          >
            local
          </span>
        ) : null}
        <span className={`shrink-0 ${CI_CLASS[ci.tone]}`} title={ci.label}>
          <CircleDot size={11} aria-hidden />
          <span className="sr-only">{ci.label}</span>
        </span>
        <span
          className={`shrink-0 ${REVIEW_CLASS[review.tone]}`}
          title={review.label}
        >
          <MessageSquare size={11} aria-hidden />
          <span className="sr-only">{review.label}</span>
        </span>
      </div>
    </div>
  );
});

interface Props {
  /** The app's ONE inventory projection (`hooks/usePullRequestInventory.ts`). */
  inventory: LoadState<PullRequestInventoryItem[]>;
  /** Retry the inventory read, for the inline failure. */
  onReload: () => void;
  projects: ProjectRecord[];
  /** The pull request open in the main pane, for highlighting. */
  selected?: PullRequestTarget | null | undefined;
  onOpen: (target: PullRequestTarget) => void;
  density: RowDensity;
}

/**
 * @component PullRequestBrowser
 * @purpose The Pull Requests section's object browser: the pull requests that
 * want something from you, grouped into **Needs your review**, **Yours** and
 * **Needs cleanup**, with a search box over all three.
 * @useWhen The sidebar's Pull Requests section is selected.
 * @avoidWhen Listing everything open on a repository — that is the Project
 * page's job; this is an inbox, and a colleague's pull request is not in it.
 * @intent Replaces the Worktrees inbox in this slot. The question moved: a
 * branch on disk was never the unit of work waiting on a human, the pull
 * request is, and the checkout is one of the things it is joined to. Grouping,
 * ordering, search and the status vocabulary are all decided in
 * `lib/pullRequestInbox.ts` — this file resolves project labels once, owns the
 * query box and renders the five load states.
 * @related PullRequestDetailPage, pullRequestInbox (lib),
 * hooks/usePullRequestInventory.ts, Sidebar
 */
export function PullRequestBrowser({
  inventory,
  onReload,
  projects,
  selected,
  density,
  onOpen,
}: Props) {
  useShortcuts(PULL_REQUEST_SHORTCUTS);
  const [query, setQuery] = useState("");

  const projectsById = useMemo(() => {
    const map = new Map<string, RowProject>();
    for (const project of projects)
      map.set(project.id, {
        key: projectDisplayKey(project),
        name: project.name,
        color: projectColor(project).dot,
      });
    return map;
  }, [projects]);
  const projectLabels = useMemo(
    () =>
      Object.fromEntries(
        [...projectsById].map(([id, row]) => [id, `${row.key} ${row.name}`]),
      ),
    [projectsById],
  );

  const items = dataOf(inventory);
  // The `?? []` is NOT a fallback anyone renders: hooks run above the
  // `items === undefined` return below, so this view is computed and thrown
  // away on exactly the frames where an empty list would be a lie. `view.empty`
  // is only ever read after that guard.
  const view = useMemo(
    () => buildPullRequestInbox(items ?? [], { query, projectLabels }),
    [items, query, projectLabels],
  );

  const handleFocusSibling = useCallback((delta: 1 | -1) => {
    const from = document.activeElement as HTMLElement | null;
    if (!from) return;
    const rows = [
      ...document.querySelectorAll<HTMLElement>("[data-pull-request-row]"),
    ];
    const next = rows[rows.indexOf(from) + delta];
    if (next) next.focus({ preventScroll: false });
  }, []);

  // R1/R4: the first load reserves the rows' height rather than claiming there
  // is nothing here. `items === undefined` is the only state that may do so —
  // once an answer landed, even a failed refresh keeps rendering it.
  if (items === undefined) {
    const error = errorOf(inventory);
    if (error)
      return <ErrorNote message={error} onRetry={onReload} className="m-1" />;
    return (
      <div
        role="status"
        aria-label="Loading pull requests"
        className="flex flex-col gap-px"
      >
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-11" />
        ))}
      </div>
    );
  }

  const needle = query.trim();
  const error = errorOf(inventory);
  return (
    <div className="flex flex-col gap-px">
      <div className="relative mb-1 flex items-center gap-1 px-0.5">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pull requests…"
            aria-label="Search pull requests"
            className="w-full rounded-lg border border-border bg-background py-1.5 pl-8 pr-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
          />
        </div>
        {/* R2: a poll keeps the rows and says so here, rather than replacing
            them with the skeletons above. */}
        {isPending(inventory) ? (
          <RefreshIndicator label="Refreshing pull requests" />
        ) : null}
      </div>

      {/* R2 again: a failed refresh keeps the last answer and adds this note. */}
      {error ? (
        <ErrorNote message={error} onRetry={onReload} className="mb-1" />
      ) : null}

      {view.empty ? (
        <EmptyBox>
          {needle
            ? `No pull requests match “${needle}”.`
            : "No pull requests need you right now. Ones you open, ones you are asked to review, and merged ones still checked out locally appear here."}
        </EmptyBox>
      ) : null}

      {view.groups.map((group) => (
        <section
          key={group.id}
          aria-labelledby={`pull-requests-${group.id}`}
          className="mb-1 flex flex-col gap-px"
        >
          <h2
            id={`pull-requests-${group.id}`}
            className={`px-2 pb-0.5 text-xs font-semibold uppercase tracking-wide ${
              group.id === "needs-review"
                ? "text-primary"
                : "text-muted-foreground"
            }`}
          >
            {group.title} ({group.items.length})
          </h2>
          {group.items.map((item) => (
            <PullRequestRow
              key={pullRequestRowId(item)}
              item={item}
              project={projectsById.get(item.projectId)}
              // All FOUR components, or two rows highlight as one.
              active={isPullRequestTarget(item, selected)}
              density={density}
              onOpen={onOpen}
              onFocusSibling={handleFocusSibling}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
