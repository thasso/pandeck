import type { InitiativeSummary } from "@assistant/shared";
import { InspectorSection } from "../shell/Inspector.tsx";
import { INITIATIVE_STATE_LABEL } from "../../lib/initiativeView.ts";
import { InitiativeProgressLine } from "./InitiativeProgressLine.tsx";

/**
 * @component InitiativeInspectorSummary
 * @purpose The object panel's summary of an Initiative while no Task on its
 *   page is selected: state, progress and how many sessions work on it.
 * @useWhen The Initiative route's inspector.
 * @intent Read-only, like the page: the panel offers no Initiative action,
 *   because agents manage Initiatives and the user's one write (Settle) is
 *   the inbox card's.
 */
export function InitiativeInspectorSummary({
  summary,
}: {
  summary: InitiativeSummary | undefined;
}) {
  return (
    <InspectorSection
      id="initiative-summary"
      title="Initiative"
      collapsible={false}
      forceOpen
    >
      {summary ? (
        <div className="flex flex-col gap-2 px-1 text-sm">
          <p className="font-medium break-words">{summary.title}</p>
          <p className="text-xs text-muted-foreground">
            {INITIATIVE_STATE_LABEL[summary.state]}
            {summary.sessionCount > 0
              ? `, ${summary.sessionCount} ${
                  summary.sessionCount === 1 ? "session" : "sessions"
                } on its Tasks`
              : ""}
          </p>
          <InitiativeProgressLine progress={summary.progress} />
          <p className="text-xs text-muted-foreground">
            Select a Task on the map or in the list to see it here.
          </p>
        </div>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">
          This Initiative is not in the live list: it is archived, deleted or
          still loading.
        </p>
      )}
    </InspectorSection>
  );
}
