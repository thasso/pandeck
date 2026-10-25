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
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { knowledgeBaseRoot } from "../knowledgeBaseSettings.ts";
import type { CheckoutLocation } from "../workerProtocol/checkoutMethods.ts";

/** The Worker every checkout is placed on in phase 1. */
export const DEFAULT_WORKER_ID = "local";

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/**
 * Whether `cwd` lies inside the Knowledge Base folder, as named or as its
 * real path; a sibling such as `knowledge-old` does not.
 */
function insideKnowledgeBase(cwd: string): boolean {
  const root = resolve(knowledgeBaseRoot());
  const path = resolve(cwd);
  if (contains(root, path)) return true;
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    // No folder yet: nothing can be inside its real path.
    return false;
  }
  return real !== root && contains(real, path);
}

/** The location git in `cwd` runs at; undefined keeps it on the server. */
export function placeGitCwd(cwd: string): CheckoutLocation | undefined {
  if (insideKnowledgeBase(cwd)) return undefined;
  return { workerId: DEFAULT_WORKER_ID, path: cwd };
}
