import { memo, useMemo } from "react";
import type { InitiativeGraphNode, InitiativeSummary, SessionListItem, WorkflowRunCard, WorkflowRunSummary, WorktreeRecord } from "@assistant/shared";
import { decodeBoolean, useSessionStorageState } from "../../hooks/useSessionStorageState.ts";
import { sessionPath } from "../../lib/sessionRoutes.ts";
import type { RowDensity } from "../../lib/rowDensity.ts";
import { followRowLink } from "../../lib/rowLink.ts";
import { ListExpansionRow } from "../common/ListExpansionRow.tsx";
import { ListRow } from "../common/ListRow.tsx";
import { SessionRowContent } from "../SessionRow.tsx";

export interface InitiativeBrowserSessions {
  items: readonly SessionListItem[];
  runs: readonly WorkflowRunSummary[] | null;
  cards: Readonly<Record<string, WorkflowRunCard>>;
  selectedId: string | null;
}

/** Positive relationship evidence only; a missing parent never becomes a root. */
export const InitiativeCoordinatorRows = memo(function InitiativeCoordinatorRows({
  initiative, members, worktrees, sessions, density, onNavigate,
}: {
  initiative: InitiativeSummary;
  members: readonly InitiativeGraphNode[];
  worktrees: readonly WorktreeRecord[];
  sessions: InitiativeBrowserSessions;
  density: RowDensity;
  onNavigate: (path: string) => void;
}) {
  const [expanded, setExpanded] = useSessionStorageState(
    `assistant.initiativeBrowser.coordinators.v1:${initiative.id}`, true, decodeBoolean,
  );
  const { roots, incomplete } = useMemo(() => {
    const byId = new Map(sessions.items.map((session) => [session.id, session]));
    const memberIds = new Set(members.map((member) => member.id));
    const related = new Set(initiative.sessionIds);
    // A parent remains a recorded coordinator after takeover. This identifies
    // provenance, not present ownership or authority over the child.
    const coordinators = new Set(sessions.items.flatMap((session) =>
      session.spawnedBySessionId ? [session.spawnedBySessionId] : [],
    ));
    for (const worktree of worktrees) {
      for (const id of worktree.sessionIds) related.add(id);
      if (worktree.createdBySessionId) related.add(worktree.createdBySessionId);
      for (const id of worktree.treeSessionIds ?? []) {
        related.add(id);
        // Only an ancestor, not merely the creator or a checkout holder.
        // These memberships come from the server, including archived peers.
        if (id !== worktree.createdBySessionId && !worktree.sessionIds.includes(id))
          coordinators.add(id);
      }
    }
    let incomplete = initiative.sessionCount > initiative.sessionIds.length;
    for (const run of sessions.runs ?? []) {
      if (!memberIds.has(run.taskId)) continue;
      const card = sessions.cards[run.id];
      if (!card) incomplete = true;
      if (card?.coordinatorSessionId) {
        related.add(card.coordinatorSessionId);
        coordinators.add(card.coordinatorSessionId);
      }
    }
    const roots = new Map<string, SessionListItem>();
    for (const id of related) {
      let current = byId.get(id);
      let coordinated = false;
      const seen = new Set<string>();
      while (current) {
        if (seen.has(current.id)) {
          incomplete = true;
          current = undefined;
          break;
        }
        seen.add(current.id);
        if (!current.spawnedBySessionId) break;
        const parent = byId.get(current.spawnedBySessionId);
        if (!parent) {
          incomplete = true;
          current = undefined;
          break;
        }
        coordinated = true;
        current = parent;
      }
      if (!current) {
        incomplete = true;
        continue;
      }
      if (coordinated || coordinators.has(current.id)) roots.set(current.id, current);
    }
    return { roots: [...roots.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)), incomplete };
  }, [initiative.sessionIds, initiative.sessionCount, members, worktrees, sessions]);

  if (roots.length === 0 && !incomplete) return null;
  return (
    <ListExpansionRow
      rowId={`initiative:${initiative.id}:coordinators`}
      label="Known coordinators"
      count={roots.length}
      accessibleLabel={`Known coordinating sessions for ${initiative.title}`}
      expanded={expanded}
      density={density}
      tabbable
      onToggle={() => setExpanded((open) => !open)}
    >
      <div className="pl-3">
        {roots.map((session) => {
          const href = sessionPath(session.id);
          const active = sessions.selectedId === session.id;
          return (
            <ListRow
              key={session.id}
              interaction="content"
              divider={false}
              density={density}
              active={active}
              ariaLabel={`Coordinating session: ${session.title}`}
              data-list-row-id={`initiative:${initiative.id}:coordinator:${session.id}`}
              render={<a href={href} onClick={(event) => followRowLink(event, href, onNavigate)} />}
            >
              <SessionRowContent session={session} density={density} unread={active ? false : undefined} />
            </ListRow>
          );
        })}
        {incomplete ? (
          <ListRow interaction="content" divider={false} density={density} identity={
            <span className="min-w-0 text-xs text-muted-foreground">Some related session details aren't loaded.</span>
          } />
        ) : null}
      </div>
    </ListExpansionRow>
  );
});
