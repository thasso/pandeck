/**
 * What the reclaim container is allowed to touch (Task 659).
 *
 * Asking the docker daemon to chown a host directory is a real privilege: the
 * daemon is effective root. These tests pin the four things that keep it
 * proportionate — an app-derived path inside a managed root, one mount, the
 * server's own uid, and a chown rather than a delete — plus the failure paths,
 * which must come back as reasons to show the user instead of exceptions that
 * turn a removal into a crash.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
  setContainerExecForTests,
  type ContainerExecRequest,
  type ContainerExecResult,
} from "./containerImages.ts";
import { reclaimContainerResidue } from "./containerResidue.ts";

const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;

const roots: string[] = [];
let calls: string[][] = [];

/** Answers the runtime probe and the image presence check; `run` is per test. */
function exec(run: (req: ContainerExecRequest) => ContainerExecResult): void {
  setContainerExecForTests(async (req) => {
    calls.push(req.args);
    const [command] = req.args;
    if (command === "version") return { code: 0, stdout: "29.6.1", stderr: "" };
    if (command === "image")
      return {
        code: 0,
        stdout: JSON.stringify([
          { Id: "sha256:abc", Size: 1, RepoDigests: [] },
        ]),
        stderr: "",
      };
    return run(req);
  });
}

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "pa-reclaim-"));
  roots.push(root);
  return root;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  setContainerExecForTests(null);
  while (roots.length > 0)
    rmSync(roots.pop()!, { recursive: true, force: true });
});

test("chowns the one mounted directory back to the server's own uid", async () => {
  const root = scratch();
  const worktree = join(root, "repo-feature");
  mkdirSync(worktree);
  exec(() => ({ code: 0, stdout: "", stderr: "" }));

  const outcome = await reclaimContainerResidue({
    path: worktree,
    allowedRoots: [root],
    image: "alpine:3.22",
  });

  assert.deepEqual(outcome, { status: "reclaimed" });
  const run = calls.find((args) => args[0] === "run");
  assert.ok(run, "the reclaim must run a container");
  // One mount, no network, root inside (chown needs it), and an ownership that
  // no parameter can point anywhere but this process.
  assert.deepEqual(
    run.filter((arg) => arg === "--volume"),
    ["--volume"],
  );
  assert.ok(run.includes(`${worktree}:/target`));
  assert.ok(run.includes("--network") && run.includes("none"));
  assert.ok(run.includes("--user") && run.includes("0:0"));
  assert.equal(run.at(-2), "-c");
  // Chowns, never deletes: deletion stays on the host with its git guards.
  assert.match(run.at(-1)!, new RegExp(`chown -R ${uid}:${gid} -- /target$`));
  assert.ok(!run.some((arg) => arg === "rm" || arg === "-rf"));
});

test("refuses a path outside every managed root, without running anything", async () => {
  const root = scratch();
  const elsewhere = scratch();
  const worktree = join(elsewhere, "repo-feature");
  mkdirSync(worktree);
  exec(() => ({ code: 0, stdout: "", stderr: "" }));

  const outcome = await reclaimContainerResidue({
    path: worktree,
    allowedRoots: [root],
  });

  assert.equal(outcome.status, "unavailable");
  assert.match(
    outcome.status === "unavailable" ? outcome.reason : "",
    /not inside a managed worktree root/,
  );
  assert.deepEqual(calls, []);
});

test("refuses the managed root itself: that is every worktree, not one", async () => {
  const root = scratch();
  exec(() => ({ code: 0, stdout: "", stderr: "" }));

  const outcome = await reclaimContainerResidue({
    path: root,
    allowedRoots: [root],
  });

  assert.equal(outcome.status, "unavailable");
  assert.deepEqual(calls, []);
});

test("refuses a path that has already gone", async () => {
  const root = scratch();
  exec(() => ({ code: 0, stdout: "", stderr: "" }));

  const outcome = await reclaimContainerResidue({
    path: join(root, "never-existed"),
    allowedRoots: [root],
  });

  assert.equal(outcome.status, "unavailable");
  assert.deepEqual(calls, []);
});

test("an unusable runtime is a reason, not an exception", async () => {
  const root = scratch();
  const worktree = join(root, "repo-feature");
  mkdirSync(worktree);
  setContainerExecForTests(async (req) => {
    calls.push(req.args);
    return {
      code: 1,
      stdout: "",
      stderr: "Cannot connect to the Docker daemon",
    };
  });

  const outcome = await reclaimContainerResidue({
    path: worktree,
    allowedRoots: [root],
  });

  assert.equal(outcome.status, "unavailable");
  assert.match(
    outcome.status === "unavailable" ? outcome.reason : "",
    /Cannot connect to the Docker daemon/,
  );
  assert.ok(!calls.some((args) => args[0] === "run"));
});

test("a failing chown comes back with docker's own first line", async () => {
  const root = scratch();
  const worktree = join(root, "repo-feature");
  mkdirSync(worktree);
  exec(() => ({
    code: 1,
    stdout: "",
    stderr: "chown: /target/store: Read-only file system\nmore noise",
  }));

  const outcome = await reclaimContainerResidue({
    path: worktree,
    allowedRoots: [root],
  });

  assert.equal(outcome.status, "unavailable");
  assert.match(
    outcome.status === "unavailable" ? outcome.reason : "",
    /Read-only file system/,
  );
});

test("carries the expected device AND inode, checked before the chown", async () => {
  const root = scratch();
  const worktree = join(root, "repo-feature");
  mkdirSync(worktree);
  exec(() => ({ code: 0, stdout: "", stderr: "" }));

  await reclaimContainerResidue({ path: worktree, allowedRoots: [root] });

  const run = calls.find((args) => args[0] === "run")!;
  const script = run.at(-1)!;
  // A bind mount preserves both numbers, so the container can prove in the
  // daemon's own namespace that it got the directory we checked. The DEVICE is
  // half the check: inode numbers repeat across filesystems (/dev, /dev/shm,
  // /proc and /sys all hold inode 1), and a tmpfs an attacker can write to
  // hands out low numbers that could be made to collide.
  const { dev, ino } = statSync(worktree);
  assert.match(script, new RegExp(`= "${dev} ${ino}"`));
  assert.match(
    script,
    /^test .*\|\| exit 3\nexec chown -R \d+:\d+ -- \/target$/,
  );
});

test("a swapped mount is refused by the container, and says so", async () => {
  const root = scratch();
  const worktree = join(root, "repo-feature");
  mkdirSync(worktree);
  // Exit 3 is what the in-container inode check uses; nothing was chowned.
  exec(() => ({ code: 3, stdout: "", stderr: "" }));

  const outcome = await reclaimContainerResidue({
    path: worktree,
    allowedRoots: [root],
  });

  assert.equal(outcome.status, "unavailable");
  assert.match(
    outcome.status === "unavailable" ? outcome.reason : "",
    /changed between the check and the mount/,
  );
});

test("a symlink out of the managed roots is refused on its resolved path", async () => {
  const root = scratch();
  const elsewhere = scratch();
  const link = join(root, "repo-feature");
  symlinkSync(elsewhere, link);
  exec(() => ({ code: 0, stdout: "", stderr: "" }));

  const outcome = await reclaimContainerResidue({
    path: link,
    allowedRoots: [root],
  });

  assert.equal(outcome.status, "unavailable");
  assert.deepEqual(calls, []);
});
