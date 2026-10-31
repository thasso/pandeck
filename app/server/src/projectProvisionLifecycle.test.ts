/**
 * Project provisioning on the Worker (W5): the clone's checks and mkdir and
 * the managed clone's delete run on the project's main side, and a Worker
 * failure rejects before the step it guards (`docs/workers.md`, W5).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "project-provision-lifecycle-"));
process.env.ASSISTANT_CWD = tmp;

const { updateSettings } = await import("./settings.ts");
const { upsertProject, getProject } = await import("./projectRegistry.ts");
const { cloneAndRegisterProjectRepo, deleteProjectRepoFolder, projectRepoDir } =
  await import("./projectProvision.ts");
const { isWorkerFailure } = await import("./workers/fileClient.ts");
const { scriptWorkerAnswersForTests } = await import("./test/workerAnswers.ts");
const { FILE_METHODS } = await import("./workerProtocol/fileMethods.ts");
const { LIFECYCLE_METHODS } =
  await import("./workerProtocol/lifecycleMethods.ts");

const reposRoot = join(tmp, "projects-root");
updateSettings({ projectsRoot: reposRoot });

/** A bare repository with one commit on `main`. */
function seededBare(name: string): string {
  const bare = join(tmp, `${name}.git`);
  const seed = join(tmp, `${name}-seed`);
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  execFileSync("git", ["clone", "--quiet", bare, seed]);
  writeFileSync(join(seed, "readme.md"), "hello\n");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
      { cwd: seed },
    );
  git("add", "-A");
  git("commit", "-qm", "seed");
  git("push", "-q", "origin", "main");
  return bare;
}

type Script = ReturnType<typeof scriptWorkerAnswersForTests>;
const scripts: Script[] = [];
function script(...args: Parameters<typeof scriptWorkerAnswersForTests>) {
  const armed = scriptWorkerAnswersForTests(...args);
  scripts.push(armed);
  return armed;
}
afterEach(() => {
  while (scripts.length > 0) scripts.pop()!.disarm();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("it resolved");
}

let keys = 0;
function project(id: string, repoUrl?: string): void {
  upsertProject({
    id,
    name: id,
    key: `PV${++keys}`,
    ...(repoUrl ? { repoUrl } : {}),
  });
}

test("(a) a Worker failure at the clone's pre-check rejects before any clone", async () => {
  const bare = seededBare("pre-check");
  project("pre-check", `file://${bare}`);
  const dir = projectRepoDir("pre-check");
  const exists = script(FILE_METHODS.exists, [
    { match: (request) => request.path === join(dir, ".git"), action: "fail" },
  ]);
  const error = await rejection(cloneAndRegisterProjectRepo("pre-check"));
  assert.ok(isWorkerFailure(error), String(error));
  assert.ok(exists.seen.some((request) => request.action === "fail"));
  assert.equal(existsSync(dir), false, "nothing cloned");
  assert.deepEqual(getProject("pre-check")?.localPaths ?? [], []);

  exists.disarm();
  const clone = await cloneAndRegisterProjectRepo("pre-check");
  assert.equal(clone.cloned, true);
  assert.ok(existsSync(join(dir, "readme.md")));
});

test("(b) a Worker failure deleting the managed clone rejects, and a retry removes it", async () => {
  project("to-delete");
  const dir = projectRepoDir("to-delete");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "file.txt"), "x");
  const removeAll = script(LIFECYCLE_METHODS.removeAll, [
    { match: (request) => request.path === resolve(dir), action: "fail" },
  ]);
  const error = await rejection(deleteProjectRepoFolder("to-delete"));
  assert.ok(isWorkerFailure(error), String(error));
  assert.ok(existsSync(join(dir, "sub", "file.txt")), "nothing deleted");

  removeAll.disarm();
  assert.equal(await deleteProjectRepoFolder("to-delete"), true);
  assert.equal(existsSync(dir), false);
});

test("(b) a Worker failure at the delete's existence check rejects too", async () => {
  project("delete-probe");
  const dir = projectRepoDir("delete-probe");
  mkdirSync(dir, { recursive: true });
  script(FILE_METHODS.exists, [
    { match: (request) => request.path === resolve(dir), action: "fail" },
  ]);
  const removeAll = script(LIFECYCLE_METHODS.removeAll, []);
  const error = await rejection(deleteProjectRepoFolder("delete-probe"));
  assert.ok(isWorkerFailure(error), String(error));
  assert.deepEqual(removeAll.seen, []);
  assert.ok(existsSync(dir));
});

test("(g) a relative projects root deletes the directory base would", async () => {
  const absoluteRoot = join(tmp, "relative-root");
  updateSettings({ projectsRoot: relative(process.cwd(), absoluteRoot) });
  try {
    project("relative");
    const target = join(absoluteRoot, "relative");
    mkdirSync(join(target, "keep"), { recursive: true });
    const removeAll = script(LIFECYCLE_METHODS.removeAll, []);
    assert.equal(await deleteProjectRepoFolder("relative"), true);
    // Base resolved the path against the process's cwd and deleted that.
    assert.deepEqual(
      removeAll.seen.map((request) => request.path),
      [target],
    );
    assert.equal(existsSync(target), false);
    assert.ok(existsSync(absoluteRoot), "the root itself stays");
  } finally {
    updateSettings({ projectsRoot: reposRoot });
  }
});
