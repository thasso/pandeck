import { memo, useCallback, useMemo, type ReactNode } from "react";
import {
  ChevronDown,
  Eye,
  UserCheck,
  Users,
  Layers,
  CalendarDays,
  ListFilter,
  SlidersHorizontal,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  FolderKanban,
  GitBranch,
  GitMerge,
  HardDrive,
  User,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
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
  DEFAULT_PULL_REQUEST_VIEW,
  pullRequestFilterCount,
  PULL_REQUEST_GROUPS,
  reasonFilterActive,
  type PullRequestGroupBy,
  type PullRequestGroupId,
  type PullRequestListView,
  type PullRequestReasonKind,
  pullRequestCiState,
  pullRequestReasons,
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
import { relativeTime } from "../lib/sessionRows.ts";
import { useShortcuts, type ShortcutGroup } from "./common/shortcuts.tsx";
import { ListRow } from "./common/ListRow.tsx";
import { ListGroupSection } from "./ListGroupSection.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import {
  PROPERTY_TRIGGER,
  PropertyLabel,
  PropertyList,
} from "./common/PropertyList.tsx";

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
      <GitMerge size={size} className="shrink-0 text-success" aria-hidden />
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
 * Each reason's badge tone: a review asked of you SOLID — someone is blocked
 * on it — an assignment in the attention tint, yours in blue, your teams
 * neutral.
 */
const REASON_BADGE_CLASS: Record<PullRequestReasonKind, string> = {
  "review-requested": "border-transparent bg-primary text-primary-foreground",
  assignee: "border-primary/40 bg-primary/10 text-primary",
  // The theme's `info` blue: green is taken by Merged, and the other two
  // hues the theme has (warning, destructive) mean trouble.
  author: "w-16 justify-center border-info/40 bg-info/12 text-info",
  // The same blue and the same width as "mine", outlined rather than filled:
  // yours through a team, one step removed from yours.
  "team-review": "w-16 justify-center border-info/40 text-info",
  "local-worktree": "",
};

/** The same glyphs the reason groups carry, so a compacted badge still reads. */
const REASON_BADGE_ICON: Record<PullRequestReasonKind, typeof Layers> = {
  "review-requested": Eye,
  author: User,
  assignee: UserCheck,
  "team-review": Users,
  "local-worktree": HardDrive,
};

/**
 * A short signal on the row's bottom line: icon plus one or two words. The
 * words go first when the line is tight (`ListRow`), the icon stays.
 */
function Signal({
  className,
  icon,
  label,
  title,
}: {
  className: string;
  icon: ReactNode;
  label: string;
  title?: string | undefined;
}) {
  return (
    <span
      className={`session-status-responsive-badge flex shrink-0 items-center gap-1 ${className}`}
      title={title ?? label}
    >
      {icon}
      <span className="session-status-badge-label">{label}</span>
    </span>
  );
}

function CiIcon({ tone }: { tone: PullRequestCiTone }) {
  const size = 11;
  if (tone === "success") return <CircleCheck size={size} aria-hidden />;
  if (tone === "failure" || tone === "error")
    return <CircleX size={size} aria-hidden />;
  if (tone === "pending") return <CircleDashed size={size} aria-hidden />;
  return <CircleDot size={size} aria-hidden />;
}

/**
 * One row, in the attention inbox's three rows: context with the age, identity
 * with the state in the leading slot, then signals. Memoized and id-taking by
 * the rule in `components/CLAUDE.md`: it closes over nothing from the list and
 * its handler receives the target, so the browser can hand every row the same
 * stable callback.
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
  const open = item.state === "open";
  // Why it is yours, leading the signals: what involves YOU personally (a
  // review asked of you, a pull request you opened, an assignment) first and
  // in the attention tone, then your teams. Shown whatever the grouping, since
  // a group heading names only one reason.
  const askedOf = pullRequestReasons(item).filter(
    (reason) => reason.kind !== "local-worktree",
  );
  return (
    <ListRow
      rowProps={{
        "data-pull-request-row": "",
        "data-list-row-id": pullRequestRowId(item),
        "data-pull-request-row-active": active ? "true" : undefined,
      }}
      ariaLabel={`Pull request #${item.number} ${item.title} — ${state.label}, ${ci.label}, ${review.label}`}
      active={active}
      density={density}
      onOpen={() => onOpen(pullRequestTargetOf(item))}
      onFocusSibling={onFocusSibling}
      // Context: where it lives and whose it is. Only the branch shortens.
      context={
        <>
          {project ? (
            <span
              className="flex max-w-full shrink-0 items-center gap-1"
              title={project.name}
            >
              <FolderKanban
                size={11}
                className="shrink-0"
                style={{ color: project.color }}
                aria-hidden
              />
              <span className="min-w-0 truncate">{project.key}</span>
            </span>
          ) : null}
          {!item.mine && item.author ? (
            <span
              className="flex shrink-0 items-center gap-1"
              title={`Opened by ${item.author}`}
            >
              <User size={11} className="shrink-0" aria-hidden />
              {item.author}
            </span>
          ) : null}
          <span
            className="flex min-w-0 max-w-max flex-1 basis-0 items-center gap-1"
            title={item.headBranch}
          >
            <GitBranch size={11} className="shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{item.headBranch}</span>
          </span>
        </>
      }
      age={item.updatedAt ? relativeTime(item.updatedAt) : undefined}
      leading={<StateIcon item={item} />}
      leadingTitle={state.label}
      title={
        <>
          <span className="mr-1.5 font-mono text-xs tabular-nums text-muted-foreground">
            #{item.number}
          </span>
          {item.title}
        </>
      }
      // Signals, in drop order: why it is yours, what blocks it, then CI and
      // review.
      signals={
        <>
          {askedOf.map((reason) => {
            const Icon = REASON_BADGE_ICON[reason.kind];
            return (
              <Badge
                key={reason.kind}
                variant="outline"
                title={reason.label}
                className={`session-status-responsive-badge max-w-32 ${REASON_BADGE_CLASS[reason.kind]}`}
              >
                <Icon aria-hidden />
                <span className="session-status-badge-label truncate">
                  {reason.short}
                </span>
              </Badge>
            );
          })}
          {!open ? (
            <Signal
              className={
                item.state === "merged" ? "text-success" : "text-destructive"
              }
              icon={<StateIcon item={item} />}
              label={item.state === "merged" ? "Merged" : "Closed"}
            />
          ) : null}
          {item.draft ? (
            // Amber: not ready yet — the warning tint the app uses for that.
            <Badge
              variant="outline"
              title="Draft"
              className="session-status-responsive-badge border-warning/40 bg-warning-soft text-warning"
            >
              <GitPullRequestDraft aria-hidden />
              <span className="session-status-badge-label">Draft</span>
            </Badge>
          ) : null}
          {open && item.mergeable === false ? (
            <Signal
              className="text-destructive"
              icon={<GitMerge size={11} aria-hidden />}
              label="Conflicts"
            />
          ) : null}
          {open &&
          (review.tone === "changes-requested" ||
            review.tone === "unresolved") ? (
            <Signal
              className={REVIEW_CLASS[review.tone]}
              icon={<MessageSquare size={11} aria-hidden />}
              label={
                review.tone === "changes-requested"
                  ? "Changes requested"
                  : review.label.replace(" unresolved", "")
              }
              title={review.label}
            />
          ) : null}
        </>
      }
      // The bottom line closes on what is true of THIS machine and of the
      // head: a local checkout, then CI — as the age closes the top line.
      trailing={
        item.worktreeId || open ? (
          <span className="flex items-center gap-2.5">
            {item.worktreeId ? (
              // The one relation a ROW states: a checkout on this machine,
              // which is what makes it actionable from here.
              <Signal
                className="text-foreground"
                icon={<HardDrive size={11} aria-hidden />}
                label="local"
                title="A local worktree holds this branch"
              />
            ) : null}
            {open ? (
              <Signal
                className={CI_CLASS[ci.tone]}
                icon={<CiIcon tone={ci.tone} />}
                // The icon and its colour say how CI went; the word only says
                // what the glyph is about. The full sentence is the tooltip.
                label="CI"
                title={ci.label}
              />
            ) : null}
          </span>
        ) : undefined
      }
    />
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
  /** Grouping and filters, from the bar above (`PullRequestListToolbar`). */
  listView?: PullRequestListView | undefined;
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
 * want something from you, grouped by why (or by project, or not at all) and
 * filtered by the bar above it (`PullRequestListToolbar`).
 * @useWhen The sidebar's Pull Requests section is selected.
 * @avoidWhen Listing everything open on a repository — that is the Project
 * page's job; this is an inbox, and a colleague's pull request is not in it.
 * @intent Replaces the Worktrees inbox in this slot. The question moved: a
 * branch on disk was never the unit of work waiting on a human, the pull
 * request is, and the checkout is one of the things it is joined to. Grouping,
 * ordering, filters and the status vocabulary are all decided in
 * `lib/pullRequestInbox.ts` — this file resolves project labels once and
 * renders the five load states.
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
  listView: listViewProp,
}: Props) {
  useShortcuts(PULL_REQUEST_SHORTCUTS);
  const listView = listViewProp ?? DEFAULT_PULL_REQUEST_VIEW;

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
  const projectTitles = useMemo(
    () =>
      Object.fromEntries([...projectsById].map(([id, row]) => [id, row.name])),
    [projectsById],
  );

  const items = dataOf(inventory);
  // The `?? []` is NOT a fallback anyone renders: this view is computed on
  // every frame, and on exactly the frames where an empty list would be a lie
  // (`items === undefined`) only `InventoryPlaceholder` renders, so `view.empty`
  // is read only by `InventoryRows`, after the inventory answered.
  const view = useMemo(
    () =>
      buildPullRequestInbox(items ?? [], {
        view: listView,
        projectLabels: projectTitles,
      }),
    [items, listView, projectTitles],
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
      query=""
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
    <div className="flex flex-col">
      {/* No gap between groups: a project band meets the last row above it
          on that row's own hairline. */}
      <div className="flex flex-col">
        {items === undefined ? (
          <InventoryPlaceholder
            error={errorOf(inventory)}
            onReload={onReload}
          />
        ) : (
          <InventoryRows
            inventory={inventory}
            view={view}
            filtered={pullRequestFilterCount(listView) > 0}
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
  filtered,
  onReload,
  projectsById,
  selected,
  density,
  onOpen,
  onFocusSibling,
}: {
  inventory: LoadState<PullRequestInventoryItem[]>;
  view: ReturnType<typeof buildPullRequestInbox>;
  /** The bar narrows the list, so an empty one says so. */
  filtered: boolean;
  onReload: () => void;
  projectsById: ReadonlyMap<string, RowProject>;
  selected: PullRequestTarget | null | undefined;
  density: RowDensity;
  onOpen: (target: PullRequestTarget) => void;
  onFocusSibling: (delta: 1 | -1) => void;
}) {
  const error = errorOf(inventory);
  return (
    <>
      {/* R2 again: a failed refresh keeps the last answer and adds this note. */}
      {error ? (
        <ErrorNote message={error} onRetry={onReload} className="mb-1" />
      ) : null}

      {view.empty ? (
        <EmptyBox>
          {filtered
            ? "No pull requests match these filters."
            : "No pull requests need you right now. Ones you open, are assigned or asked to review (yourself or through a team), and merged ones still checked out locally appear here."}
        </EmptyBox>
      ) : null}

      {view.groups.map((group) => {
        const rows = group.items.map((item) => (
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
        ));
        // Flat: one list, nothing to head.
        if (!group.collapsible)
          return (
            <div key={group.id} className="flex flex-col">
              {rows}
            </div>
          );
        const color =
          group.projectId !== undefined
            ? projectsById.get(group.projectId)?.color
            : undefined;
        return (
          <ListGroupSection
            key={group.id}
            id={group.id}
            title={group.title}
            count={group.items.length}
            defaultOpen={group.defaultOpen}
            emphasis={group.emphasis}
            icon={
              group.projectId !== undefined ? (
                <FolderKanban
                  size={14}
                  className="shrink-0"
                  style={color ? { color } : undefined}
                  aria-hidden
                />
              ) : (
                <ReasonIcon id={group.id} />
              )
            }
            // The open pull request must stay visible in its list.
            containsSelected={group.items.some((item) =>
              isPullRequestTarget(item, selected),
            )}
          >
            {rows}
          </ListGroupSection>
        );
      })}
    </>
  );
}

const REASON_ICON: Record<string, typeof Layers> = {
  "needs-review": Eye,
  yours: User,
  assigned: UserCheck,
  "team-review": Users,
  cleanup: GitMerge,
};

function ReasonIcon({ id }: { id: string }) {
  const Icon = id.startsWith("date:")
    ? CalendarDays
    : (REASON_ICON[id] ?? Layers);
  return <Icon size={14} className="shrink-0" aria-hidden />;
}

const GROUP_BY_META: Record<
  PullRequestGroupBy,
  { label: string; Icon: typeof Layers; title: string }
> = {
  reason: {
    label: "By reason",
    Icon: Layers,
    title: "Why each is yours: review requests first, cleanup last",
  },
  project: {
    label: "By project",
    Icon: FolderKanban,
    title: "One group per project",
  },
  date: {
    label: "By date",
    Icon: CalendarDays,
    title: "When each was last updated, newest first",
  },
};

/**
 * @component PullRequestListToolbar
 * @purpose The Pull Requests list's header bar, in the Tasks bar's shape: the
 * grouping as a quiet dropdown on the left, every filter behind one button on
 * the right whose badge counts the active ones, so a filtered list never
 * passes for the whole inventory.
 * @useWhen Above the section's scroll container (`Sidebar.tsx`), for the list
 * `PullRequestBrowser` draws with the same view.
 * @intent The view lives in browser-local prefs, so the bar and the list read
 * and write one value. The project options are the projects that HAVE pull
 * requests listed — a filter offering an empty project offers nothing.
 */
export const PullRequestListToolbar = memo(function PullRequestListToolbar({
  view,
  onChange,
  inventory,
  projects,
}: {
  view: PullRequestListView;
  onChange: (patch: Partial<PullRequestListView>) => void;
  inventory: LoadState<PullRequestInventoryItem[]>;
  projects: ProjectRecord[];
}) {
  const items = dataOf(inventory);
  const projectOptions = useMemo(() => {
    const ids = new Set((items ?? []).map((item) => item.projectId));
    return projects
      .filter((project) => ids.has(project.id))
      .map((project) => ({
        id: project.id,
        key: projectDisplayKey(project),
        name: project.name,
        color: projectColor(project).dot,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [items, projects]);
  const active = pullRequestFilterCount(view);
  const meta = GROUP_BY_META[view.groupBy];
  const Icon = meta.Icon;
  const chosenProject = projectOptions.find(
    (project) => project.id === view.projectId,
  );
  const reasonsFiltered = reasonFilterActive(view.reasons);
  return (
    <div className="flex h-11 items-center gap-1 border-b border-border bg-card px-1.5 sm:px-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="min-w-0 gap-1.5 font-medium"
              aria-label={`Group pull requests: ${meta.label}`}
            />
          }
        >
          <Icon className="text-muted-foreground" />
          <span className="truncate">{meta.label}</span>
          <ChevronDown className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {(Object.keys(GROUP_BY_META) as PullRequestGroupBy[]).map((id) => {
            const item = GROUP_BY_META[id];
            const ItemIcon = item.Icon;
            return (
              <DropdownMenuItem
                key={id}
                aria-current={id === view.groupBy || undefined}
                className="items-start"
                onClick={() => onChange({ groupBy: id })}
              >
                <ItemIcon className="mt-0.5" />
                <span className="flex min-w-0 flex-col">
                  <span className={id === view.groupBy ? "font-medium" : ""}>
                    {item.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {item.title}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* R2: a poll keeps the rows and says so here. */}
      {isPending(inventory) ? (
        <RefreshIndicator label="Refreshing pull requests" />
      ) : null}
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto gap-1 text-muted-foreground"
              aria-label={active ? `Filters (${active} active)` : "Filters"}
            />
          }
        >
          <SlidersHorizontal />
          {active ? (
            <span className="min-w-4 rounded-full bg-primary px-1 text-xs font-medium text-primary-foreground tabular-nums">
              {active}
            </span>
          ) : null}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <PropertyList>
            <PropertyLabel>Project</PropertyLabel>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Filter by project"
                    className={`${PROPERTY_TRIGGER} min-w-0 justify-start`}
                  />
                }
              >
                {chosenProject ? (
                  <>
                    <FolderKanban style={{ color: chosenProject.color }} />
                    <span className="min-w-0 truncate">
                      {chosenProject.name}
                    </span>
                  </>
                ) : (
                  <>
                    <FolderKanban className="text-muted-foreground" />
                    <span className="text-muted-foreground">All projects</span>
                  </>
                )}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuItem
                  aria-current={view.projectId === null || undefined}
                  onClick={() => onChange({ projectId: null })}
                >
                  <FolderKanban className="text-muted-foreground" />
                  All projects
                </DropdownMenuItem>
                {projectOptions.map((project) => (
                  <DropdownMenuItem
                    key={project.id}
                    aria-current={view.projectId === project.id || undefined}
                    onClick={() => onChange({ projectId: project.id })}
                  >
                    <FolderKanban style={{ color: project.color }} />
                    <span className="min-w-0 flex-1 truncate">
                      {project.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {project.key}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <PropertyLabel>Show</PropertyLabel>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Filter by reason"
                    className={`${PROPERTY_TRIGGER} min-w-0 justify-start`}
                  />
                }
              >
                <ListFilter className="text-muted-foreground" />
                <span
                  className={`min-w-0 truncate ${reasonsFiltered ? "" : "text-muted-foreground"}`}
                >
                  {reasonsFiltered
                    ? PULL_REQUEST_GROUPS.filter((group) =>
                        view.reasons.includes(group.id),
                      )
                        .map((group) => group.title)
                        .join(", ") || "Nothing"
                    : "Every reason"}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                {PULL_REQUEST_GROUPS.map((group) => (
                  <DropdownMenuCheckboxItem
                    key={group.id}
                    checked={view.reasons.includes(group.id)}
                    closeOnClick={false}
                    onCheckedChange={(checked) =>
                      onChange({
                        reasons: checked
                          ? [...view.reasons, group.id]
                          : view.reasons.filter(
                              (id: PullRequestGroupId) => id !== group.id,
                            ),
                      })
                    }
                  >
                    {group.title}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <PropertyLabel>Drafts</PropertyLabel>
            <Button
              variant="ghost"
              size="sm"
              className={`${PROPERTY_TRIGGER} justify-start`}
              aria-pressed={view.hideDrafts}
              onClick={() => onChange({ hideDrafts: !view.hideDrafts })}
            >
              <GitPullRequestDraft className="text-muted-foreground" />
              <span className={view.hideDrafts ? "" : "text-muted-foreground"}>
                {view.hideDrafts ? "Hidden" : "Shown"}
              </span>
            </Button>
          </PropertyList>
        </PopoverContent>
      </Popover>
    </div>
  );
});
