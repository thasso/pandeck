import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  EyeOff,
  FoldHorizontal,
  Info,
  List,
  Map as MapIcon,
  Route,
  UnfoldHorizontal,
  Waypoints,
} from "lucide-react";
import type {
  InitiativeLayoutTooLarge,
  InitiativeProgress,
  InitiativeSummary,
  SessionListItem,
  TaskSummary,
} from "@assistant/shared";
import { PageHeader, type PageHeaderBack } from "../PageHeader.tsx";
import { Alert, AlertAction, AlertDescription } from "../ui/alert.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Toggle } from "../ui/toggle.tsx";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.tsx";
import {
  EmptyBox,
  ErrorNote,
  RefreshIndicator,
  Skeleton,
} from "../common/load.tsx";
import { dataOf, errorOf, type LoadState } from "../../lib/loadState.ts";
import type { InitiativeRead } from "../../hooks/useAssistant.ts";
import { useSessionStorageState } from "../../hooks/useSessionStorageState.ts";
import { useListScroll } from "../../hooks/useListScroll.ts";
import {
  INITIATIVE_STATE_LABEL,
  canonicalCollapsed,
  collapseRequest,
  collapsedAway,
  hiddenDoneIds,
  initiativeMembers,
  memberChildren,
  memberTree,
  milestoneMembers,
  runningTaskIds,
  sameCollapsed,
  subtreeFacts,
  type InitiativeMember,
} from "../../lib/initiativeView.ts";
import { criticalPath, type CriticalPath } from "../../lib/initiativePath.ts";
import { InitiativeDescription } from "./InitiativeDescription.tsx";
import { InitiativeListView } from "./InitiativeListView.tsx";
import { InitiativeProgressLine } from "./InitiativeProgressLine.tsx";

// React Flow is loaded only when a map is drawn: it never weighs on the List,
// the index, or any other page.
const InitiativeMap = lazy(() => import("./InitiativeMap.tsx"));

type InitiativeView = "map" | "list";

const VIEW_STORAGE_KEY = "assistant.initiativeView.v1";
const decodeView = (raw: string): InitiativeView | "auto" | null =>
  raw === '"map"' ? "map" : raw === '"list"' ? "list" : null;

/**
 * How the user is looking at ONE Initiative in this tab: the epics they
 * collapsed (nested ones included, so expanding an outer epic shows the inner
 * one still folded), Hide done, the critical path, and whether the description
 * is folded. Display only: nothing here is written to the server, and another
 * Initiative starts fresh.
 */
interface MapSettings {
  collapsed: string[];
  hideDone: boolean;
  criticalPath: boolean;
  descriptionFolded: boolean;
}

const NO_SETTINGS: MapSettings = {
  collapsed: [],
  hideDone: false,
  criticalPath: false,
  descriptionFolded: false,
};
const NONE: ReadonlySet<string> = new Set();

const settingsKey = (initiativeId: string) =>
  `assistant.initiativeMap.v1:${initiativeId}`;

function decodeSettings(raw: string): MapSettings | null {
  try {
    const value = JSON.parse(raw) as Partial<MapSettings> | null;
    if (!value || typeof value !== "object") return null;
    return {
      collapsed: Array.isArray(value.collapsed)
        ? value.collapsed.filter((id): id is string => typeof id === "string")
        : [],
      hideDone: value.hideDone === true,
      criticalPath: value.criticalPath === true,
      descriptionFolded: value.descriptionFolded === true,
    };
  } catch {
    return null;
  }
}

/** What the line under the toolbar says about the highlighted path. */
function pathSentence(
  path: CriticalPath,
  members: ReadonlyMap<string, InitiativeMember>,
): string {
  if (path.kind === "none")
    return "No milestone is open, so there is no critical path.";
  const milestone =
    members.get(path.milestoneId)?.title ?? `Task-${path.milestoneId}`;
  if (path.kind === "loop")
    return `The blocks links before ${milestone} run in a loop (${path.taskIds
      .slice(0, 4)
      .map((id) => `Task-${id}`)
      .join(", ")}${
      path.taskIds.length > 4 ? ", …" : ""
    }), so no critical path is drawn.`;
  if (path.length === 1)
    return `Critical path: nothing open blocks ${milestone}.`;
  return path.tied
    ? `Critical path: more than one chain of ${path.length} open Tasks ends at ${milestone}; each is marked.`
    : `Critical path: ${path.length} open Tasks end at ${milestone}.`;
}

/**
 * @component InitiativeDetailPage
 * @purpose One Initiative (`/initiatives/:id`): its title, state, progress
 *   and description, and its members as a Map or a List
 *   (`docs/initiatives.md`).
 * @useWhen The Initiative route with an id.
 * @intent Read-only. The header comes from the live summary at once; the
 *   members come from the keyed read, which a newer Initiative revision
 *   re-reads while the old one stays on screen. Between reads, status, blocked
 *   and running marks follow the Tasks topic. Map is the default on a wide
 *   screen and List on a phone; the user's choice holds for the tab. A map
 *   that could not be laid out says why, offers a retry and shows the List.
 *   Selecting a Task opens it in the object panel; nothing here writes.
 */
export function InitiativeDetailPage({
  initiativeId,
  back,
  mobile,
  connected,
  summary,
  detailState,
  onLoadDetail,
  onOpenInitiative,
  liveTasks,
  sessions,
  projectLabel,
  selectedTaskId,
  onSelectTask,
  onOpenIndex,
}: {
  initiativeId: string;
  back?: PageHeaderBack | undefined;
  /** A phone: the List is the default view. */
  mobile: boolean;
  connected: boolean;
  /** The live summary, when the topic holds it. */
  summary: InitiativeSummary | undefined;
  detailState: LoadState<InitiativeRead | null> | undefined;
  /** Read the Initiative, its map drawn with `collapsed` folded. */
  onLoadDetail: (id: string, collapsed: readonly string[]) => void;
  onOpenInitiative: (id: string | null) => void;
  /** The Tasks topic, or null while it is not authoritative. */
  liveTasks: ReadonlyMap<string, TaskSummary> | null;
  sessions: readonly SessionListItem[];
  projectLabel: (projectId: string | undefined) => string;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onOpenIndex: () => void;
}) {
  useEffect(() => {
    onOpenInitiative(initiativeId);
    return () => onOpenInitiative(null);
  }, [initiativeId, onOpenInitiative]);

  const [chosenView, setView] = useSessionStorageState<InitiativeView | "auto">(
    VIEW_STORAGE_KEY,
    "auto",
    decodeView,
  );
  const view: InitiativeView =
    chosenView === "auto" ? (mobile ? "list" : "map") : chosenView;
  // The page is keyed by Initiative (`App.tsx`), so this key never changes
  // under a mounted page and one Initiative's choices never reach another.
  const [settings, setSettings] = useSessionStorageState<MapSettings>(
    settingsKey(initiativeId),
    NO_SETTINGS,
    decodeSettings,
  );

  const read = detailState ? (dataOf(detailState) ?? undefined) : undefined;
  const item = read?.item;

  // The drawing the user wants: their collapsed epics as the server applies
  // them to the graph held. A read carries the set it asked for, and it draws
  // the wanted map when both name the same applied set on that graph, so the
  // server's normalisation never reads as a change.
  const wish = useMemo(
    () =>
      item
        ? canonicalCollapsed(item, settings.collapsed)
        : collapseRequest(settings.collapsed),
    [item, settings.collapsed],
  );
  const wishKey = wish.join(",");
  const drawsWish =
    !item ||
    sameCollapsed(
      canonicalCollapsed(item, read?.requestedCollapsed ?? []),
      wish,
    );

  // Read when nothing is held or a newer revision marked the read stale, and
  // when the map is shown for another collapsed set than the read was for. A
  // read already in flight is not repeated, and a wish that moves while one
  // runs is read as soon as it answers (`requestInitiativeDetail`).
  //
  // Keyed on the state OBJECT, not its status string: an answer older than a
  // revision this tab already holds lands as `refreshing` again, with new data,
  // and only the new object says another read is due. A read in flight leaves
  // the object as it is, so this never sends twice for one state. A failure is
  // read again only when the user changes what they want drawn.
  const status = detailState?.status ?? "idle";
  const askedWish = useRef(wishKey);
  useEffect(() => {
    const wishMoved = askedWish.current !== wishKey;
    askedWish.current = wishKey;
    const current = detailState?.status ?? "idle";
    if (current === "idle" || current === "loading" || current === "refreshing")
      onLoadDetail(initiativeId, wish);
    else if (view === "map" && !drawsWish && (current === "ready" || wishMoved))
      onLoadDetail(initiativeId, wish);
  }, [detailState, drawsWish, initiativeId, onLoadDetail, view, wish, wishKey]);
  // A read the connection lost is tried again once it is back, so a reconnect
  // never leaves the page on that error; any other failure waits for Retry.
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current && status === "error")
      onLoadDetail(initiativeId, wish);
    wasConnected.current = connected;
  }, [connected, initiativeId, onLoadDetail, status, wish]);
  const running = useMemo(
    () => runningTaskIds(liveTasks, sessions),
    [liveTasks, sessions],
  );
  const members = useMemo(
    () => (item ? initiativeMembers(item, liveTasks, running) : null),
    [item, liveTasks, running],
  );
  const tree = useMemo(
    () => (item && members ? memberTree(item, members) : []),
    [item, members],
  );
  const milestones = useMemo(
    () => (item && members ? milestoneMembers(item, members) : []),
    [item, members],
  );
  const facts = useMemo(
    () => (item && members ? subtreeFacts(item, members) : new Map()),
    [item, members],
  );
  const collapsible = useMemo(
    () => (item ? new Set(memberChildren(item).keys()) : NONE),
    [item],
  );
  const collapsed = useMemo(() => new Set(wish), [wish]);
  const folded = useMemo(
    () => (item ? collapsedAway(item, wish) : new Map<string, string>()),
    [item, wish],
  );
  const hidden = useMemo(
    () =>
      settings.hideDone && item && members
        ? hiddenDoneIds(item, members, facts)
        : NONE,
    [settings.hideDone, item, members, facts],
  );
  const path = useMemo(
    () =>
      settings.criticalPath && item && members
        ? criticalPath(item, members)
        : null,
    [settings.criticalPath, item, members],
  );
  // An epic still drawn open, by the wish: "Collapse all" has work to do.
  const anyOpenEpic = [...collapsible].some(
    (id) => !collapsed.has(id) && !folded.has(id),
  );
  // The same question of the collapsed set the HELD read answered for, which
  // is what its size outcome speaks about until the wish is answered.
  const heldCollapsed = useMemo(
    () =>
      item ? canonicalCollapsed(item, read?.requestedCollapsed ?? []) : [],
    [item, read?.requestedCollapsed],
  );
  const heldOpenEpic = useMemo(() => {
    if (!item) return false;
    const held = new Set(heldCollapsed);
    const heldFolded = collapsedAway(item, heldCollapsed);
    return [...collapsible].some((id) => !held.has(id) && !heldFolded.has(id));
  }, [item, heldCollapsed, collapsible]);

  const toggleCollapse = useCallback(
    (taskId: string) =>
      setSettings((previous) => ({
        ...previous,
        collapsed: previous.collapsed.includes(taskId)
          ? previous.collapsed.filter((id) => id !== taskId)
          : [...previous.collapsed, taskId],
      })),
    [setSettings],
  );
  // Collapse every epic, nested ones too: expanding one later opens a single
  // level, which is what keeps a large map small enough to draw. The whole
  // wish is kept; only the request is bounded (`canonicalCollapsed`).
  const collapseAll = () =>
    setSettings((previous) => ({
      ...previous,
      collapsed: [...new Set([...previous.collapsed, ...collapsible])],
    }));
  const expandAll = () =>
    setSettings((previous) => ({ ...previous, collapsed: [] }));

  const title = summary?.title ?? item?.title;
  const state = summary?.state ?? item?.state;
  const progress: InitiativeProgress | undefined =
    summary?.progress ?? item?.progress;
  const error = detailState ? errorOf(detailState) : undefined;
  const missing = detailState?.status === "ready" && detailState.data === null;
  const firstLoad = !read && !error && !missing;

  const listScrollRef = useListScroll({
    listKey: view === "list" ? `initiative:${initiativeId}` : null,
  });

  const retry = () => onLoadDetail(initiativeId, wish);
  const showDone = () =>
    setSettings((previous) => ({ ...previous, hideDone: false }));

  const selectedFoldedIn =
    selectedTaskId !== null ? folded.get(selectedTaskId) : undefined;
  const notes: string[] = [];
  if (path && members) notes.push(pathSentence(path, members));
  if (hidden.size > 0)
    notes.push(
      `${hidden.size} done ${hidden.size === 1 ? "Task is" : "Tasks are"} hidden.`,
    );
  if (selectedTaskId !== null && hidden.has(selectedTaskId))
    notes.push(
      `The selected Task, Task-${selectedTaskId}, is done and hidden; it stays open in the panel.`,
    );
  else if (selectedFoldedIn !== undefined)
    notes.push(
      `The selected Task, Task-${selectedTaskId}, is inside collapsed ${
        members?.get(selectedFoldedIn)?.title ?? `Task-${selectedFoldedIn}`
      }.`,
    );
  const everythingHidden =
    item !== undefined &&
    item.nodes.length > 0 &&
    item.nodes.every((node) => hidden.has(node.id));

  let body: ReactNode;
  if (missing) {
    body = (
      <EmptyBox
        className="m-4"
        action={
          <Button size="sm" variant="outline" onClick={onOpenIndex}>
            Show all Initiatives
          </Button>
        }
      >
        Initiative-{initiativeId} does not exist, or it was deleted.
      </EmptyBox>
    );
  } else if (firstLoad) {
    body = (
      <div role="status" className="flex flex-col gap-2 p-4">
        <span className="sr-only">Loading the Initiative…</span>
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <Skeleton key={row} className="h-8 w-full" />
        ))}
      </div>
    );
  } else if (!item || !members) {
    body = (
      <div className="p-4">
        <ErrorNote
          message={error ?? "The Initiative could not be read."}
          onRetry={retry}
        />
      </div>
    );
  } else if (item.nodes.length === 0) {
    body = (
      <EmptyBox className="m-4">
        This Initiative has no Tasks yet. Ask an agent to add some to it.
      </EmptyBox>
    );
  } else if (everythingHidden) {
    body = (
      <EmptyBox
        className="m-4"
        action={
          <Button size="sm" variant="outline" onClick={showDone}>
            Show done Tasks
          </Button>
        }
      >
        Every Task in this Initiative is done, and Hide done is on.
      </EmptyBox>
    );
  } else {
    const list = (
      <InitiativeListView
        tree={tree}
        milestones={milestones}
        selectedTaskId={selectedTaskId}
        onSelectTask={onSelectTask}
        collapsible={collapsible}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        hidden={hidden}
        pathTaskIds={path?.kind === "path" ? path.taskIds : path ? NONE : null}
      />
    );
    const showMap = view === "map" && read?.layout !== undefined;
    body = showMap ? (
      <div className="relative min-h-0 flex-1">
        <MapBoundary fallback={list}>
          <Suspense
            fallback={
              <div role="status" className="h-full w-full p-4">
                <span className="sr-only">Loading the map…</span>
                <Skeleton className="h-full w-full" />
              </div>
            }
          >
            <InitiativeMap
              layout={read.layout!}
              blocks={item.edges}
              members={members}
              projectLabel={projectLabel}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
              facts={facts}
              collapsible={collapsible}
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
              hidden={hidden}
              path={path}
            />
          </Suspense>
        </MapBoundary>
      </div>
    ) : (
      <div ref={listScrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {view === "map" && read?.layoutTooLarge ? (
          <MapTooLarge
            size={read.layoutTooLarge}
            canCollapse={collapsible.size > 0}
            answer={
              drawsWish ? "answered" : status === "error" ? "failed" : "pending"
            }
            heldOpenEpic={heldOpenEpic}
            anyOpenEpic={anyOpenEpic}
            onCollapseAll={collapseAll}
          />
        ) : view === "map" ? (
          <>
            <ErrorNote
              className="mb-4"
              message={`The map could not be drawn, so the members are listed instead. ${
                read?.layoutError ?? "The read carried no layout."
              }`}
              onRetry={retry}
            />
            {collapsible.size > 0 ? (
              <Alert role="status" className="mb-4">
                <AlertDescription>
                  {anyOpenEpic
                    ? "Collapsed epics draw as one node each, so a smaller map can be drawn. Collapse all of them here, or one at a time with the button before an epic below."
                    : "Every epic is collapsed. Expand one with the button before it below, or expand them all from the toolbar."}
                </AlertDescription>
                {anyOpenEpic ? (
                  <AlertAction>
                    <Button size="xs" variant="outline" onClick={collapseAll}>
                      <FoldHorizontal />
                      Collapse all epics
                    </Button>
                  </AlertAction>
                ) : null}
              </Alert>
            ) : null}
          </>
        ) : null}
        {list}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PageHeader
        back={back}
        density="compact"
        icon={<Waypoints size={16} />}
        title={
          title ? (
            <span className="truncate">{title}</span>
          ) : firstLoad ? (
            <Skeleton as="span" className="inline-block h-4 w-48" />
          ) : (
            `Initiative-${initiativeId}`
          )
        }
        actions={
          detailState?.status === "refreshing" ? (
            <RefreshIndicator
              label={
                view === "map" && !drawsWish
                  ? "Redrawing the map"
                  : "Refreshing the Initiative"
              }
            />
          ) : undefined
        }
      />
      {!missing ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
          {state ? (
            <Badge
              variant={
                state === "done"
                  ? "success"
                  : state === "paused"
                    ? "warning"
                    : "secondary"
              }
            >
              {INITIATIVE_STATE_LABEL[state]}
            </Badge>
          ) : null}
          {progress ? <InitiativeProgressLine progress={progress} /> : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {item && item.nodes.length > 0 ? (
              <>
                <Toggle
                  variant="outline"
                  size="sm"
                  pressed={settings.criticalPath}
                  onPressedChange={(pressed) =>
                    setSettings((previous) => ({
                      ...previous,
                      criticalPath: pressed,
                    }))
                  }
                >
                  <Route /> Critical path
                </Toggle>
                <Toggle
                  variant="outline"
                  size="sm"
                  pressed={settings.hideDone}
                  onPressedChange={(pressed) =>
                    setSettings((previous) => ({
                      ...previous,
                      hideDone: pressed,
                    }))
                  }
                >
                  <EyeOff /> Hide done
                </Toggle>
                {collapsible.size > 0 ? (
                  // One button whose name follows the drawing, so focus stays
                  // on it after a press instead of falling off a disabled one.
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={anyOpenEpic ? collapseAll : expandAll}
                  >
                    {anyOpenEpic ? <FoldHorizontal /> : <UnfoldHorizontal />}
                    {anyOpenEpic ? "Collapse all epics" : "Expand all epics"}
                  </Button>
                ) : null}
              </>
            ) : null}
            <ToggleGroup
              aria-label="View"
              size="sm"
              variant="outline"
              value={[view]}
              onValueChange={(next) => {
                const picked = next[0];
                if (picked === "map" || picked === "list") setView(picked);
              }}
            >
              <ToggleGroupItem value="map" aria-label="Map">
                <MapIcon /> Map
              </ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label="List">
                <List /> List
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
      ) : null}
      {item?.description.trim() && !missing ? (
        <InitiativeDescription
          text={item.description}
          open={!settings.descriptionFolded}
          onOpenChange={(open) =>
            setSettings((previous) => ({
              ...previous,
              descriptionFolded: !open,
            }))
          }
          onSelectTask={onSelectTask}
        />
      ) : null}
      {notes.length > 0 && !missing ? (
        <div
          role="status"
          className="flex flex-col gap-0.5 border-b border-border px-4 py-1.5 text-xs text-muted-foreground"
        >
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      ) : null}
      {item?.archivedAt ? (
        <Alert role="status" className="mx-4 mt-3 w-auto">
          <AlertDescription>
            This Initiative is archived. It stays readable here and leaves the
            Initiatives list.
          </AlertDescription>
        </Alert>
      ) : null}
      {error && read ? (
        <div className="px-4 pt-3">
          <ErrorNote message={error} onRetry={retry} />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </div>
  );
}

const COUNT = new Intl.NumberFormat("en-US");

/**
 * A map over the layout's node limit. That is the map's size, an expected
 * outcome and not a failure: a neutral notice with the drawn count and no
 * Retry, since reading the same drawing again cannot change it. Collapsing
 * epics can, so "Collapse all epics" is the primary action, and each epic's
 * own button in the List below works as well.
 *
 * The count is the HELD read's, for the epics collapsed when it was read. Until
 * the user's newer choice is answered the notice says so, and claims nothing
 * about a drawing nobody has counted yet: "every epic is collapsed" is said
 * only of an answer for that choice. A read for it that failed is the error
 * above the page, with its Retry; the notice then only keeps the earlier count.
 */
function MapTooLarge({
  size,
  canCollapse,
  answer,
  heldOpenEpic,
  anyOpenEpic,
  onCollapseAll,
}: {
  size: InitiativeLayoutTooLarge;
  canCollapse: boolean;
  /** Whether the held read is for the collapsed epics wanted now. */
  answer: "answered" | "pending" | "failed";
  /** An epic the held read drew open. */
  heldOpenEpic: boolean;
  /** An epic the wish leaves open: collapsing all has work to do. */
  anyOpenEpic: boolean;
  onCollapseAll: () => void;
}) {
  const nodes = COUNT.format(size.nodes);
  const limit = COUNT.format(size.limit);
  const collapseHint =
    "A collapsed epic draws as one node: collapse all of them, or one at a time with the button before an epic below.";
  return (
    <Alert role="status" className="mb-4">
      <Info />
      <AlertDescription>
        {!canCollapse
          ? `This map has ${nodes} nodes, more than the ${limit} it lays out, so its members are listed instead.`
          : answer !== "answered"
            ? `With the epics collapsed before, the map had ${nodes} nodes, more than the ${limit} it lays out, so its members are listed instead. ${
                answer === "pending"
                  ? "It is being drawn again for the epics collapsed now."
                  : "It could not be drawn again for the epics collapsed now."
              }${anyOpenEpic ? ` ${collapseHint}` : ""}`
            : heldOpenEpic
              ? `This map has ${nodes} nodes, more than the ${limit} it lays out, so its members are listed instead. ${collapseHint}`
              : `Every epic is collapsed, and the map still has ${nodes} nodes, more than the ${limit} it lays out, so its members are listed instead.`}
      </AlertDescription>
      {canCollapse && anyOpenEpic ? (
        // Its own row under the words, as the notice's next step, rather
        // than a corner action the text would run under.
        <div className="mt-2">
          <Button size="sm" onClick={onCollapseAll}>
            <FoldHorizontal />
            Collapse all epics
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}

/**
 * The map's code is a separate chunk. If it cannot be loaded (an offline tab
 * after a deploy), the page says so and keeps the List rather than going blank.
 * A failed lazy import stays failed until the page reloads, so there is no
 * retry here to pretend otherwise.
 */
class MapBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="h-full overflow-y-auto p-4">
        <ErrorNote
          className="mb-4"
          message="The map could not be loaded, so the members are listed instead. Reload the page to try again."
        />
        {this.props.fallback}
      </div>
    );
  }
}
