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
  /** The card whose "Approve for session" created it. */
  sourceApprovalId: string;
}

/** The operation keys a card performs, deduplicated and sorted. */
export function approvalGrantKeys(body: ApprovalBody): string[] {
  const keys = new Set<string>();
  switch (body.kind) {
    case "githubPullRequest":
      keys.add(`github:${body.operation}`);
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
};

/** A short human name for a grant key, e.g. "Jira: comment". */
export function approvalGrantLabel(key: string): string {
  const kindLabel = KIND_LABELS[key];
  if (kindLabel) return kindLabel;
  if (key.startsWith("gitTag:"))
    return `Publish tag ${key.split(":").at(-2) ?? ""}`;
  const [provider, operation] = key.split(":");
  if (!provider || !operation) return key;
  return `${PROVIDER_LABELS[provider] ?? provider}: ${operation}`;
}
