/**
 * The Jira mutation display types (`jira_mutate_issue` proposals, approval
 * bodies and results). An import-free leaf so the server's shared mutation
 * core, which the gateway's edge may import, reaches them without the whole
 * wire model (Task-1463); `protocol.ts` re-exports them unchanged.
 */

export interface JiraIssueMutationFieldChangeDisplay {
  fieldId: string;
  label: string;
  from?: string | null;
  to?: string | null;
  operation?: string | null;
  /** Server-only execution value for Jira REST writes; not secret-bearing. */
  value?: unknown;
}

export interface JiraIssueLinkChangeDisplay {
  op: "add" | "remove";
  /** Link type name, e.g. "Blocks", "Duplicate", "Relates". */
  type: string;
  /** Direction from the subject issue: outward uses the type's outward phrase, inward the inward phrase. */
  direction: "inward" | "outward";
  /** Human-readable relationship phrase, e.g. "blocks" or "is blocked by". */
  relationship: string;
  /** The issue on the other end of the link. */
  targetIssueKey: string;
  targetIssueUrl?: string | null;
  /** Existing issue link id; required for op=remove. */
  linkId?: string | null;
  /** Execution outcome, populated after approval. */
  resultOk?: boolean;
  error?: string;
}

/** edit (default) = transition/field/link an existing issue; create = new issue; comment = add a comment; rank = reorder issues in a backlog; sprint = edit a sprint's name, dates or goal. */
export type JiraIssueMutationOperation =
  "edit" | "create" | "comment" | "rank" | "sprint";

/** The sprint properties a `sprint` item can change. */
export type JiraSprintField = "name" | "startDate" | "endDate" | "goal";

/** One sprint property's change; dates are ISO 8601 instants, null means unset. */
export interface JiraSprintChangeDisplay {
  field: JiraSprintField;
  from: string | null;
  to: string | null;
}

/**
 * A partial update of one Jira Agile sprint. A sprint is not an issue: its
 * name, dates and goal live on the board's sprint object, so only this item
 * reaches them. `name`, `state` and `boardId` describe the sprint as it was
 * when the proposal was staged.
 */
export interface JiraSprintUpdateDisplay {
  sprintId: number;
  name: string;
  /** Jira's sprint state: future, active or closed. */
  state: string;
  boardId?: number | null;
  changes: JiraSprintChangeDisplay[];
  /** The sprint as Jira returned it after execution. */
  result?: {
    name: string;
    startDate: string | null;
    endDate: string | null;
  };
}

/** Where a rank item places its issues: next to a named issue, or at an end of a bounded scope. */
export type JiraIssueRankPosition = "before" | "after" | "top" | "bottom";

/**
 * The bounded ordering a top/bottom rank takes its anchor from. Jira has no
 * "move to top" call, so an end position only means something inside a scope
 * it can read in rank order.
 */
export type JiraIssueRankScopeDisplay =
  | {
      kind: "board";
      boardId: number;
      /** Board epics rank as their own list, separate from the backlog below them. */
      epics: boolean;
    }
  | { kind: "parent"; parentIssueKey: string };

/**
 * One Jira Agile rank call. A batch is expressed as a chain — the first issue
 * moves to the requested position, each later issue lands after its
 * predecessor — so a partially applied batch keeps the requested relative
 * order instead of reversing it.
 */
export interface JiraIssueRankStepDisplay {
  issueKey: string;
  placement: "before" | "after";
  /** The issue this step ranks against; a previous step's issue for chained steps. */
  relativeToIssueKey: string;
  /** Execution outcome, populated after approval. */
  resultOk?: boolean;
  error?: string;
}

export interface JiraIssueMutationItemDisplay {
  clientId: string;
  /** Empty for a create item until the issue is created; the new key lands in resultIssueKey. */
  issueKey: string;
  operation?: JiraIssueMutationOperation;
  issueId?: string | null;
  issueUrl?: string | null;
  issueSummary?: string | null;
  currentStatus?: string | null;
  targetTransitionId?: string | null;
  targetTransitionName?: string | null;
  targetStatus?: string | null;
  fieldChanges: JiraIssueMutationFieldChangeDisplay[];
  linkChanges?: JiraIssueLinkChangeDisplay[];
  /** create: the new issue's project key, issue type, summary, and optional description. */
  createProjectKey?: string;
  createIssueType?: string;
  createSummary?: string;
  /** CommonMark/GFM source converted to Atlassian Document Format when executed. */
  createDescription?: string;
  /** Parent issue for a new sub-task or other Jira issue type that accepts parent. */
  createParentIssue?: string;
  /** comment: the CommonMark/GFM body converted to ADF and posted on issueKey. */
  commentBody?: string;
  /** rank: the issues to move, in the order they should end up. */
  rankIssueKeys?: string[];
  rankPosition?: JiraIssueRankPosition;
  /** The issue the first ranked issue is placed against; resolved from the scope for top/bottom. */
  rankTargetIssueKey?: string | null;
  /** The bounded ordering a top/bottom request was resolved against. */
  rankScope?: JiraIssueRankScopeDisplay;
  /** The chained rank calls, applied in order on approval. */
  rankSteps?: JiraIssueRankStepDisplay[];
  /** Ordering observed in the scope after execution. */
  rankResultOrder?: string[];
  /** sprint: the sprint and the properties the item changes. */
  sprint?: JiraSprintUpdateDisplay;
  /** create result: the created issue key. */
  resultIssueKey?: string | null;
  resultIssueUrl?: string | null;
  /** Non-fatal partial-execution diagnostic, e.g. issue created but a requested link was denied. */
  warning?: string;
  error?: string;
}
