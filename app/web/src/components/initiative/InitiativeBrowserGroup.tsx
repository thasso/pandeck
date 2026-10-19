import { memo } from "react";
import { Waypoints } from "lucide-react";
import type { InitiativeSummary } from "@assistant/shared";
import { ListRow } from "../common/ListRow.tsx";
import { ErrorNote, RefreshIndicator, Skeleton } from "../common/load.tsx";
import { ListGroupSection } from "../ListGroupSection.tsx";
import { initiativePath } from "../../hooks/useSessionRouting.ts";
import { followRowLink } from "../../lib/rowLink.ts";

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
}) {
  const open = initiatives.filter((initiative) => initiative.state !== "done");
  return (
    <ListGroupSection
      id="initiatives"
      title="Initiatives"
      count={fresh || open.length > 0 ? open.length : undefined}
      icon={<Waypoints size={14} className="shrink-0" aria-hidden />}
      containsSelected={open.some((initiative) => initiative.id === selectedId)}
      actions={
        refreshing ? <RefreshIndicator label="Refreshing Initiatives" /> : undefined
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
          {open.map((initiative) => {
            const href = initiativePath(initiative.id);
            const selected = initiative.id === selectedId;
            return (
              <li key={initiative.id}>
                <ListRow
                  interaction="content"
                  active={selected}
                  aria-current={selected ? "page" : undefined}
                  rowProps={{ "data-list-row-id": `initiative:${initiative.id}` }}
                  render={
                    <a
                      href={href}
                      onClick={(event) =>
                        followRowLink(event, href, onNavigate)
                      }
                    />
                  }
                  title={initiative.title}
                  contextTrailing={
                    <span className="tabular-nums">
                      {initiative.state === "paused" ? (
                        "Paused"
                      ) : (
                        <>
                          {initiative.progress.done}/{initiative.progress.total}
                          <span className="sr-only"> done</span>
                        </>
                      )}
                    </span>
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </ListGroupSection>
  );
});
