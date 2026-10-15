import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { List, Map as MapIcon, Waypoints } from "lucide-react";
import type {
  InitiativeProgress,
  InitiativeSummary,
  SessionListItem,
  TaskSummary,
} from "@assistant/shared";
import { PageHeader, type PageHeaderBack } from "../PageHeader.tsx";
import { Alert, AlertDescription } from "../ui/alert.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
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
  initiativeMembers,
  memberTree,
  milestoneMembers,
  runningTaskIds,
} from "../../lib/initiativeView.ts";
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
 * @component InitiativeDetailPage
 * @purpose One Initiative (`/initiatives/:id`): its title, state and progress,
 *   and its members as a Map or a List (`docs/initiatives.md`).
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
  onLoadDetail: (id: string) => void;
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

  // Read when nothing is held or a newer revision marked the read stale. A
  // read already in flight is not repeated (`requestInitiativeDetail`).
  const status = detailState?.status ?? "idle";
  useEffect(() => {
    if (status === "idle" || status === "loading" || status === "refreshing")
      onLoadDetail(initiativeId);
  }, [initiativeId, onLoadDetail, status]);
  // A read the connection lost is tried again once it is back, so a reconnect
  // never leaves the page on that error; any other failure waits for Retry.
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current && status === "error")
      onLoadDetail(initiativeId);
    wasConnected.current = connected;
  }, [connected, initiativeId, onLoadDetail, status]);

  const [chosenView, setView] = useSessionStorageState<InitiativeView | "auto">(
    VIEW_STORAGE_KEY,
    "auto",
    decodeView,
  );
  const view: InitiativeView =
    chosenView === "auto" ? (mobile ? "list" : "map") : chosenView;

  const read = detailState ? (dataOf(detailState) ?? undefined) : undefined;
  const item = read?.item;
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

  const retry = () => onLoadDetail(initiativeId);

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
  } else {
    const list = (
      <InitiativeListView
        tree={tree}
        milestones={milestones}
        selectedTaskId={selectedTaskId}
        onSelectTask={onSelectTask}
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
              members={members}
              projectLabel={projectLabel}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
            />
          </Suspense>
        </MapBoundary>
      </div>
    ) : (
      <div ref={listScrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {view === "map" ? (
          <ErrorNote
            className="mb-4"
            message={`The map could not be drawn, so the members are listed instead. ${
              read?.layoutError ?? "The read carried no layout."
            }`}
            onRetry={retry}
          />
        ) : null}
        {item.description ? (
          <p className="mb-4 max-w-prose text-sm whitespace-pre-line text-muted-foreground">
            {item.description}
          </p>
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
            <RefreshIndicator label="Refreshing the Initiative" />
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
          <ToggleGroup
            aria-label="View"
            className="ml-auto"
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
