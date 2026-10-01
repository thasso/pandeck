/**
 * What repairing an agent's scratch tree owes the rest of the filesystem.
 *
 * Making a directory writable again is a check ("this entry is a directory")
 * and a change ("give it owner rwx"). Split across two path lookups, an agent's
 * still-running child can replace the entry with a symlink in between, and the
 * change lands on the link's target instead — outside the tree, on anything the
 * server can write.
 *
 * The swap is fired from the `readdirSync` the walk uses to enumerate the root,
 * which is the one place that lands in that window every time.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { removeAgentTempTree } from "./agentTempTree.ts";

/** Runs once, right after the walk has listed a directory and before it opens the children. */
let afterReaddir: ((path: string) => void) | undefined;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const listed = actual.readdirSync as unknown as (
    path: string,
    options: unknown,
  ) => unknown;
  return {
    ...actual,
    readdirSync: ((path: string, options: unknown) => {
      const entries = listed(path, options);
      const hook = afterReaddir;
      afterReaddir = undefined;
      hook?.(path);
      return entries;
    }) as unknown as typeof actual.readdirSync,
  };
});

const roots: string[] = [];

/**
 * Clean up WITHOUT the code under test: these fixtures live under `TMPDIR`,
 * which for a coding agent is the tree the server deletes when its turn ends, so
 * one stranded read-only directory hands the real server the input this module
 * exists to survive. Symlinks are listed, never followed — `guarded` is the
 * point of the test.
 */
function forceRemove(root: string): void {
  if (!existsSync(root)) return;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    try {
      chmodSync(dir, 0o700);
      for (const entry of readdirSync(dir, { withFileTypes: true }))
        if (entry.isDirectory()) pending.push(join(dir, entry.name));
    } catch {
      // Best effort; the rm below reports anything genuinely stuck.
    }
  }
  rmSync(root, { recursive: true, force: true });
}

afterEach(() => {
  afterReaddir = undefined;
  while (roots.length > 0) forceRemove(roots.pop()!);
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "pa-agent-temp-race-"));
  roots.push(root);
  return root;
}

test("a directory swapped for a symlink mid-walk is not chmod'd through", () => {
  // Somewhere the server can write but this tree has no business touching.
  const outside = scratch();
  const guarded = join(outside, "guarded");
  mkdirSync(guarded);
  writeFileSync(join(guarded, "secret.txt"), "x");
  const guardedMode = 0o555;
  chmodSync(guarded, guardedMode);

  const root = scratch();
  // Read-only, so the repair walk is entered at all.
  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts);
  writeFileSync(join(artifacts, "output.png"), "x");
  chmodSync(artifacts, 0o555);
  // Empty, so it can be swapped for a link the instant the walk has listed it.
  const victim = join(root, "victim");
  mkdirSync(victim);

  afterReaddir = (listedPath) => {
    if (listedPath !== root) return;
    rmSync(victim, { recursive: true, force: true });
    symlinkSync(guarded, victim);
  };

  assert.equal(removeAgentTempTree(root), true);
  assert.equal(existsSync(root), false, "the tree itself is still reclaimed");
  assert.equal(
    statSync(guarded).mode & 0o777,
    guardedMode,
    "the swapped-in link's target keeps its mode",
  );
  assert.equal(
    existsSync(join(guarded, "secret.txt")),
    true,
    "and its contents are not removed with the tree",
  );
});
