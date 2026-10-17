import type { TaskInitiativeRef } from "@assistant/shared";
import { Badge } from "./ui/badge.tsx";
import { Item, ItemContent, ItemDescription, ItemTitle } from "./ui/item.tsx";
import { initiativePath } from "../hooks/useSessionRouting.ts";
import {
  INITIATIVE_STATE_BADGE,
  INITIATIVE_STATE_LABEL,
} from "../lib/initiativeView.ts";
import { followRowLink } from "../lib/rowLink.ts";

/**
 * @component TaskInitiativeList
 * @purpose The Initiatives holding a Task, each a link to its page
 *   (`pa://initiative/<n>`'s route) with its state chip, and, when the Task
 *   belongs through an ancestor, which one.
 * @useWhen A full Task's `initiatives` (`getTask`): the Task page and the Task
 *   inspector. Summaries never carry them.
 * @avoidWhen Changing membership: agents manage it (`initiative_manage`), so
 *   this is read-only.
 * @intent The ancestor is named by its Task id badge and title. `taskTitle`
 *   supplies the live title from the Backlog when it holds the Task, so a
 *   rename shows before the body is read again.
 */
export function TaskInitiativeList({
  initiatives,
  onNavigate,
  taskTitle,
}: {
  initiatives: readonly TaskInitiativeRef[];
  onNavigate?: ((path: string) => void) | undefined;
  taskTitle?: ((id: string) => string | undefined) | undefined;
}) {
  return (
    <ul className="flex flex-col">
      {initiatives.map((initiative) => {
        const href = initiativePath(initiative.id);
        const through = initiative.through;
        return (
          <li key={initiative.id}>
            <Item
              size="xs"
              render={
                <a
                  href={href}
                  onClick={(event) => followRowLink(event, href, onNavigate)}
                />
              }
            >
              <ItemContent className="min-w-0">
                <ItemTitle className="w-full min-w-0">
                  <span className="truncate">{initiative.title}</span>
                </ItemTitle>
                {through ? (
                  <ItemDescription className="line-clamp-1">
                    Through <span className="font-mono">#{through.id}</span>{" "}
                    {taskTitle?.(through.id) ?? through.title}
                  </ItemDescription>
                ) : null}
              </ItemContent>
              <Badge variant={INITIATIVE_STATE_BADGE[initiative.state]}>
                {INITIATIVE_STATE_LABEL[initiative.state]}
              </Badge>
            </Item>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * @component TaskInitiativesSection
 * @purpose The Task page's Initiatives group, beside its links.
 * @intent Says nothing when there is nothing to say: a Task no live
 *   Initiative holds renders no section.
 */
export function TaskInitiativesSection({
  initiatives,
  onNavigate,
  taskTitle,
}: {
  initiatives: readonly TaskInitiativeRef[] | undefined;
  onNavigate?: ((path: string) => void) | undefined;
  taskTitle?: ((id: string) => string | undefined) | undefined;
}) {
  if (!initiatives?.length) return null;
  return (
    <section aria-label="Initiatives" className="mb-6">
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        Initiatives
      </p>
      <TaskInitiativeList
        initiatives={initiatives}
        onNavigate={onNavigate}
        taskTitle={taskTitle}
      />
    </section>
  );
}
