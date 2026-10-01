import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Worktree watch source audit (Task-353).
 *
 * `watchWorktree` has no refcount on the wire: the server keeps a plain Set of
 * ids per connection, so the FIRST `unwatchWorktree` for an id ends the watch
 * for every surface that asked for it. Three surfaces routinely want the same
 * worktree — a Task row's dirty dot, the Worktrees/Projects browsers, the open
 * session's header — and when one of them let go, the others' markers silently
 * froze at whatever they last heard.
 *
 * `lib/worktreeWatchRegistry.ts` is what makes that safe, and it only works if
 * it is the ONLY sender. A per-surface test cannot hold that line: the failure
 * is a NEW surface calling the action directly, which every existing test still
 * passes. So this scans first-party sources for the two calls and pins the
 * files allowed to make them.
 *
 * Its reach is what a regex can see — a call reached through an aliased
 * function value escapes it — but that is not the shape this failure takes: it
 * takes the shape of an `actions.watchWorktree(id)` in a new effect.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The one file that may CALL them. Not a permission list: a second caller has
 * to argue why the registry cannot serve it. `hooks/useAssistant.ts` declares
 * and implements the actions — a definition (`watchWorktree: (id) => …`) is not
 * a call and does not match.
 */
const SENDERS: readonly string[] = ["lib/worktreeWatchRegistry.ts"];

const CALL = /\b(?:un)?watchWorktree\s*\(/;

function scanned(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(HERE, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    if (!/\.tsx?$/.test(full) || full.endsWith(".d.ts")) continue;
    if (/\.test\.[tj]sx?$/.test(full)) continue;
    files.push(full);
  }
  return files.sort();
}

describe("worktree watch audit", () => {
  it("keeps every watch behind the refcounting registry", () => {
    const callers = scanned()
      .filter((file) => CALL.test(readFileSync(file, "utf8")))
      .map((file) => relative(HERE, file).split("\\").join("/"));
    expect(callers).toEqual([...SENDERS].sort());
  });

  it("scans something", () => {
    // A path or extension change that quietly empties the scan would make the
    // assertion above pass for the wrong reason.
    expect(scanned().length).toBeGreaterThan(100);
  });
});
