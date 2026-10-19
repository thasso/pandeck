import { memo, useMemo } from "react";
import { Waypoints } from "lucide-react";
import type { InitiativeSummary, ProjectRecord } from "@assistant/shared";
import type { InitiativeRead } from "../../hooks/useAssistant.ts";
import { dataOf, type LoadState } from "../../lib/loadState.ts";
import { initiativeBrowserCounts } from "../../lib/initiativeBrowserCounts.ts";
import type { RowDensity } from "../../lib/rowDensity.ts";
import { ErrorNote, RefreshIndicator, Skeleton } from "../common/load.tsx";
import { ListGroupSection } from "../ListGroupSection.tsx";
import {
  InitiativeBrowserRow,
  type InitiativeBrowserWorktrees,
} from "./InitiativeBrowserRow.tsx";
import type { InitiativeBrowserSessions } from "./InitiativeCoordinatorRows.tsx";

const NO_PROJECTS: readonly ProjectRecord[] = [];

/**
 * @component InitiativeBrowserGroup
 * @purpose The Initiatives group at the top of the Projects browser, the
 *   canonical sidebar location of an Initiative (`app/web/docs/ui-shell.md`).
 * @useWhen The Projects section's browser, above the Project tree.
 * @intent Bounded: it lists the active and paused Initiatives. Its separator
 *   folds the rows without linking to an index page. With nothing to list it
 *   shows the band alone. A new read over a list it held marks the band refreshing.
 */
export const InitiativeBrowserGroup = memo(function InitiativeBrowserGroup({
  initiatives,
  fresh,
  refreshing,
  error,
  onRetry,
  selectedId,
  onNavigate,
  initiativeDetails,
  projects = NO_PROJECTS,
  selectedProjectId,
  density = "tight",
  onLoadDetail,
  onRetainDetail,
  worktrees,
  sessions,
}: {
  initiatives: readonly InitiativeSummary[];
  /** A snapshot answered the current subscription. */
  fresh: boolean;
  /** A new snapshot is out over the list an earlier one answered. */
  refreshing: boolean;
  /**
   * The list could not be read. It is stated here with a retry, over any rows
   * still held, so the group never waits on a snapshot that is not coming.
   */
  error: string | null;
  /** Stable: ask for the list again. */
  onRetry: () => void;
  selectedId: string | null;
  /** Stable host navigation; rows are links, so a modifier click opens a tab. */
  onNavigate: (path: string) => void;
  initiativeDetails?:
    Readonly<Record<string, LoadState<InitiativeRead | null>>> | undefined;
  projects?: readonly ProjectRecord[];
  selectedProjectId?: string | null | undefined;
  density?: RowDensity;
  worktrees?: InitiativeBrowserWorktrees | undefined;
  sessions?: InitiativeBrowserSessions | undefined;
  /** Present when this host offers inline membership browsing. */
  onLoadDetail?: (id: string, collapsed?: readonly string[]) => void;
  /** Stable: pin an open row's graph read (`retainInitiativeDetail`). */
  onRetainDetail?: (id: string) => () => void;
}) {
  const open = useMemo(
    () => initiatives.filter((initiative) => initiative.state !== "done"),
    [initiatives],
  );
  const progressCountChars = useMemo(
    () =>
      Math.max(
        9,
        ...open.map((initiative) => {
          const detailState = initiativeDetails?.[initiative.id];
          const read = detailState ? dataOf(detailState) : undefined;
          if (read) {
            const counts = initiativeBrowserCounts(read.item.nodes);
            return `${counts.startable}/${counts.doing}/${counts.blocked}/${counts.done}/${counts.total}`
              .length;
          }
          // Until the graph answers, these summary facts bound each column's width;
          // they must not be presented as a mutually exclusive partition themselves.
          const { progress } = initiative;
          return `${progress.startable}/${progress.doing}/${progress.blocked}/${progress.total}/${progress.total}`
            .length;
        }),
      ),
    [open, initiativeDetails],
  );
  return (
    <ListGroupSection
      id="initiatives"
      title="Initiatives"
      count={fresh || open.length > 0 ? open.length : undefined}
      icon={<Waypoints size={14} className="shrink-0" aria-hidden />}
      containsSelected={open.some((initiative) => initiative.id === selectedId)}
      actions={
        refreshing ? (
          <RefreshIndicator label="Refreshing Initiatives" />
        ) : undefined
      }
    >
      {error ? (
        <ErrorNote className="mx-2 my-1" message={error} onRetry={onRetry} />
      ) : null}
      {error && initiatives.length === 0 ? null : !fresh &&
        !refreshing &&
        initiatives.length === 0 ? (
        <div role="status" aria-label="Loading Initiatives" className="px-2.5">
          <Skeleton className="h-6 w-3/4" />
        </div>
      ) : (
        <ul className="flex flex-col">
          {open.map((initiative) => (
            <InitiativeBrowserRow
              key={initiative.id}
              initiative={initiative}
              detailState={initiativeDetails?.[initiative.id]}
              projects={projects}
              selected={initiative.id === selectedId}
              selectedProjectId={selectedProjectId}
              density={density}
              progressCountChars={progressCountChars}
              worktrees={worktrees}
              sessions={sessions}
              onLoadDetail={onLoadDetail}
              onRetainDetail={onRetainDetail}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </ListGroupSection>
  );
});
