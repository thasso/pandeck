/**
 * An Initiative read whose hierarchy is deeper than any call stack: a chain of
 * `depth` levels under one root, an archived done side Task halfway down,
 * listed before the chain's next level as the server's read orders it, the
 * leaf marked a milestone, and a lone second root. Every third level is done
 * and every fifth archived, so some are both.
 */
import type { InitiativeDetail, InitiativeGraphNode } from "@assistant/shared";

export interface DeepInitiative {
  detail: InitiativeDetail;
  /** The root first: `chain[n]` is n levels down. */
  chain: string[];
  side: string;
  branchAt: number;
  leaf: string;
  lone: string;
  /** Done members, archived ones included. */
  done: ReadonlySet<string>;
}

export function deepInitiative(depth: number): DeepInitiative {
  const branchAt = Math.floor(depth / 2);
  const chain = Array.from({ length: depth + 1 }, (_, n) => String(n + 1));
  const side = String(depth + 2);
  const lone = String(depth + 3);
  const leaf = chain[depth]!;
  const done = new Set<string>();
  const node = (
    id: string,
    n: number,
    parentId: string | undefined,
  ): InitiativeGraphNode => {
    if (n % 3 === 1) done.add(id);
    return {
      id,
      title: id === side ? "Side" : `Level ${n}`,
      status: n % 3 === 1 ? "done" : "todo",
      ...(parentId ? { parentId } : {}),
      ...(n === 0 ? { direct: true as const } : {}),
      ...(id === leaf ? { milestone: true as const } : {}),
      ...(n % 5 === 2 ? { archived: true as const } : {}),
    };
  };
  const nodes: InitiativeGraphNode[] = [];
  chain.forEach((id, n) => {
    nodes.push(node(id, n, chain[n - 1]));
    // The side Task is read before the chain's next level.
    if (n === branchAt) nodes.push(node(side, 7, id));
  });
  nodes.push({ id: lone, title: "Lone root", status: "todo", direct: true });
  return {
    detail: {
      id: "deep",
      title: "Deep",
      state: "active",
      progress: {
        total: nodes.length,
        done: done.size,
        doing: 0,
        startable: 0,
        blocked: 0,
      },
      sessionIds: [],
      sessionCount: 0,
      coordinatorSessionIds: [],
      createdAt: 1,
      updatedAt: 1,
      description: "",
      rootIds: [chain[0]!, lone],
      nodes,
      externalBlockers: [],
      edges: [],
      milestoneIds: [leaf],
    },
    chain,
    side,
    branchAt,
    leaf,
    lone,
    done,
  };
}
