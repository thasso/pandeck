/**
 * Project repo provisioning against real temp git repos, focused on submodule
 * handling: the clone recurses submodules. Updating a checkout (pull + submodule
 * update) belongs to the worktree surface — see worktrees/worktreeSync.test.ts.
 *
 * Local file remotes need `protocol.file.allow=always`; we inject it into the
 * environment via `GIT_CONFIG_*` so the git processes spawned by the code under
 * test (which sets no such flag) accept the file:// submodules.
 *
 * Run: pnpm --filter @assistant/server test src/projectProvision.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "project-provision-test-"));
process.env.ASSISTANT_CWD = tmp;
// Allow file:// submodule transport for git subprocesses spawned by the code
// under test (it passes no `-c protocol.file.allow`); inherited via env.
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
process.env.GIT_CONFIG_VALUE_0 = "always";

const { updateSettings } = await import("./settings.ts");
const { cloneProjectRepo, projectRepoDir } =
  await import("./projectProvision.ts");

const reposRoot = join(tmp, "projects-root");
updateSettings({ projectsRoot: reposRoot });

/** Run git in `cwd` with a fixed identity and file-transport allowance. */
function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
    },
  );
}

/** A bare repo seeded with one commit on `main` via a throwaway working clone. */
function makeSeededBare(name: string, file: string, body: string): string {
  const bare = join(tmp, `${name}.git`);
  const seed = join(tmp, `${name}-seed`);
  mkdirSync(bare, { recursive: true });
  sh(bare, "init", "--bare", "-b", "main");
  execFileSync("git", ["clone", bare, seed], { encoding: "utf8" });
  writeFileSync(join(seed, file), body);
  sh(seed, "add", "-A");
  sh(seed, "commit", "-m", "seed");
  sh(seed, "push", "origin", "main");
  return bare;
}

/** A bare super repo with `sub` embedded as a submodule of `subBare`. */
function makeSuperWithSubmodule(
  name: string,
  subBare: string,
): { superBare: string; superWork: string } {
  const superBare = join(tmp, `${name}.git`);
  const superWork = join(tmp, `${name}-work`);
  mkdirSync(superBare, { recursive: true });
  sh(superBare, "init", "--bare", "-b", "main");
  execFileSync("git", ["clone", superBare, superWork], { encoding: "utf8" });
  writeFileSync(join(superWork, "top.txt"), "top\n");
  sh(superWork, "add", "-A");
  sh(superWork, "commit", "-m", "super init");
  sh(superWork, "submodule", "add", subBare, "sub");
  sh(superWork, "commit", "-m", "add submodule");
  sh(superWork, "push", "origin", "main");
  return { superBare, superWork };
}

test("cloneProjectRepo recurses submodules on clone", async () => {
  const subBare = makeSeededBare("clone-sub", "subfile.txt", "v1\n");
  const { superBare } = makeSuperWithSubmodule("clone-super", subBare);

  const dir = await cloneProjectRepo("proj-clone", superBare);
  assert.equal(dir, projectRepoDir("proj-clone"));
  assert.ok(existsSync(join(dir, "top.txt")), "superproject file checked out");
  assert.ok(
    existsSync(join(dir, "sub", "subfile.txt")),
    "submodule content checked out recursively",
  );
});
