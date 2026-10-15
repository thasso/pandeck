import { Waypoints } from "lucide-react";
import type { InitiativeSummary } from "@assistant/shared";
import { PageHeader, type PageHeaderBack } from "../PageHeader.tsx";
import { Item, ItemContent, ItemTitle } from "../ui/item.tsx";
import {
  EmptyBox,
  ErrorNote,
  RefreshIndicator,
  Skeleton,
} from "../common/load.tsx";
import { useListScroll } from "../../hooks/useListScroll.ts";
import { initiativePath } from "../../hooks/useSessionRouting.ts";
import {
  INITIATIVE_STATE_LABEL,
  INITIATIVE_STATE_ORDER,
} from "../../lib/initiativeView.ts";
import { InitiativeProgressLine } from "./InitiativeProgressLine.tsx";

/**
 * @component InitiativesIndexPage
 * @purpose The Initiatives index (`/initiatives`): every live Initiative,
 *   grouped active, paused, done.
 * @useWhen The Initiative route without an id; the Projects browser's
 *   Initiatives group links here.
 * @intent The list is the `initiatives` topic itself. It is empty only once a
 *   snapshot this socket episode answered says so; an archived Initiative is
 *   not listed (it leaves the live projection) but its page still opens.
 */
export function InitiativesIndexPage({
  back,
  initiatives,
  fresh,
  error,
  onOpen,
}: {
  back?: PageHeaderBack | undefined;
  initiatives: readonly InitiativeSummary[];
  /** A snapshot answered during this socket episode. */
  fresh: boolean;
  error: string | null;
  onOpen: (path: string) => void;
}) {
  const scrollRef = useListScroll({ listKey: "initiatives" });
  const loading = !fresh && initiatives.length === 0 && !error;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PageHeader
        back={back}
        icon={<Waypoints size={16} />}
        title="Initiatives"
        subtitle="Work that spans Projects, by state"
        actions={
          !fresh && initiatives.length > 0 ? (
            <RefreshIndicator label="Refreshing Initiatives" />
          ) : undefined
        }
      />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {error ? <ErrorNote message={error} /> : null}
          {loading ? (
            <div role="status" className="flex flex-col gap-2">
              <span className="sr-only">Loading Initiatives…</span>
              {[0, 1, 2].map((row) => (
                <Skeleton key={row} className="h-16 w-full" />
              ))}
            </div>
          ) : fresh && initiatives.length === 0 ? (
            <EmptyBox>
              No Initiatives yet. Ask an agent to group the Tasks of a larger
              piece of work into one.
            </EmptyBox>
          ) : (
            INITIATIVE_STATE_ORDER.map((state) => {
              const group = initiatives
                .filter((initiative) => initiative.state === state)
                .sort((a, b) => b.updatedAt - a.updatedAt);
              if (group.length === 0) return null;
              return (
                <section
                  key={state}
                  aria-label={INITIATIVE_STATE_LABEL[state]}
                  className="flex flex-col gap-2"
                >
                  <h2 className="text-sm font-medium text-muted-foreground">
                    {INITIATIVE_STATE_LABEL[state]}
                  </h2>
                  <ul className="flex flex-col gap-2">
                    {group.map((initiative) => {
                      const href = initiativePath(initiative.id);
                      return (
                        <li
                          key={initiative.id}
                          data-list-row-id={initiative.id}
                        >
                          <Item
                            variant="outline"
                            render={
                              <a
                                href={href}
                                onClick={(event) => {
                                  if (
                                    event.metaKey ||
                                    event.ctrlKey ||
                                    event.shiftKey ||
                                    event.altKey
                                  )
                                    return;
                                  event.preventDefault();
                                  onOpen(href);
                                }}
                              />
                            }
                          >
                            <ItemContent>
                              <ItemTitle>{initiative.title}</ItemTitle>
                              <InitiativeProgressLine
                                progress={initiative.progress}
                              />
                            </ItemContent>
                          </Item>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
