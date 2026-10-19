import { memo, useState } from "react";
import type { SessionListItem } from "@assistant/shared";
import { sessionPath } from "../../lib/sessionRoutes.ts";
import { followRowLink } from "../../lib/rowLink.ts";
import type { RowDensity } from "../../lib/rowDensity.ts";
import { ListExpansionRow } from "../common/ListExpansionRow.tsx";
import { ListRow } from "../common/ListRow.tsx";
import { SessionRowContent } from "../SessionRow.tsx";
import { INITIAL_SESSION_LIMIT } from "../worktreeRowParts.tsx";

/** Direct or unplaced Initiative sessions, without lifecycle actions. */
export const InitiativeSessionRows = memo(function InitiativeSessionRows({
  sessions,
  scopeId,
  currentId,
  density,
  onNavigate,
}: {
  sessions: readonly SessionListItem[];
  scopeId: string;
  currentId: string | null;
  density: RowDensity;
  onNavigate: (path: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? sessions : sessions.slice(0, INITIAL_SESSION_LIMIT);
  const remaining = sessions.length - visible.length;
  return (
    <>
      {visible.map((session) => {
        const href = sessionPath(session.id);
        const active = session.id === currentId;
        return (
          <ListRow
            key={session.id}
            interaction="content"
            divider={false}
            density={density}
            active={active}
            data-list-row-id={`${scopeId}:session:${session.id}`}
            render={
              <a
                href={href}
                onClick={(event) => followRowLink(event, href, onNavigate)}
              />
            }
          >
            <SessionRowContent
              session={session}
              density={density}
              unread={active ? false : undefined}
            />
          </ListRow>
        );
      })}
      {remaining > 0 ? (
        <ListExpansionRow
          rowId={`${scopeId}:more-sessions`}
          label="Show more sessions"
          count={remaining}
          expanded={false}
          density={density}
          tabbable
          onToggle={() => setShowAll(true)}
        />
      ) : null}
    </>
  );
});
