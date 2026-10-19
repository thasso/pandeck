/**
 * Session approval grants: "Approve for session" on an approval card records
 * each OPERATION the card performs as pre-approved for the rest of that
 * session. A later card whose operations are all granted still renders, but
 * runs without waiting for a click.
 *
 * Grants usually cover operations, not targets: "Jira: comment" covers a
 * comment on any issue. Git tag publication is the exception: its grant binds
 * checkout, destination, tag and commit so one approved tag cannot authorize
 * another. Batch cards (Jira, Confluence, Tempo) need every operation they mix
 * to be granted before they run on their own.
 */
import type { ApprovalBody } from "./protocol.ts";

/** One operation the user pre-approved for the rest of a session. */
export interface ApprovalGrant {
  /** Stable operation key, from {@link approvalGrantKeys}. */
  key: string;
  /** When the user granted it. */
  grantedAt: number;
  /**
   * The card whose "Approve for session" created it — or "" when the user
   * granted it from the session inspector, before any card asked.
   */
  sourceApprovalId: string;
}

/**
 * A grant a spawned session inherits: held by `heldBy`, the nearest session up
 * its spawn chain that holds the key. Nothing is copied, so it is revoked
 * only on `heldBy`.
 */
export interface InheritedApprovalGrant extends ApprovalGrant {
  heldBy: string;
}

/** Whether a spawned session inherits grants through its spawn edge. */
export interface ApprovalGrantInheritance {
  parentSessionId: string;
  inherits: boolean;
}

/** One operation a session can be granted, as the inspector lists it. */
export interface GrantableOperation {
  key: string;
  /** What the operation is, in the user's words ("GitHub: open pull requests"). */
  label: string;
  /** What a grant lets the agent do without asking, in one sentence. */
  covers: string;
  /**
   * Approved only on its own card, never ahead of time: the operations
   * hardest to undo (a merge into the default branch, a deleted branch, a
   * published release, deleted pages).
   */
  cardOnly: boolean;
}

const op = (
  key: string,
  label: string,
  covers: string,
  cardOnly = false,
): GrantableOperation => ({ key, label, covers, cardOnly });

/**
 * Every operation an approval card in production can ask for that a session
 * grant may cover, in the inspector's order. Tag publishing is absent on
 * purpose: its key names one tag and commit, so it is only ever granted from
 * its card; settings input and commit review overrides are never grantable at
 * all.
 */
export const GRANTABLE_OPERATIONS: readonly GrantableOperation[] = [
  op(
    "github:create",
    "GitHub: open pull requests",
    "Open pull requests on any repository and branch. A managed worktree opens its own without asking.",
  ),
  op(
    "github:edit",
    "GitHub: edit pull requests",
    "Change a pull request's title, description or base branch.",
  ),
  op(
    "github:ready",
    "GitHub: mark pull requests ready",
    "Take any draft pull request out of draft. A managed worktree readies its own without asking.",
  ),
  op(
    "github:review",
    "GitHub: review pull requests",
    "Submit reviews: comments, approvals or change requests.",
  ),
  op(
    "github:comment",
    "GitHub: comment on pull requests",
    "Post comments on pull requests and resolve or reopen review threads.",
  ),
  op(
    "github:assign",
    "GitHub: assign pull requests",
    "Set a pull request's assignees.",
  ),
  op("githubIssue:create", "GitHub: open issues", "Open new issues."),
  op(
    "githubIssue:edit",
    "GitHub: edit issues",
    "Change an issue's title, body, state or assignees.",
  ),
  op(
    "githubIssue:comment",
    "GitHub: comment on issues",
    "Post comments on issues and pull requests.",
  ),
  op(
    "githubIssue:label",
    "GitHub: label issues",
    "Add or remove labels on issues and pull requests.",
  ),
  op(
    "forgejo:create",
    "Forgejo: open pull requests",
    "Open pull requests on any repository and branch. A managed worktree opens its own without asking.",
  ),
  op(
    "forgejo:edit",
    "Forgejo: edit pull requests",
    "Change a pull request's title, description or base branch.",
  ),
  op(
    "forgejo:ready",
    "Forgejo: mark pull requests ready",
    "Take any draft pull request out of draft. A managed worktree readies its own without asking.",
  ),
  op(
    "forgejo:review",
    "Forgejo: review pull requests",
    "Submit reviews: comments, approvals or change requests.",
  ),
  op(
    "forgejo:comment",
    "Forgejo: comment on pull requests",
    "Post comments on pull requests.",
  ),
  op("jira:create", "Jira: create issues", "Create new Jira issues."),
  op("jira:edit", "Jira: edit issues", "Change fields of existing issues."),
  op("jira:comment", "Jira: comment on issues", "Post comments on issues."),
  op("jira:rank", "Jira: reorder issues", "Change where issues rank."),
  op(
    "jira:sprint",
    "Jira: edit sprints",
    "Change a sprint's name, dates or goal.",
  ),
  op("confluence:create", "Confluence: create pages", "Create new pages."),
  op("confluence:edit", "Confluence: edit pages", "Change existing pages."),
  op(
    "confluence:comment",
    "Confluence: comment on pages",
    "Post comments on pages.",
  ),
  op(
    "confluence:uploadAttachment",
    "Confluence: upload attachments",
    "Attach files to pages.",
  ),
  op("tempo:create", "Tempo: log work", "Add new worklogs."),
  op("tempo:update", "Tempo: change logged work", "Change existing worklogs."),
  op(
    "sessionSpawn",
    "Start peer sessions",
    "Start new agent sessions, each with its own model usage.",
  ),
  op(
    "projectCreate",
    "Create projects",
    "Add projects to the registry and clone their repositories.",
  ),
  op(
    "agentDefinition",
    "Agents: create, or change persona, model or effort",
    "Create agent definitions and change the persona they run as (a developer gets Bash, Edit and Write) or the model and effort they run on.",
  ),
  op(
    "gmailArchive",
    "Gmail: archive mail",
    "Archive the messages a card lists.",
  ),
  op(
    "managedPullRequestMerge",
    "Merge into the default branch",
    "Merge a managed worktree's pull request into the repository's default branch. Merging into any other branch never asks.",
    true,
  ),
  op(
    "githubBranchDelete",
    "GitHub: delete branches",
    "Delete remote branches (never the default or protected ones).",
    true,
  ),
  op(
    "forgejoRelease",
    "Forgejo: publish releases",
    "Publish a release and its tag at a pinned commit.",
    true,
  ),
  op("confluence:delete", "Confluence: delete pages", "Delete pages.", true),
  op(
    "confluence:deleteAttachment",
    "Confluence: delete attachments",
    "Delete files attached to pages.",
    true,
  ),
];

/** Whether the inspector may grant `key` before any card asked for it. */
export function grantableAheadOfTime(key: string): boolean {
  return GRANTABLE_OPERATIONS.some(
    (operation) => operation.key === key && !operation.cardOnly,
  );
}

/** The operation keys a card performs, deduplicated and sorted. */
export function approvalGrantKeys(body: ApprovalBody): string[] {
  const keys = new Set<string>();
  switch (body.kind) {
    case "githubPullRequest":
      keys.add(
        `github:${body.operation === "resolveThread" ? "comment" : body.operation}`,
      );
      break;
    case "githubIssue":
      keys.add(`githubIssue:${body.operation}`);
      break;
    case "forgejoPullRequest":
      keys.add(`forgejo:${body.operation}`);
      break;
    case "gitTag":
      // An approval for one tag must never authorize a different tag, commit,
      // or repository even when the user selects "Approve for session".
      keys.add(
        `gitTag:${body.repoPath}:${body.remote}:${body.branch}:${body.pushUrlFingerprint}:${body.tag}:${body.targetSha}`,
      );
      break;
    case "jiraIssue":
      for (const item of body.items)
        keys.add(`jira:${item.operation ?? "edit"}`);
      break;
    case "confluencePage":
      for (const item of body.items) keys.add(`confluence:${item.operation}`);
      break;
    case "tempoWorklog":
      for (const item of body.items) keys.add(`tempo:${item.action}`);
      break;
    case "settingsInput":
      // Never granted: only the user can type the secret or connect the
      // account, so no earlier decision may answer a later card.
      break;
    case "managedCommitOverride":
      // Never granted: overriding a blocked commit review answers those exact
      // findings, so no earlier override may answer a later one.
      break;
    default:
      keys.add(body.kind);
  }
  return [...keys].sort();
}

const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub PR",
  githubIssue: "GitHub issue",
  forgejo: "Forgejo PR",
  jira: "Jira",
  confluence: "Confluence",
  tempo: "Tempo",
};

const KIND_LABELS: Record<string, string> = {
  forgejoRelease: "Forgejo: publish release",
  githubBranchDelete: "GitHub: delete branch",
  gmailArchive: "Gmail: archive",
  commit: "Commit",
  sessionSpawn: "Start peer sessions",
  managedPullRequestMerge: "Merge into default branch",
  projectCreate: "Create project",
  agentDefinition: "Agent definition",
};

/** A short human name for a grant key, e.g. "Jira: comment". */
export function approvalGrantLabel(key: string): string {
  const listed = GRANTABLE_OPERATIONS.find(
    (operation) => operation.key === key,
  );
  if (listed) return listed.label;
  const kindLabel = KIND_LABELS[key];
  if (kindLabel) return kindLabel;
  if (key.startsWith("gitTag:"))
    return `Publish tag ${key.split(":").at(-2) ?? ""}`;
  const [provider, operation] = key.split(":");
  if (!provider || !operation) return key;
  return `${PROVIDER_LABELS[provider] ?? provider}: ${operation}`;
}
