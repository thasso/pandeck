/**
 * The critical path of an Initiative (`docs/initiatives.md`, The Initiative
 * page): the longest chain of open Tasks along `blocks` links that ends at the
 * next open milestone. It is computed here from the read's links and the live
 * statuses, never stored, so a status change moves it without a read.
 *
 * Framework-free by the `lib/` contract.
 */
import type { InitiativeDetail, InitiativeLayout } from "@assistant/shared";
import type { InitiativeMember } from "./initiativeView.ts";

export type CriticalPath =
  /** No milestone is open: nothing to lead to. */
  | { kind: "none" }
  /**
   * The open Tasks leading to the milestone form a loop. `blocks` stays
   * acyclic by contract, so this is invalid stored state: no chain is drawn,
   * and `taskIds` names the Tasks in the loop and those leading into
   * it, by id.
   */
  | { kind: "loop"; milestoneId: string; taskIds: readonly string[] }
  | {
      kind: "path";
      milestoneId: string;
      /** Tasks in the longest chain, the milestone included. */
      length: number;
      /** Every Task on a longest chain: all of them when chains tie. */
      taskIds: ReadonlySet<string>;
      /** `from>to` for every link of a longest chain. */
      links: ReadonlySet<string>;
      /** More than one chain has that length. */
      tied: boolean;
    };

const open = (member: InitiativeMember | undefined): boolean =>
  member !== undefined && member.status !== "done" && !member.archived;

/**
 * The next open milestone is the first in the user's order that is neither
 * done nor archived, by the live facts. Only links between open Tasks count:
 * a done or archived blocker holds nothing up. An outside blocker can start a
 * chain; the read has no links into it, so a chain never reaches past one.
 *
 * Linear in Tasks and links: the Tasks that can reach the milestone are found
 * walking back from it, then taken from the milestone outwards in dependency
 * order (each once its successors are done), which also finds a loop as the
 * Tasks that never come free.
 */
export function criticalPath(
  detail: Pick<InitiativeDetail, "edges" | "milestoneIds">,
  members: ReadonlyMap<string, InitiativeMember>,
): CriticalPath {
  const milestoneId = detail.milestoneIds.find((id) => open(members.get(id)));
  if (milestoneId === undefined) return { kind: "none" };

  const blockers = new Map<string, string[]>();
  const seenLink = new Set<string>();
  for (const { from, to } of detail.edges) {
    const key = `${from}>${to}`;
    if (from === to || seenLink.has(key)) continue;
    if (!open(members.get(from)) || !open(members.get(to))) continue;
    seenLink.add(key);
    const list = blockers.get(to);
    if (list) list.push(from);
    else blockers.set(to, [from]);
  }

  // Everything that reaches the milestone through open Tasks.
  const reach = new Set([milestoneId]);
  const stack = [milestoneId];
  while (stack.length > 0)
    for (const from of blockers.get(stack.pop()!) ?? [])
      if (!reach.has(from)) {
        reach.add(from);
        stack.push(from);
      }

  // Successors inside the reach; the milestone itself has none in a valid
  // graph, since anything it blocked that reached it back would be a loop.
  const waiting = new Map<string, number>();
  for (const id of reach) waiting.set(id, 0);
  for (const to of reach)
    for (const from of blockers.get(to) ?? [])
      waiting.set(from, waiting.get(from)! + 1);

  /** Longest chain from a Task to the milestone, in Tasks, and how many. */
  const toEnd = new Map<string, number>();
  const ways = new Map<string, number>();
  const order: string[] = [];
  const free = [...reach].filter((id) => waiting.get(id) === 0);
  for (const id of free) {
    toEnd.set(id, 1);
    ways.set(id, 1);
  }
  while (free.length > 0) {
    const to = free.pop()!;
    order.push(to);
    for (const from of blockers.get(to) ?? []) {
      const length = toEnd.get(to)! + 1;
      const known = toEnd.get(from) ?? 0;
      // Counting saturates: only "one" or "more than one" is ever asked.
      if (length > known) {
        toEnd.set(from, length);
        ways.set(from, ways.get(to)!);
      } else if (length === known)
        ways.set(from, Math.min(2, ways.get(from)! + ways.get(to)!));
      const left = waiting.get(from)! - 1;
      waiting.set(from, left);
      if (left === 0) free.push(from);
    }
  }
  if (order.length < reach.size) {
    const stuck = [...reach]
      .filter((id) => waiting.get(id)! > 0)
      .sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : 1));
    return { kind: "loop", milestoneId, taskIds: stuck };
  }

  let length = 0;
  for (const id of reach) length = Math.max(length, toEnd.get(id)!);
  let chains = 0;
  for (const id of reach) if (toEnd.get(id) === length) chains += ways.get(id)!;

  // Longest chain from any start up to a Task, walking blockers first.
  const fromStart = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const id = order[i]!;
    let best = 1;
    for (const from of blockers.get(id) ?? [])
      best = Math.max(best, fromStart.get(from)! + 1);
    fromStart.set(id, best);
  }
  const taskIds = new Set<string>();
  const links = new Set<string>();
  for (const id of reach)
    if (fromStart.get(id)! + toEnd.get(id)! - 1 === length) taskIds.add(id);
  for (const to of taskIds)
    for (const from of blockers.get(to) ?? [])
      if (taskIds.has(from) && fromStart.get(from)! + toEnd.get(to)! === length)
        links.add(`${from}>${to}`);
  return {
    kind: "path",
    milestoneId,
    length,
    taskIds,
    links,
    tied: chains > 1,
  };
}

/**
 * The path as the drawing shows it: a node is on it when a Task it stands for
 * is (a collapsed epic stands for its hidden descendants), and an arrow when a
 * link of the path runs between the Tasks of its two ends. A chain inside one
 * collapsed epic has no arrow of its own; the epic carries it.
 */
export function pathOnLayout(
  layout: Pick<InitiativeLayout, "nodes" | "edges">,
  path: Extract<CriticalPath, { kind: "path" }>,
): { nodeIds: ReadonlySet<string>; edgeKeys: ReadonlySet<string> } {
  const tasksOf = new Map<string, readonly string[]>();
  for (const node of layout.nodes)
    tasksOf.set(node.id, [node.taskId, ...(node.hiddenTaskIds ?? [])]);
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  for (const node of layout.nodes)
    if (
      node.kind !== "external" &&
      tasksOf.get(node.id)!.some((id) => path.taskIds.has(id))
    )
      nodeIds.add(node.id);
  for (const edge of layout.edges) {
    const sources = tasksOf.get(edge.from) ?? [];
    const targets = tasksOf.get(edge.to) ?? [];
    const onPath = sources.some((from) =>
      targets.some((to) => path.links.has(`${from}>${to}`)),
    );
    if (!onPath) continue;
    edgeKeys.add(`${edge.from}>${edge.to}`);
    // An outside blocker's stub is on the path through its arrow.
    nodeIds.add(edge.from);
  }
  return { nodeIds, edgeKeys };
}
