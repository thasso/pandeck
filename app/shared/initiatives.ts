/**
 * Initiatives: the user's durable grouping of Tasks across Projects
 * (`docs/initiatives.md`). The summary rides the `initiatives` state topic; the
 * graph is detail, read by id with the revision it is as of.
 */
import type { TaskStatus } from "./protocol.ts";

export const INITIATIVE_STATES = ["active", "paused", "done"] as const;

/** Set explicitly, never derived from the member Tasks. */
export type InitiativeState = (typeof INITIATIVE_STATES)[number];

/**
 * Durable attention state for a paused or done Initiative, the same shape and
 * rules as `WorkflowRunAttention`. Present only once a revision was raised.
 */
export interface InitiativeAttention {
  /** Monotonic, one bump per meaningful state change. */
  revision: number;
  /** The revision an explicit Settle acknowledged; 0 when never settled. */
  settledRevision: number;
  kind: Exclude<InitiativeState, "active">;
  at: number;
}

/**
 * Where a member Task stands. Exclusive: `startable` and `blocked` split the
 * `todo` Tasks by whether one of their blockers is still open (neither done
 * nor archived). Computed on read, never stored.
 */
export type InitiativeTaskState = "done" | "doing" | "startable" | "blocked";

/** Member counts by {@link InitiativeTaskState}; they sum to `total`. */
export interface InitiativeProgress {
  total: number;
  done: number;
  doing: number;
  startable: number;
  blocked: number;
}

/** The `initiatives` topic projection: what lists and the inbox card read. */
export interface InitiativeSummary {
  id: string;
  title: string;
  state: InitiativeState;
  attention?: InitiativeAttention;
  progress: InitiativeProgress;
  /**
   * Sessions linked to an unarchived member Task (its `context` edges), in
   * first-seen order. Structural membership only, nothing parsed from titles.
   */
  sessionIds: string[];
  updatedAt: number;
}

/** One member Task on the graph. */
export interface InitiativeGraphNode {
  id: string;
  title: string;
  status: TaskStatus;
  state: InitiativeTaskState;
  projectId?: string;
  /** The parent Task, present only when the parent is a member too. */
  parentId?: string;
  /** Stored on a membership edge, as opposed to joining through a parent. */
  direct?: true;
  milestone?: true;
  archived?: true;
}

/** A Task outside the Initiative that blocks a member: a stub at the lane edge. */
export interface InitiativeExternalBlocker {
  id: string;
  title: string;
  status: TaskStatus;
  projectId?: string;
  archived?: true;
}

/** `from` blocks `to`; both are graph nodes or `from` is an external blocker. */
export interface InitiativeGraphEdge {
  from: string;
  to: string;
}

/** The keyed detail read: the Initiative's own fields plus its graph. */
export interface InitiativeDetail extends InitiativeSummary {
  description: string;
  createdAt: number;
  archivedAt?: number;
  /** Members with no parent on the graph, in the user's order. */
  rootIds: string[];
  /** Every member, depth-first from the roots, children in Backlog order. */
  nodes: InitiativeGraphNode[];
  externalBlockers: InitiativeExternalBlocker[];
  /** Every `blocks` link INTO a member, from a member or an external blocker. */
  edges: InitiativeGraphEdge[];
  /** Milestone Task ids, in the user's order. */
  milestoneIds: string[];
}
