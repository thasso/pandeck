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

/**
 * The first milestone, in the user's member order, that is still open: not
 * done and not archived (an archived open Task is shelved, the rule that makes
 * a blocker open). Its title rides the summary so a list can name it without
 * holding the Tasks topic.
 */
export interface InitiativeMilestoneRef {
  id: string;
  title: string;
}

/** The `initiatives` topic projection: what lists read. */
export interface InitiativeSummary {
  id: string;
  title: string;
  state: InitiativeState;
  progress: InitiativeProgress;
  /** Absent when the Initiative has no open milestone. */
  nextMilestone?: InitiativeMilestoneRef;
  /**
   * User sessions STARTED from a member Task (`task-start`, `linkTaskStart`)
   * that are neither archived nor settled, newest by session creation first
   * (ties by id) and at most {@link INITIATIVE_SUMMARY_SESSION_LIMIT};
   * `sessionCount` says how many it cut. A session that only
   * referenced a member Task, or whose link has no origin, is not listed.
   * Structural membership only, nothing parsed from titles; an archived member
   * Task still counts, and a session on several member Tasks is listed once.
   */
  sessionIds: string[];
  /**
   * How many sessions qualify, by the same rule; above `sessionIds.length`
   * when it was cut.
   */
  sessionCount: number;
  createdAt: number;
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

/* --------------------------------- layout -------------------------------- */

/**
 * At most this many collapsed epics ride a `getInitiative`; the server drops
 * any that are not collapsible, so the applied set is the layout's own.
 */
export const INITIATIVE_LAYOUT_COLLAPSE_LIMIT = 500;

/**
 * A map with more drawn nodes than the layout takes: an expected outcome of
 * its size, not a failure, so nothing retrying it changes it. `nodes` is the
 * drawing for the collapsed set the read asked for; collapsing epics draws
 * fewer. It stands beside `layoutError`, which still says why in words.
 */
export interface InitiativeLayoutTooLarge {
  nodes: number;
  limit: number;
}

/** Pixels from the layout's top-left corner, y growing downwards. */
export interface InitiativeLayoutPoint {
  x: number;
  y: number;
}

export interface InitiativeLayoutBox extends InitiativeLayoutPoint {
  width: number;
  height: number;
}

/**
 * One drawn box. `task` is a member Task, `collapsed` a member epic standing
 * for its hidden subtree, `external` the stub of a blocker outside the
 * Initiative: one per lane it blocks into, so `id` is not the Task id there.
 * A milestone sits in the milestone column, outside every lane.
 */
export interface InitiativeLayoutNode extends InitiativeLayoutBox {
  id: string;
  kind: "task" | "collapsed" | "external";
  taskId: string;
  /** The lane it is drawn in; absent in the milestone column. */
  laneId?: string;
  milestone?: true;
  /** A collapsed epic's hidden descendants; milestones stay drawn. */
  hiddenTaskIds?: string[];
  /** A collapsed epic's descendants' counts, as of the read. */
  progress?: InitiativeProgress;
}

/** One lane per member root epic; `id` is the root Task's id. */
export interface InitiativeLayoutLane extends InitiativeLayoutBox {
  id: string;
  projectId?: string;
}

/** The lanes of one Project, in the user's member order. */
export interface InitiativeLayoutGroup extends InitiativeLayoutBox {
  projectId?: string;
  laneIds: string[];
}

/**
 * A routed `blocks` arrow between two layout nodes: orthogonal segments from
 * the blocker's border to the blocked node's border. Arrows inside a collapsed
 * epic are gone, and those into or out of it end at its node.
 */
export interface InitiativeLayoutEdge {
  from: string;
  to: string;
  points: InitiativeLayoutPoint[];
}

/**
 * Where the map draws everything, laid out left to right on the server. It
 * depends only on the graph's structure (members, hierarchy, the lane's
 * Project, milestone marks, `blocks` links, order) and the collapsed set, so a
 * status, title or archive change keeps it: `key` names exactly that input.
 */
export interface InitiativeLayout {
  key: string;
  /** The collapsed epics it applied, ascending by id. */
  collapsed: string[];
  width: number;
  height: number;
  groups: InitiativeLayoutGroup[];
  lanes: InitiativeLayoutLane[];
  /** The column on the right holding the milestones, when there are any. */
  milestoneColumn?: InitiativeLayoutBox;
  nodes: InitiativeLayoutNode[];
  edges: InitiativeLayoutEdge[];
}
