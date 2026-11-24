/**
 * The proposal-side text of a Jira write card: its title, its summary and the
 * tool text that points the agent at it. The local `jira_mutate_issue` uses it
 * today, and the client-mode gateway write tool will use it so both raise the
 * same card (Task-1463 P6b). A leaf: shared types, the card reference and the
 * sprint label only, never the tool modules or the catalog.
 * `jiraMutationOracle.test.ts` pins every string byte for byte.
 */
import type {
  ApprovalCard,
  JiraIssueMutationItemDisplay,
} from "@assistant/shared";
import { approvalCardReference } from "../../pendingApprovals.ts";
import { jiraSprintItemLabel } from "../../jiraSprint.ts";

/** The tool's label, local and on the gateway. */
export const JIRA_MUTATE_ISSUE_LABEL = "Jira: Prepare Issue Changes";

/** Short human label for one mutation item (edit/create/comment). */
function jiraMutationItemLabel(item: JiraIssueMutationItemDisplay): string {
  if (item.operation === "create")
    return `create ${item.createProjectKey ?? "?"} ${item.createIssueType ?? ""}`.trim();
  if (item.operation === "comment") return `comment ${item.issueKey}`;
  if (item.operation === "rank")
    return `rank ${(item.rankIssueKeys ?? []).join(", ")} ${item.rankPosition ?? ""}`.trim();
  if (item.operation === "sprint") return jiraSprintItemLabel(item);
  return item.issueKey;
}

/** Approval-card title reflecting the mix of operations. */
export function jiraMutationTitle(
  items: JiraIssueMutationItemDisplay[],
): string {
  if (items.length === 1) {
    const item = items[0]!;
    if (item.operation === "create")
      return `Create ${item.createProjectKey ?? ""} issue`
        .replace(/\s+/g, " ")
        .trim();
    if (item.operation === "comment") return `Comment on ${item.issueKey}`;
    if (item.operation === "rank") {
      const count = item.rankIssueKeys?.length ?? 0;
      return count === 1
        ? `Rank ${item.rankIssueKeys?.[0]} ${item.rankPosition ?? ""}`.trim()
        : `Rank ${count} Jira issues`;
    }
    if (item.operation === "sprint")
      return `Edit sprint ${item.sprint?.name ?? ""}`.trim();
    return `Edit ${item.issueKey}`;
  }
  const kinds = new Set(items.map((item) => item.operation ?? "edit"));
  if (kinds.size === 1) {
    const only = [...kinds][0];
    if (only === "create") return `Create ${items.length} Jira issues`;
    if (only === "comment") return `Comment on ${items.length} Jira issues`;
    if (only === "rank") return `Rank ${items.length} Jira backlogs`;
    if (only === "sprint") return `Edit ${items.length} Jira sprints`;
  }
  return `${items.length} Jira changes`;
}

/** The card summary: each item's label, then the warning count; "" when neither. */
export function jiraProposalSummary(
  items: JiraIssueMutationItemDisplay[],
  warnings: readonly string[],
): string {
  return [
    items.map(jiraMutationItemLabel).join(", "),
    warnings.length ? `${warnings.length} warning(s)` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The tool text for a proposed card: the count, the warnings and the card link. */
export function jiraProposalText(
  items: JiraIssueMutationItemDisplay[],
  warnings: readonly string[],
  card: ApprovalCard,
): string {
  const warnLine = warnings.length ? ` Warnings: ${warnings.join("; ")}.` : "";
  return `Prepared a Jira edit proposal for ${items.length} issue(s) pending your approval.${warnLine} Do not claim Jira changed until the approved result appears. ${approvalCardReference(card)}`;
}
