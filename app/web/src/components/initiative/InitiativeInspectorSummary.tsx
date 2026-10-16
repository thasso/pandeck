import type { InitiativeSummary } from "@assistant/shared";
import { InspectorFacts, InspectorSection } from "../shell/Inspector.tsx";
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
        <div className="flex flex-col gap-2 text-sm">
          <p className="px-1 font-medium break-words">{summary.title}</p>
          <InspectorFacts
            facts={[
              { label: "State", value: INITIATIVE_STATE_LABEL[summary.state] },
              {
                label: "Progress",
                // Its bar and counts wrap within the value rather than run
                // out of a narrow panel.
                value: (
                  <span className="block whitespace-normal">
                    <InitiativeProgressLine progress={summary.progress} />
                  </span>
                ),
              },
              {
                label: "Sessions",
                value:
                  summary.sessionCount > 0
                    ? `${summary.sessionCount} on its Tasks`
                    : "None",
              },
            ]}
          />
          <p className="px-1 text-xs text-muted-foreground">
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
