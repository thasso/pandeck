/**
 * Where a checkout operation or a served file read runs. In phase 1 every
 * checkout is placed on the default Worker, the in-process one; its id is
 * derived, not stored, until phase 4 (`docs/workers.md`).
 *
 * A checkout's place is typed only, a {@link CheckoutSide}: every caller runs on
 * `checkoutGitOn`/`checkoutFilesOn` for the side of what it holds — a row or a
 * project's main checkout (`checkoutSideOf`), a path its session supplied
 * ({@link sessionCheckoutSide}), a pull-request card (`pullRequestCardCheckout`).
 * No path and no setting chooses a checkout's side: a project inside the KB
 * root or `DATA_DIR` is a checkout.
 *
 * {@link placeServedPath} places a served file by its path: inside `DATA_DIR`
 * or the Knowledge Base it stays on the server.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DATA_DIR } from "../config.ts";
import { knowledgeBasePlacementRoots } from "../knowledgeBaseSettings.ts";
import type { WorkerFileLocation } from "../workerProtocol/fileMethods.ts";

/** The Worker every checkout is placed on in phase 1. */
export const DEFAULT_WORKER_ID = "local";

/**
 * Where a checkout's git and reads run, chosen by type: the server for the
 * Knowledge Base row (`checkoutSideOf`), else a Worker. Never from a path.
 */
export type CheckoutSide = "server" | { readonly workerId: string };

/** The side of every checkout that is not the Knowledge Base row. */
export const DEFAULT_WORKER_SIDE: CheckoutSide = {
  workerId: DEFAULT_WORKER_ID,
};

/**
 * The side of a checkout path a session supplies: a slash command's cwd, the
 * app's `CWD` default, a tool's path input. A session's paths live on its
 * session's Worker; until phase 4 that is the default Worker for every session.
 */
export function sessionCheckoutSide(_sessionId: string): CheckoutSide {
  return DEFAULT_WORKER_SIDE;
}

/** One string per side, for maps keyed by it. */
export function checkoutSideKey(side: CheckoutSide): string {
  return side === "server" ? "server" : `worker:${side.workerId}`;
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/**
 * For served files only. Root history and fallback policy come from the owning
 * settings reader.
 */
function insideKnowledgeBase(path: string): boolean {
  return knowledgeBasePlacementRoots().some(
    (root) =>
      contains(root.path, path) ||
      (root.real !== undefined && contains(root.real, path)),
  );
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
