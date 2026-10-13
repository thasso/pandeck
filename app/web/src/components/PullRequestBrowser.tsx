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
  IdleWorktree,
  ProjectRecord,
  PullRequestInventoryItem,
} from "@assistant/shared";
import { IdleWorktreesSection } from "./IdleWorktreesSection.tsx";
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
import { Badge } from "./ui/badge.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "./ui/input-group.tsx";
import { Item, ItemContent, ItemDescription, ItemTitle } from "./ui/item.tsx";

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
      <GitMerge size={size} className="shrink-0 text-primary" aria-hidden />
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
    <Item
      size="xs"
      variant={active ? "muted" : "default"}
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
      className={`cursor-pointer select-none ${active ? "" : "hover:bg-muted"} ${density === "comfortable" ? "py-2" : "py-1.5"}`}
    >
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="w-full min-w-0 gap-1.5 font-normal">
          <StateIcon item={item} />
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            #{item.number}
          </span>
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
        </ItemTitle>
        <ItemDescription className="flex min-w-0 items-center gap-1.5 pl-5">
          {project ? (
            <span
              className="flex shrink-0 items-center gap-1"
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
          <span className="min-w-0 flex-1 truncate font-mono">
            {item.headBranch}
          </span>
          {item.draft ? <Badge variant="outline">Draft</Badge> : null}
          {item.worktreeId ? (
            // The one relation a ROW states: this pull request has a checkout on
            // this machine, which is what makes it actionable from here.
            <Badge
              variant="secondary"
              title="A local worktree holds this branch"
            >
              local
            </Badge>
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
        </ItemDescription>
      </ItemContent>
    </Item>
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
  /**
   * The cleanup queue's worktree half (`hooks/useIdleWorktrees.ts`), drawn
   * under the pull-request groups. Absent on a host that does not offer it.
   */
  idle?: IdleWorktreesProps | undefined;
}

/** What the browser needs to draw and act on idle worktrees. */
export interface IdleWorktreesProps {
  state: LoadState<IdleWorktree[]>;
  /** When the server built that answer; "idle N" and the bulk set count from it. */
  fetchedAt: number | undefined;
  onReload: () => void;
  onOpenWorktree: (id: string) => void;
  /** A retirement landed: refetch both halves of the queue. */
  onRetired: () => void;
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
  idle,
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
  // The `?? []` is NOT a fallback anyone renders: this view is computed on
  // every frame, and on exactly the frames where an empty list would be a lie
  // (`items === undefined`) only `InventoryPlaceholder` renders, so `view.empty`
  // is read only by `InventoryRows`, after the inventory answered.
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

  // The idle half of the cleanup queue is its own read: an inventory that has
  // not answered — or failed — must not hide checkouts the idle read found.
  // Before the inventory answers it covers nothing, so nothing is deduplicated.
  const idleSection = idle ? (
    <IdleWorktreesSection
      idle={idle.state}
      fetchedAt={idle.fetchedAt}
      pullRequests={items}
      projects={projectsById}
      query={query}
      density={density}
      onReload={idle.onReload}
      onOpenWorktree={idle.onOpenWorktree}
      onRetired={idle.onRetired}
    />
  ) : null;

  // ONE tree whatever the inventory says, with the idle section in a fixed
  // place after it: an element that moved between two shapes would remount,
  // and the idle section owns a bulk retirement's dialog — including its
  // outcome — for as long as the user has not dismissed it.
  return (
    <div className="flex flex-col gap-px">
      <div className="flex flex-col gap-px">
        {items === undefined ? (
          <InventoryPlaceholder
            error={errorOf(inventory)}
            onReload={onReload}
          />
        ) : (
          <InventoryRows
            inventory={inventory}
            view={view}
            query={query}
            onQuery={setQuery}
            onReload={onReload}
            projectsById={projectsById}
            selected={selected}
            density={density}
            onOpen={onOpen}
            onFocusSibling={handleFocusSibling}
          />
        )}
      </div>
      {idleSection}
    </div>
  );
}

/**
 * The inventory before it answered (R1/R4): reserved rows rather than a claim
 * that there is nothing here, or the failure. Only `items === undefined` draws
 * this — once an answer landed, even a failed refresh keeps rendering it.
 */
function InventoryPlaceholder({
  error,
  onReload,
}: {
  error: string | undefined;
  onReload: () => void;
}) {
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

/** The answered inventory: the search box, its state, and the three groups. */
function InventoryRows({
  inventory,
  view,
  query,
  onQuery,
  onReload,
  projectsById,
  selected,
  density,
  onOpen,
  onFocusSibling,
}: {
  inventory: LoadState<PullRequestInventoryItem[]>;
  view: ReturnType<typeof buildPullRequestInbox>;
  query: string;
  onQuery: (query: string) => void;
  onReload: () => void;
  projectsById: ReadonlyMap<string, RowProject>;
  selected: PullRequestTarget | null | undefined;
  density: RowDensity;
  onOpen: (target: PullRequestTarget) => void;
  onFocusSibling: (delta: 1 | -1) => void;
}) {
  const needle = query.trim();
  const error = errorOf(inventory);
  return (
    <>
      <div className="mb-1 flex items-center gap-1 px-0.5">
        <InputGroup className="flex-1">
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Search pull requests…"
            aria-label="Search pull requests"
          />
        </InputGroup>
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
            className={`px-2 pb-0.5 text-xs font-medium ${
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
              onFocusSibling={onFocusSibling}
            />
          ))}
        </section>
      ))}
    </>
  );
}
