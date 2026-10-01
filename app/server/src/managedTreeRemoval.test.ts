/**
 * The two blockers a managed tree removal has to tell apart, and what each one
 * costs (Task 659).
 *
 * An OWNER-LOCKED directory is ours with its write bit off; repairing the mode
 * reclaims it, and refusing there would refuse trees the app deletes routinely.
 * A FOREIGN-OWNED one belongs to another uid — a container that wrote into a
 * bind-mounted checkout as root — and no mode change helps, so the only ways
 * out are the container runtime or a `sudo` the user runs.
 *
 * Creating a genuinely root-owned directory needs root, which the suite does not
 * have, so the foreign case is driven through the scan's injected `selfUid`:
 * a fixture owned by US looks foreign to a walk that believes it is somebody
 * else. The permission arithmetic being tested is the same either way.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { removeManagedTree, scanTreeResidue } from "./managedTreeRemoval.ts";

/** Root bypasses the mode checks, so the failures these fixtures need never happen. */
const permissionsEnforced = process.getuid?.() !== 0;
const selfUid = process.getuid?.() ?? 0;

/**
 * The uid a fixture about OWNERSHIP claims to run as, and a foreign one.
 *
 * Never the runner's own uid, because the scan answers "nothing is foreign" the
 * moment it believes it is root — root deletes whatever it likes — and CI runs
 * this suite as root in a container. A fixture that inherited that would assert
 * the early return instead of the walk, and would pass locally while proving
 * nothing where it matters.
 */
const SERVER_UID = 4242;
const FOREIGN_UID = 0;

const created: string[] = [];

/** Clean up WITHOUT the code under test: a stranded fixture is undeletable by construction. */
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
  const root = mkdtempSync(join(tmpdir(), `pa-managed-tree-${randomUUID()}`));
  created.push(root);
  return root;
}

afterEach(() => {
  while (created.length > 0) forceRemove(created.pop()!);
});

test("an owner-locked directory is repaired, not reported as residue", async () => {
  const root = tree();
  const locked = join(root, "artifacts");
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, "output.png"), "x");
  chmodSync(locked, 0o555);

  if (permissionsEnforced)
    assert.throws(() => rmSync(root, { recursive: true, force: true }), {
      code: "EACCES",
    });
  // Ours, so nothing in it is foreign no matter how locked it is.
  assert.equal(scanTreeResidue(root).foreign, undefined);

  const result = await removeManagedTree(root);
  assert.equal(result.removed, true);
  assert.equal(result.residue, undefined);
  assert.equal(existsSync(root), false);
});

test("a foreign-owned directory is reported with its path and owner", () => {
  const root = tree();
  mkdirSync(join(root, "node_modules", "deep"), { recursive: true });
  mkdirSync(join(root, ".pnpm-store"));

  // The whole tree is ours; pretending to be another uid makes every directory
  // foreign, which is what a root-written store looks like to the real server.
  const scan = scanTreeResidue(root, { selfUid: selfUid + 1 });
  assert.equal(scan.foreign?.path, root);
  assert.equal(scan.foreign?.uid, selfUid);
  assert.equal(scan.foreign?.reason, "foreign-owner");
});

test("the walk is breadth-first, so shallow residue is found inside the budget", () => {
  const root = tree();
  // A container mount writes its store BESIDE the deep tree an install created.
  // Depth-first would spend the budget in the chain and never look at `store`.
  mkdirSync(join(root, "deep", "a", "b", "c", "d"), { recursive: true });
  const store = join(root, "store");
  mkdirSync(store);

  // Exactly one directory is foreign, which a fixture cannot express without
  // root; the uid seam places it where a real container would have.
  const uidOf = (path: string) => (path === store ? FOREIGN_UID : SERVER_UID);
  const scan = scanTreeResidue(root, {
    selfUid: SERVER_UID,
    uidOf,
    maxDirectories: 3,
  });

  assert.equal(scan.foreign?.path, store);
  assert.equal(scan.foreign?.uid, FOREIGN_UID);
  // Root, then both children: found before a depth-first walk would have left
  // the first level.
  assert.equal(scan.directoriesVisited <= 3, true);
});

test("an exhausted budget reports an incomplete walk, never a refusal", () => {
  const root = tree();
  mkdirSync(join(root, "a", "b"), { recursive: true });

  const scan = scanTreeResidue(root, {
    selfUid: SERVER_UID,
    maxDirectories: 0,
  });
  assert.equal(scan.foreign, undefined);
  assert.equal(scan.complete, false);
});

test("running as root reports nothing: it can delete the tree anyway", () => {
  const root = tree();
  mkdirSync(join(root, "store"));

  const scan = scanTreeResidue(root, { selfUid: 0 });
  assert.equal(scan.foreign, undefined);
  assert.equal(scan.complete, true);
});

test("a foreign blocker asks the reclaim, then removes what it handed back", async () => {
  const root = tree();
  mkdirSync(join(root, "store"), { recursive: true });

  // A tree nothing this process does can delete until its ownership comes back,
  // which is what a root-written store is and what no fixture can create here.
  let handedBack = false;
  const asked: string[] = [];
  const result = await removeManagedTree(root, {
    remove: (path) => {
      if (!handedBack) return false;
      rmSync(path, { recursive: true, force: true });
      return true;
    },
    reclaim: async (path) => {
      asked.push(path);
      handedBack = true;
      return { status: "reclaimed" };
    },
    scanOptions: { selfUid: selfUid + 1 },
  });

  assert.deepEqual(asked, [root]);
  assert.equal(result.removed, true);
  assert.equal(result.reclaimed, true);
  assert.equal(existsSync(root), false);
});

test("a reclaim that cannot run leaves the residue and its reason", async () => {
  const root = tree();
  mkdirSync(join(root, "store"), { recursive: true });

  const result = await removeManagedTree(root, {
    remove: () => false,
    reclaim: async () => ({
      status: "unavailable",
      reason: "no usable container runtime",
    }),
    scanOptions: { selfUid: selfUid + 1 },
  });

  assert.equal(result.removed, false);
  assert.equal(result.reclaimed, false);
  assert.equal(result.reclaimReason, "no usable container runtime");
  assert.equal(result.residue?.path, root);
  assert.equal(existsSync(root), true);
});

test("an owner-locked blocker never reaches the reclaim", async () => {
  const root = tree();
  const locked = join(root, "artifacts");
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, "output.png"), "x");
  chmodSync(locked, 0o555);

  let asked = 0;
  const result = await removeManagedTree(root, {
    reclaim: async () => {
      asked += 1;
      return { status: "reclaimed" };
    },
  });

  assert.equal(asked, 0);
  assert.equal(result.removed, true);
});

test("a tree that is already gone is removed, trivially", async () => {
  const root = tree();
  rmSync(root, { recursive: true, force: true });
  const result = await removeManagedTree(root);
  assert.equal(result.removed, true);
});

test("residue hidden under an unreadable directory makes the walk incomplete", () => {
  const root = tree();
  const blind = join(root, "blind");
  mkdirSync(join(blind, "store"), { recursive: true });
  chmodSync(blind, 0o000);

  // The subtree is unseen, so the absence of a foreign directory here is not
  // evidence of one — saying `complete` would let a preflight claim a tree is
  // clean when a root-owned store sits one level further down.
  // Everything is ours, so the only thing under test is the unreadable
  // directory: nothing here should be reported as foreign.
  const scan = scanTreeResidue(root, {
    selfUid: SERVER_UID,
    uidOf: () => SERVER_UID,
  });
  assert.equal(scan.foreign, undefined);
  // Root can list a mode-000 directory, so there the walk IS complete.
  assert.equal(scan.complete, permissionsEnforced ? false : true);
});

test("the removal still reaches residue that a first scan could not see", async () => {
  const root = tree();
  const blind = join(root, "blind");
  const store = join(blind, "store");
  mkdirSync(store, { recursive: true });
  chmodSync(blind, 0o000);

  // Removal repairs owner access BEFORE it scans, so the hidden directory is
  // visible by the time the verdict matters.
  const result = await removeManagedTree(root, {
    remove: () => false,
    reclaim: async () => ({ status: "unavailable", reason: "no runtime" }),
    scanOptions: {
      selfUid: SERVER_UID,
      uidOf: (path) => (path === store ? FOREIGN_UID : SERVER_UID),
    },
  });

  assert.equal(result.removed, false);
  assert.equal(result.residue?.path, store);
});
