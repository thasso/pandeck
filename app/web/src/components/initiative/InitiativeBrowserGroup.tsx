import { memo } from "react";
import { Waypoints } from "lucide-react";
import type { InitiativeSummary } from "@assistant/shared";
import { Item } from "../ui/item.tsx";
import { Skeleton } from "../common/load.tsx";
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
 *   done ones and the grouping by state live on the index its heading opens.
 *   With nothing to list it shows the heading alone, so the index stays one
 *   tap away without spending rows on an empty state.
 */
export const InitiativeBrowserGroup = memo(function InitiativeBrowserGroup({
  initiatives,
  fresh,
  selectedId,
  onNavigate,
}: {
  initiatives: readonly InitiativeSummary[];
  /** A snapshot answered during this socket episode. */
  fresh: boolean;
  selectedId: string | null;
  /** Stable host navigation; rows are links, so a modifier click opens a tab. */
  onNavigate: (path: string) => void;
}) {
  const open = initiatives.filter((initiative) => initiative.state !== "done");
  return (
    <section aria-label="Initiatives" className="mb-2 flex flex-col">
      <Item
        size="xs"
        className="text-muted-foreground"
        render={
          <a
            href={INITIATIVES_PATH}
            onClick={(event) =>
              followRowLink(event, INITIATIVES_PATH, onNavigate)
            }
          />
        }
      >
        <Waypoints size={14} aria-hidden />
        <span className="flex-1 text-xs font-medium">Initiatives</span>
      </Item>
      {!fresh && initiatives.length === 0 ? (
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
    </section>
  );
});
