/**
 * Where a checkout operation runs. In phase 1 every checkout is placed on the
 * default Worker, the in-process one; its id is derived, not stored, until
 * phase 4 (`docs/workers.md`).
 *
 * {@link placeGitCwd} is the TRANSITIONAL path-only adapter behind the
 * existing `(args, cwd)` executors in `gitExec.ts`. It keeps the Knowledge
 * Base on the server: the KB is a server repository even where the worktree
 * surfaces browse and commit it as a checkout. W3 replaces that path rule with
 * a typed choice made from the KB row, and W6 deletes this adapter once every
 * caller passes its own location.
 *
 * {@link placeServedPath} places a served file the same way, with `DATA_DIR`
 * kept on the server too.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DATA_DIR } from "../config.ts";
import { knowledgeBasePlacementRoots } from "../knowledgeBaseSettings.ts";
import type { CheckoutLocation } from "../workerProtocol/checkoutMethods.ts";
import type { WorkerFileLocation } from "../workerProtocol/fileMethods.ts";

/** The Worker every checkout is placed on in phase 1. */
export const DEFAULT_WORKER_ID = "local";

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/** Root history and fallback policy come from the owning settings reader. */
function insideKnowledgeBase(cwd: string): boolean {
  const path = resolve(cwd);
  return knowledgeBasePlacementRoots().some(
    (root) =>
      contains(root.path, path) ||
      (root.real !== undefined && contains(root.real, path)),
  );
}

/** The location git in `cwd` runs at; undefined keeps it on the server. */
export function placeGitCwd(cwd: string): CheckoutLocation | undefined {
  if (insideKnowledgeBase(cwd)) return undefined;
  return { workerId: DEFAULT_WORKER_ID, path: cwd };
}

/** `DATA_DIR`'s real path, once observed; it does not move while we run. */
let dataDirReal: string | undefined;

function insideDataDir(path: string): boolean {
  if (dataDirReal === undefined)
    try {
      dataDirReal = realpathSync(DATA_DIR);
    } catch {
      // Not created yet: the name still matches.
    }
  return (
    contains(resolve(DATA_DIR), path) ||
    (dataDirReal !== undefined && contains(dataDirReal, path))
  );
}

/**
 * Where a served file is read; undefined reads it on the server. A path named
 * inside `DATA_DIR` or the Knowledge Base, by its own spelling or by their
 * observed real paths, stays on the server (B6); every other path is read by
 * the default Worker.
 *
 * The requested path itself is never resolved here. A link from outside both
 * roots into them is read by the Worker with the Worker's own rights: were the
 * server to follow links from checkout content into `DATA_DIR`, it would serve
 * a target an agent chose with the server's privileges, a confused deputy.
 * Once accounts are separate, the Worker cannot read `DATA_DIR`, so such a
 * link fails closed (`docs/workers.md`).
 */
export function placeServedPath(path: string): WorkerFileLocation | undefined {
  const resolved = resolve(path);
  if (insideDataDir(resolved) || insideKnowledgeBase(resolved))
    return undefined;
  return { workerId: DEFAULT_WORKER_ID, path };
}
