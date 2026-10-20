import type { PullRequestReadiness } from "./tools/pullRequestCheckWatch.ts";

export type ManagedFinishRefusalKind =
  | "not-open"
  | "no-pull-request"
  | "ambiguous"
  | "other-number"
  | "head-moved"
  | "branches-changed"
  | "default-branch-changed"
  | "repository-changed"
  | "worktree-changed"
  | "draft"
  | "conflict"
  | "not-ready";

export interface ManagedFinishObserved {
  number?: number;
  state?: string;
  merged?: boolean;
  headSha?: string;
  headBranch?: string;
  baseBranch?: string;
  defaultBranch?: string;
  decidedDefaultBranch?: string;
}

export class WorktreeBusyError extends Error {
  constructor() {
    super(
      "Another session is running or starting in this worktree. Wait until it is idle before finishing its pull request.",
    );
  }
}

/** Deterministic pre-write refusal. Provider-write errors never use this type. */
export class ManagedFinishRefusedError extends Error {
  constructor(
    readonly kind: ManagedFinishRefusalKind,
    message: string,
    readonly observed?: ManagedFinishObserved,
    readonly readiness?: PullRequestReadiness,
  ) {
    super(message);
    this.name = "ManagedFinishRefusedError";
  }
}
