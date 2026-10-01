import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import { afterEach, test } from "vitest";
import { removeAgentTempTree } from "./agentTempTree.ts";

/**
 * Whether this process is subject to the permission bits these fixtures depend
 * on. ROOT IS NOT: it bypasses the mode check, so `rmSync` simply succeeds on a
 * read-only directory and the bug cannot be reproduced at all — an assertion
 * that it fails would be asserting the OS, not this module.
 *
 * CI runs the suite in a container as root, so this is not hypothetical — it is
 * why `tools/core/lsTool.test.ts` already gates its own unreadable-directory
 * test on the same condition. The behaviour every caller depends on, that the
 * tree ends up gone, is still asserted everywhere; only the steps that need the
 * failure to actually happen are gated.
 */
const permissionsEnforced = process.getuid?.() !== 0;

const created: string[] = [];

/**
 * Clean up WITHOUT the code under test. These fixtures are unremovable by
 * construction, and they are created under `TMPDIR` — which for a coding agent
 * is the very tree the server deletes when its turn ends. A fixture stranded by
 * a failing assertion (or by a deliberately broken build, which is how the
 * permission cases are shown to discriminate) would therefore hand the real
 * server the exact input this module exists to survive.
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

function tree(): string {
  const root = mkdtempSync(
    join(tmpdir(), `pa-agent-temp-test-${randomUUID()}`),
  );
  created.push(root);
  return root;
}

afterEach(() => {
  while (created.length > 0) forceRemove(created.pop()!);
});

test("reclaims a tree whose directories an agent left read-only", () => {
  const root = tree();
  const artifacts = join(root, "pytest-0", "case", "artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "output.png"), "x");
  // Exactly what pytest's tmp_path read-only fixtures leave behind: the file is
  // unlinkable only through its parent, and the parent forbids it.
  chmodSync(artifacts, 0o555);

  if (permissionsEnforced)
    assert.throws(() => rmSync(root, { recursive: true, force: true }), {
      code: "EACCES",
    });
  assert.equal(removeAgentTempTree(root), true);
  assert.equal(existsSync(root), false);
});

// A directory with NO permission bits at all: its owner may still chmod it, but
// nothing may open it for reading, so repairing it needs a handle that does not
// imply read access (Linux `O_PATH`). Elsewhere the helper documents that it
// cannot reclaim this, and the deployment target is Linux.
test.skipIf(process.platform !== "linux")(
  "reclaims a tree containing a directory with no permissions at all",
  () => {
    const root = tree();
    const blind = join(root, "blind");
    mkdirSync(blind);
    writeFileSync(join(blind, "leaf.txt"), "x");
    chmodSync(blind, 0o000);

    if (permissionsEnforced)
      assert.throws(() => rmSync(root, { recursive: true, force: true }), {
        code: "EACCES",
      });
    assert.equal(removeAgentTempTree(root), true);
    assert.equal(existsSync(root), false);
  },
);

test.skipIf(process.platform !== "linux")(
  "a mode-000 directory nested under a read-only one is still reclaimed",
  () => {
    const root = tree();
    const outer = join(root, "outer");
    const blind = join(outer, "blind");
    mkdirSync(blind, { recursive: true });
    writeFileSync(join(blind, "leaf.txt"), "x");
    chmodSync(blind, 0o000);
    chmodSync(outer, 0o555);

    assert.equal(removeAgentTempTree(root), true);
    assert.equal(existsSync(root), false);
  },
);

test("a read-only directory nested under several read-only ones is still reclaimed", () => {
  const root = tree();
  const deep = join(root, "a", "b", "c");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "leaf.txt"), "x");
  for (const dir of [deep, join(root, "a", "b"), join(root, "a")])
    chmodSync(dir, 0o555);

  assert.equal(removeAgentTempTree(root), true);
  assert.equal(existsSync(root), false);
});

test("repairing permissions never follows a symlink out of the tree", () => {
  const outside = tree();
  const guarded = join(outside, "guarded");
  mkdirSync(guarded);
  chmodSync(guarded, 0o555);
  const guardedMode = statSync(guarded).mode & 0o777;

  const root = tree();
  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts);
  writeFileSync(join(artifacts, "output.png"), "x");
  symlinkSync(guarded, join(root, "escape"));
  chmodSync(artifacts, 0o555);

  assert.equal(removeAgentTempTree(root), true);
  assert.equal(existsSync(root), false);
  assert.equal(
    statSync(guarded).mode & 0o777,
    guardedMode,
    "a symlinked directory outside the tree keeps its mode",
  );
  assert.equal(existsSync(guarded), true, "and is not removed with the tree");
});

test("a missing tree is already gone, not a failure", () => {
  assert.equal(
    removeAgentTempTree(join(tmpdir(), `pa-agent-temp-absent-${randomUUID()}`)),
    true,
  );
});

// Nothing is unreclaimable for root, so there is no way to pose this question.
test.skipIf(!permissionsEnforced)(
  "an unreclaimable tree reports false instead of throwing",
  () => {
    // The one thing repairing the tree cannot fix: unlinking the ROOT needs
    // write permission on its parent, which is outside what we may touch.
    const parent = tree();
    const root = join(parent, "epoch");
    mkdirSync(root);
    writeFileSync(join(root, "leaf.txt"), "x");
    chmodSync(parent, 0o555);

    let result: boolean | undefined;
    assert.doesNotThrow(() => {
      result = removeAgentTempTree(root);
    });
    assert.equal(result, false);
    assert.equal(existsSync(root), true);
  },
);
