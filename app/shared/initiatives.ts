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
 * Member counts. `total` is every member, archived ones included; `done`
 * counts done members whether archived or not. The other buckets count only
 * unarchived members, and `doing` and `blocked` overlap: a started Task whose
 * blocker is still open is in both. So the buckets need not sum to `total`.
 */
export interface InitiativeProgress {
  total: number;
  done: number;
  /** Unarchived `doing` members, blocked or not. */
  doing: number;
  /** Unarchived `todo` members with no open blocker. */
  startable: number;
  /** Unarchived members that are not done and have an open blocker. */
  blocked: number;
}

/** At most this many session ids ride a summary; `sessionCount` has the rest. */
export const INITIATIVE_SUMMARY_SESSION_LIMIT = 50;

/** The `initiatives` topic projection: what lists and the inbox card read. */
export interface InitiativeSummary {
  id: string;
  title: string;
  state: InitiativeState;
  attention?: InitiativeAttention;
  progress: InitiativeProgress;
  /**
   * User sessions linked to a member Task (its `context` edges) that are
   * neither archived nor settled, most recently updated first and at most
   * {@link INITIATIVE_SUMMARY_SESSION_LIMIT}. Structural membership only,
   * nothing parsed from titles; an archived member Task still counts.
   */
  sessionIds: string[];
  /** How many sessions qualify; above `sessionIds.length` when it was cut. */
  sessionCount: number;
  updatedAt: number;
}

/** One member Task on the graph. */
export interface InitiativeGraphNode {
  id: string;
  title: string;
  status: TaskStatus;
  /**
   * An open blocker (neither done nor archived) holds this Task up. Never set
   * on a done Task, and independent of `doing`: a started Task can be blocked.
   */
  blocked?: true;
  projectId?: string;
  /** The parent Task, present only when the parent is a member too. */
  parentId?: string;
  /** Holds a stored membership edge, rather than joining only through a parent. */
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
