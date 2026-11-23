/**
 * The closed structural check of a `jira_mutate_issue` proposal (Task-1463
 * P6a, P6-F2): what an edge's `tools.prepare` answers and what its
 * `tools.apply` takes back. Every key of the item and of each nested type has
 * a rule (`mutationCheckRules.ts`); pure result fields
 * (`jiraMutationResult.ts`) are refused, and a create item carries exactly
 * `issueKey: ""`, the key it gets only once Jira made it. It checks shape,
 * not meaning: the executor keeps its own guards.
 *
 * Boundary-clean: only the shared types and the rule kit
 * (`workerBoundary.test.ts`).
 */
import type {
  JiraIssueLinkChangeDisplay,
  JiraIssueMutationFieldChangeDisplay,
  JiraIssueMutationItemDisplay,
  JiraIssueMutationOperation,
  JiraIssueRankPosition,
  JiraIssueRankScopeDisplay,
  JiraIssueRankStepDisplay,
  JiraSprintChangeDisplay,
  JiraSprintField,
  JiraSprintUpdateDisplay,
} from "@assistant/shared/jiraMutation";
import {
  arrayOf,
  bool,
  checkProposal,
  closed,
  count,
  literal,
  nullable,
  oneOf,
  opt,
  plainJson,
  req,
  result,
  str,
  strOrNull,
  variants,
  type Check,
  type RuleTable,
} from "./mutationCheckRules.ts";

const operation = oneOf<JiraIssueMutationOperation>()([
  "edit",
  "create",
  "comment",
  "rank",
  "sprint",
]);
const rankPosition = oneOf<JiraIssueRankPosition>()([
  "before",
  "after",
  "top",
  "bottom",
]);
const stepPlacement = oneOf<JiraIssueRankStepDisplay["placement"]>()([
  "before",
  "after",
]);
const linkOp = oneOf<JiraIssueLinkChangeDisplay["op"]>()(["add", "remove"]);
const linkDirection = oneOf<JiraIssueLinkChangeDisplay["direction"]>()([
  "inward",
  "outward",
]);
const sprintField = oneOf<JiraSprintField>()([
  "name",
  "startDate",
  "endDate",
  "goal",
]);

export const JIRA_FIELD_CHANGE_RULES = {
  fieldId: req(str),
  label: req(str),
  from: opt(strOrNull),
  to: opt(strOrNull),
  operation: opt(strOrNull),
  // The only `unknown` field of the Jira item types: sent to Jira as it is.
  value: opt(plainJson),
} satisfies RuleTable<JiraIssueMutationFieldChangeDisplay>;

export const JIRA_LINK_CHANGE_RULES = {
  op: req(linkOp),
  type: req(str),
  direction: req(linkDirection),
  relationship: req(str),
  targetIssueKey: req(str),
  targetIssueUrl: opt(strOrNull),
  linkId: opt(strOrNull),
  resultOk: result,
  error: result,
} satisfies RuleTable<JiraIssueLinkChangeDisplay>;

export const JIRA_RANK_STEP_RULES = {
  issueKey: req(str),
  placement: req(stepPlacement),
  relativeToIssueKey: req(str),
  resultOk: result,
  error: result,
} satisfies RuleTable<JiraIssueRankStepDisplay>;

const rankScope = variants<JiraIssueRankScopeDisplay, "kind">("kind", {
  board: { kind: req(literal("board")), boardId: req(count), epics: req(bool) },
  parent: { kind: req(literal("parent")), parentIssueKey: req(str) },
});

const sprintChange = closed<JiraSprintChangeDisplay>({
  field: req(sprintField),
  from: req(strOrNull),
  to: req(strOrNull),
});

export const JIRA_SPRINT_RULES = {
  sprintId: req(count),
  name: req(str),
  state: req(str),
  boardId: opt(nullable(count)),
  changes: req(arrayOf(sprintChange)),
  result,
} satisfies RuleTable<JiraSprintUpdateDisplay>;

export const JIRA_ITEM_RULES = {
  clientId: req(str),
  issueKey: req(str),
  operation: opt(operation),
  issueId: opt(strOrNull),
  issueUrl: opt(strOrNull),
  issueSummary: opt(strOrNull),
  currentStatus: opt(strOrNull),
  targetTransitionId: opt(strOrNull),
  targetTransitionName: opt(strOrNull),
  targetStatus: opt(strOrNull),
  fieldChanges: req(
    arrayOf(
      closed<JiraIssueMutationFieldChangeDisplay>(JIRA_FIELD_CHANGE_RULES),
    ),
  ),
  linkChanges: opt(
    arrayOf(closed<JiraIssueLinkChangeDisplay>(JIRA_LINK_CHANGE_RULES)),
  ),
  createProjectKey: opt(str),
  createIssueType: opt(str),
  createSummary: opt(str),
  createDescription: opt(str),
  createParentIssue: opt(str),
  commentBody: opt(str),
  rankIssueKeys: opt(arrayOf(str)),
  rankPosition: opt(rankPosition),
  rankTargetIssueKey: opt(strOrNull),
  rankScope: opt(rankScope),
  rankSteps: opt(
    arrayOf(closed<JiraIssueRankStepDisplay>(JIRA_RANK_STEP_RULES)),
  ),
  rankResultOrder: result,
  sprint: opt(closed<JiraSprintUpdateDisplay>(JIRA_SPRINT_RULES)),
  resultIssueKey: result,
  resultIssueUrl: result,
  warning: result,
  error: result,
} satisfies RuleTable<JiraIssueMutationItemDisplay>;

const closedItem = closed<JiraIssueMutationItemDisplay>(JIRA_ITEM_RULES);

/** One item: closed, and a create's key still the empty one. */
const jiraItem: Check<JiraIssueMutationItemDisplay> = (
  value,
  depth,
): value is JiraIssueMutationItemDisplay =>
  closedItem(value, depth) &&
  (value.operation !== "create" || value.issueKey === "");

/** Whether `value` is a `jira_mutate_issue` proposal (1 to 10 items). */
export function checkJiraIssueItems(
  value: unknown,
): value is JiraIssueMutationItemDisplay[] {
  return checkProposal(value, jiraItem);
}
