/**
 * Host-driven `/push` workflow tests against real temp git repos: argument
 * parsing, first-push upstream set, up-to-date detection, force mapping, and the
 * failure paths (no remote, detached HEAD).
 *
 * Run: pnpm --filter @assistant/server test src/pushWorkflow.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "push-workflow-test-"));
process.env.ASSISTANT_CWD = tmp;

const {
  buildPushArgs,
  parsePushArgs,
  readRemoteBranchOid,
  resolvePushTarget,
  runPushWorkflow,
  toPushDisplay,
} = await import("./pushWorkflow.ts");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  );
}

/** A bare "remote" plus a working clone with one commit on `main`. */
function makeRepoPair(name: string): { work: string; bare: string } {
  const bare = join(tmp, `${name}.git`);
  const work = join(tmp, name);
  mkdirSync(bare, { recursive: true });
  sh(bare, "init", "--bare", "-b", "main");
  execFileSync("git", ["clone", bare, work], { encoding: "utf8" });
  writeFileSync(join(work, "readme.md"), "hello\n");
  sh(work, "add", "-A");
  sh(work, "commit", "-m", "init");
  return { work, bare };
}

test("parsePushArgs reads flags and positional remote/branch", () => {
  // No positional means the keys are ABSENT, not present-and-undefined:
  // `parsePushArgs` builds a `ParsedPushArgs` whose optional fields are omitted.
  assert.deepEqual(parsePushArgs(""), { force: false });
  assert.deepEqual(parsePushArgs("--force"), { force: true });
  assert.deepEqual(parsePushArgs("-f origin feature"), {
    force: true,
    remote: "origin",
    branch: "feature",
  });
  assert.deepEqual(parsePushArgs("upstream main"), {
    force: false,
    remote: "upstream",
    branch: "main",
  });
});

test("first push sets upstream, then reports up-to-date", async () => {
  const { work, bare } = makeRepoPair("uprepo");

  const first = await runPushWorkflow({ cwd: work });
  assert.equal(
    first.status,
    "pushed",
    `expected pushed, got ${first.status}: ${first.error ?? first.output}`,
  );
  assert.equal(first.remote, "origin");
  assert.equal(first.branch, "main");
  assert.equal(first.setUpstream, true, "no prior upstream → --set-upstream");
  // The commit really landed on the bare remote.
  assert.match(sh(bare, "log", "--oneline"), /init/);

  const second = await runPushWorkflow({ cwd: work });
  assert.equal(second.status, "up-to-date");
  assert.equal(second.setUpstream, false, "upstream already tracked");

  // The card projection carries the same status + routing.
  const display = toPushDisplay(second);
  assert.equal(display.status, "up-to-date");
  assert.equal(display.remote, "origin");
  assert.equal(display.branch, "main");
  assert.equal(display.setUpstream, false);
});

test("first push with an explicit remote still sets upstream", async () => {
  const { work } = makeRepoPair("explicitremote");
  const first = await runPushWorkflow({ cwd: work, remote: "origin" });
  assert.equal(first.status, "pushed", first.error ?? first.output);
  assert.equal(
    first.setUpstream,
    true,
    "`/push origin` must establish current-branch tracking",
  );
  assert.equal(
    sh(work, "rev-parse", "--abbrev-ref", "@{u}").trim(),
    "origin/main",
  );
});

test("force maps to --force-with-lease and rewrites the remote branch", async () => {
  const { work, bare } = makeRepoPair("forcerepo");
  await runPushWorkflow({ cwd: work });
  // Rewrite history so a plain push would be rejected (non-fast-forward).
  writeFileSync(join(work, "readme.md"), "changed\n");
  sh(work, "commit", "-am", "amended", "--amend");

  const plain = await runPushWorkflow({ cwd: work });
  assert.equal(
    plain.status,
    "failed",
    "non-fast-forward push must be rejected without force",
  );

  const forced = await runPushWorkflow({ cwd: work, force: true });
  assert.equal(
    forced.status,
    "pushed",
    `force push should succeed: ${forced.error ?? forced.output}`,
  );
  assert.equal(forced.forced, true);
  assert.match(sh(bare, "log", "--oneline"), /amended/);
});

test("fails clearly when the repository has no remote", async () => {
  const solo = join(tmp, "noremote");
  mkdirSync(solo, { recursive: true });
  sh(solo, "init", "-b", "main");
  writeFileSync(join(solo, "a.txt"), "x\n");
  sh(solo, "add", "-A");
  sh(solo, "commit", "-m", "init");

  const result = await runPushWorkflow({ cwd: solo });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /no git remote/i);
});

test("fails clearly on detached HEAD with no explicit branch", async () => {
  const { work } = makeRepoPair("detached");
  const head = sh(work, "rev-parse", "HEAD").trim();
  sh(work, "checkout", head); // detach

  const result = await runPushWorkflow({ cwd: work });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /detached/i);
});

test("explicit lease argv names the derived destination and exact oid", () => {
  const oid = "a".repeat(40);
  const head = "b".repeat(40);
  const args = buildPushArgs({
    remote: "origin",
    branch: "feature/topic",
    source: head,
    force: false,
    explicitLease: { expectedRemoteOid: oid },
    setUpstream: false,
  });
  assert.deepEqual(args, [
    "push",
    `--force-with-lease=refs/heads/feature/topic:${oid}`,
    "origin",
    `${head}:refs/heads/feature/topic`,
  ]);
  assert.equal(args.includes("--force"), false);
  assert.equal(args.includes("--force-with-lease"), false);
});

test("managed first push of an upstream-less worktree branch sets tracking explicitly", async () => {
  const { work, bare } = makeRepoPair("managed-first-upstream");
  const feature = join(tmp, "managed-first-upstream-feature");
  sh(work, "worktree", "add", "-b", "feature", feature);
  const head = sh(feature, "rev-parse", "HEAD").trim();

  const first = await runPushWorkflow({
    cwd: feature,
    remote: "origin",
    expectedBranch: "feature",
    expectedHead: head,
    requireClean: true,
  });
  assert.equal(first.status, "pushed", first.error ?? first.output);
  assert.equal(first.setUpstream, true);
  assert.equal(
    sh(feature, "config", "--get", "branch.feature.remote").trim(),
    "origin",
  );
  assert.equal(
    sh(feature, "config", "--get", "branch.feature.merge").trim(),
    "refs/heads/feature",
  );
  assert.deepEqual((await resolvePushTarget(feature, "feature")).upstream, {
    remote: "origin",
    branch: "feature",
  });
  assert.equal(sh(bare, "rev-parse", "refs/heads/feature").trim(), head);

  const observed = await readRemoteBranchOid(feature, "origin", "feature");
  writeFileSync(join(feature, "readme.md"), "rewritten feature\n");
  sh(feature, "commit", "-am", "rewrite feature", "--amend");
  const rewritten = sh(feature, "rev-parse", "HEAD").trim();
  const forced = await runPushWorkflow({
    cwd: feature,
    remote: "origin",
    expectedBranch: "feature",
    expectedHead: rewritten,
    requireClean: true,
    explicitLease: { expectedRemoteOid: observed! },
  });
  assert.equal(forced.status, "pushed", forced.error ?? forced.output);
  assert.equal(sh(bare, "rev-parse", "refs/heads/feature").trim(), rewritten);
});

test("explicit lease mode refuses calls without every managed precondition", async () => {
  const { work } = makeRepoPair("lease-preconditions");
  const result = await runPushWorkflow({
    cwd: work,
    explicitLease: { expectedRemoteOid: "a".repeat(40) },
  });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /requires a derived remote.*preconditions/i);
});

test("explicit oid lease rewrites only the authoritatively observed remote head", async () => {
  const { work, bare } = makeRepoPair("explicit-lease");
  await runPushWorkflow({ cwd: work });
  const expectedRemoteOid = await readRemoteBranchOid(work, "origin", "main");
  assert.equal(expectedRemoteOid, sh(work, "rev-parse", "@{u}").trim());

  writeFileSync(join(work, "readme.md"), "rewritten\n");
  sh(work, "commit", "-am", "rewritten", "--amend");
  const expectedHead = sh(work, "rev-parse", "HEAD").trim();
  const result = await runPushWorkflow({
    cwd: work,
    remote: "origin",
    expectedBranch: "main",
    expectedHead,
    requireClean: true,
    explicitLease: { expectedRemoteOid: expectedRemoteOid! },
  });
  assert.equal(result.status, "pushed", result.error ?? result.output);
  assert.equal(result.forced, true);
  assert.equal(sh(bare, "rev-parse", "refs/heads/main").trim(), expectedHead);
});

test("an explicit lease atomically refuses a remote advance after observation", async () => {
  const { work, bare } = makeRepoPair("stale-explicit-lease");
  await runPushWorkflow({ cwd: work });
  const observed = await readRemoteBranchOid(work, "origin", "main");

  const peer = join(tmp, "stale-explicit-lease-peer");
  execFileSync("git", ["clone", bare, peer], { encoding: "utf8" });
  writeFileSync(join(peer, "peer.txt"), "peer\n");
  sh(peer, "add", "-A");
  sh(peer, "commit", "-m", "peer advance");
  sh(peer, "push", "origin", "main");
  const advanced = sh(bare, "rev-parse", "refs/heads/main").trim();

  writeFileSync(join(work, "readme.md"), "local rewrite\n");
  sh(work, "commit", "-am", "local rewrite", "--amend");
  const localHead = sh(work, "rev-parse", "HEAD").trim();
  const result = await runPushWorkflow({
    cwd: work,
    remote: "origin",
    expectedBranch: "main",
    expectedHead: localHead,
    requireClean: true,
    explicitLease: { expectedRemoteOid: observed! },
  });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /stale info|rejected/i);
  assert.equal(sh(bare, "rev-parse", "refs/heads/main").trim(), advanced);
});

test("managed preconditions refuse branch, head, and dirty drift but allow ignored output", async () => {
  const { work } = makeRepoPair("managed-preconditions");
  writeFileSync(join(work, ".gitignore"), "build/\n");
  sh(work, "add", ".gitignore");
  sh(work, "commit", "-m", "ignore builds");
  mkdirSync(join(work, "build"));
  writeFileSync(join(work, "build", "cache"), "ignored\n");
  const head = sh(work, "rev-parse", "HEAD").trim();

  const branchDrift = await runPushWorkflow({
    cwd: work,
    expectedBranch: "feature",
    expectedHead: head,
    requireClean: true,
  });
  assert.equal(branchDrift.status, "failed");
  assert.match(branchDrift.error ?? "", /branch changed/);

  const headDrift = await runPushWorkflow({
    cwd: work,
    expectedBranch: "main",
    expectedHead: "f".repeat(40),
    requireClean: true,
  });
  assert.equal(headDrift.status, "failed");
  assert.match(headDrift.error ?? "", /head changed/i);

  for (const staged of [false, true]) {
    writeFileSync(join(work, "readme.md"), staged ? "staged\n" : "modified\n");
    if (staged) sh(work, "add", "readme.md");
    const dirty = await runPushWorkflow({
      cwd: work,
      expectedBranch: "main",
      expectedHead: head,
      requireClean: true,
    });
    assert.equal(dirty.status, "failed");
    assert.match(dirty.error ?? "", /staged, modified.*untracked/i);
    sh(work, "reset", "--hard", "HEAD");
  }

  writeFileSync(join(work, "untracked.txt"), "dirty\n");
  const untracked = await runPushWorkflow({
    cwd: work,
    expectedBranch: "main",
    expectedHead: head,
    requireClean: true,
  });
  assert.equal(untracked.status, "failed");
  assert.match(untracked.error ?? "", /staged, modified.*untracked/i);
  sh(work, "clean", "-f", "untracked.txt");

  const allowed = await runPushWorkflow({
    cwd: work,
    expectedBranch: "main",
    expectedHead: head,
    requireClean: true,
  });
  assert.equal(allowed.status, "pushed", allowed.error ?? allowed.output);
});

test("non-interactive authentication failures return promptly with progress", async () => {
  const solo = join(tmp, "auth-failure");
  mkdirSync(solo, { recursive: true });
  sh(solo, "init", "-b", "main");
  writeFileSync(join(solo, "a.txt"), "x\n");
  sh(solo, "add", "-A");
  sh(solo, "commit", "-m", "init");
  sh(solo, "remote", "add", "origin", "ssh://git@127.0.0.1:1/unreachable.git");
  const progress: string[] = [];
  const result = await runPushWorkflow({
    cwd: solo,
    onProgress: (message) => progress.push(message),
  });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /ssh|connect|connection/i);
  assert.equal(progress[0], "Resolving repository…");
  assert.match(progress[1] ?? "", /Pushing main/);
});

test("remote resolution uses tracked, origin, or sole remote and refuses ambiguity", async () => {
  const { work } = makeRepoPair("remote-resolution");
  sh(work, "remote", "rename", "origin", "sole");
  let target = await resolvePushTarget(work, "main");
  assert.equal(target.remote, "sole");
  assert.equal(target.upstream, undefined);

  await runPushWorkflow({ cwd: work });
  target = await resolvePushTarget(work, "main");
  assert.deepEqual(target.upstream, { remote: "sole", branch: "main" });

  sh(
    work,
    "remote",
    "add",
    "other",
    sh(work, "remote", "get-url", "sole").trim(),
  );
  sh(work, "branch", "--unset-upstream");
  await assert.rejects(resolvePushTarget(work, "main"), /Multiple remotes/);

  sh(work, "remote", "rename", "sole", "origin");
  target = await resolvePushTarget(work, "main");
  assert.equal(target.remote, "origin");
});
