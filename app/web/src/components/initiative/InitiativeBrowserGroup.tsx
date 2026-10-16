import { memo } from "react";
import { ArrowRight, Waypoints } from "lucide-react";
import type { InitiativeSummary } from "@assistant/shared";
import { Item } from "../ui/item.tsx";
import { ErrorNote, Skeleton } from "../common/load.tsx";
import { LinkButton } from "../common/LinkButton.tsx";
import { ListGroupSection } from "../ListGroupSection.tsx";
import {
  initiativePath,
  INITIATIVES_PATH,
} from "../../hooks/useSessionRouting.ts";
import { followRowLink } from "../../lib/rowLink.ts";

/**
 * @component InitiativeBrowserGroup
 * @purpose The Initiatives group at the top of the Projects browser, the
 *   canonical sidebar location of an Initiative (`app/web/docs/ui-shell.md`).
 * @useWhen The Projects section's browser, above the Project tree.
 * @intent Bounded: it lists the active and paused Initiatives, which are few;
 *   done ones and the grouping by state live on the index. It is the sidebar's
 *   one group band (`ListGroupSection`): its heading folds the rows like every
 *   other group, and the index is a link of its own beside it, so a modifier
 *   click opens it in a new tab. With nothing to list it shows the band alone,
 *   so the index stays one tap away without spending rows on an empty state.
 */
export const InitiativeBrowserGroup = memo(function InitiativeBrowserGroup({
  initiatives,
  fresh,
  error,
  onRetry,
  selectedId,
  onNavigate,
}: {
  initiatives: readonly InitiativeSummary[];
  /** A snapshot answered during this socket episode. */
  fresh: boolean;
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
        <LinkButton
          variant="ghost"
          size="icon-xs"
          label="Show all Initiatives"
          href={INITIATIVES_PATH}
          onClick={(event) =>
            followRowLink(event, INITIATIVES_PATH, onNavigate)
          }
        >
          <ArrowRight />
        </LinkButton>
      }
    >
      {error ? (
        <ErrorNote className="mx-2 my-1" message={error} onRetry={onRetry} />
      ) : null}
      {error && initiatives.length === 0 ? null : !fresh &&
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
              <li
                key={initiative.id}
                data-list-row-id={`initiative:${initiative.id}`}
              >
                <Item
                  size="xs"
                  variant={selected ? "muted" : "default"}
                  aria-current={selected ? "page" : undefined}
                  render={
                    <a
                      href={href}
                      onClick={(event) =>
                        followRowLink(event, href, onNavigate)
                      }
                    />
                  }
                >
                  <span className="min-w-0 flex-1 truncate pl-5">
                    {initiative.title}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {initiative.state === "paused" ? (
                      "Paused"
                    ) : (
                      <>
                        {initiative.progress.done}/{initiative.progress.total}
                        <span className="sr-only"> done</span>
                      </>
                    )}
                  </span>
                </Item>
              </li>
            );
          })}
        </ul>
      )}
    </ListGroupSection>
  );
});
