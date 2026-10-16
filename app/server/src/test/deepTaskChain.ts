/**
 * A valid Task hierarchy deeper than any call stack, for the reads that must
 * walk it without recursing (`docs/initiatives.md`, A map too large to draw).
 *
 * It is written through the store in one transaction and announced through the
 * change seam, as any write is. Each parent is set before its own parent is, so
 * every acyclicity check walks a single step: through `createTask`, a leaf
 * under the previous leaf walks all its ancestors, quadratic in the depth.
 */
import { withDbTransaction } from "../db/index.ts";
import { taskStore } from "../db/taskStore.ts";
import { notifyTaskChange } from "../tasks.ts";

export interface DeepTaskChain {
  /** The root first, then one Task per level: `chain[n]` is n levels down. */
  chain: string[];
  /**
   * An archived done Task under `chain[branchAt]`, sorted before
   * `chain[branchAt + 1]` by its Backlog order although created after it.
   */
  side: string;
  branchAt: number;
  /** Done Tasks, archived ones included. */
  done: ReadonlySet<string>;
  archived: ReadonlySet<string>;
}

/** Every third level is done and every fifth archived, so some are both. */
export function deepTaskChain(depth: number): DeepTaskChain {
  const branchAt = Math.floor(depth / 2);
  const done = new Set<string>();
  const archived = new Set<string>();
  const { chain, side } = withDbTransaction(() => {
    const rows = Array.from(
      { length: depth + 1 },
      (_, n) => taskStore.create({ title: `Level ${n}`, createdBy: "user" }).id,
    );
    for (let n = depth; n > 0; n -= 1)
      taskStore.setParent(rows[n]!, rows[n - 1]!, 0);
    const sideId = taskStore.create({ title: "Side", createdBy: "user" }).id;
    taskStore.setParent(sideId, rows[branchAt]!, 0);
    taskStore.update(sideId, { sortOrder: 0 });
    const shape = (id: number, n: number) => {
      if (n % 3 === 1) {
        taskStore.update(id, { status: "done" });
        done.add(String(id));
      }
      if (n % 5 === 2) {
        taskStore.setArchived(id, true);
        archived.add(String(id));
      }
    };
    rows.forEach(shape);
    shape(sideId, 7);
    return { chain: rows.map(String), side: String(sideId) };
  });
  notifyTaskChange([...chain, side]);
  return { chain, side, branchAt, done, archived };
}
