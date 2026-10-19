import type { InitiativeGraphNode } from "@assistant/shared";

/** Disjoint browser buckets, unlike the summary's overlapping doing/blocked facts. */
export interface InitiativeBrowserCounts {
  startable: number;
  doing: number;
  blocked: number;
  /** Completed or archived for browser presentation, without changing Task status. */
  done: number;
  total: number;
}

export function initiativeBrowserCounts(
  nodes: readonly InitiativeGraphNode[],
): InitiativeBrowserCounts {
  const counts: InitiativeBrowserCounts = {
    startable: 0,
    doing: 0,
    blocked: 0,
    done: 0,
    total: nodes.length,
  };
  for (const node of nodes) {
    if (node.status === "done" || node.archived) counts.done += 1;
    else if (node.blocked) counts.blocked += 1;
    else if (node.status === "doing") counts.doing += 1;
    else counts.startable += 1;
  }
  return counts;
}
