/**
 * Guard-path tests for the `project_registry_write` `cloneRepo` operation
 * (Task 111): confirmation gating, repoUrl requirement, and unknown-project
 * handling — all before any git/network side effect runs.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "project-clone-tool-"));
process.env.DATA_DIR = join(tmp, "data");
process.env.ASSISTANT_CWD = tmp;

const { upsertProject, getProject } = await import("../../projectRegistry.ts");
const { projectRegistryWriteTool } = await import("./projectRegistryTools.ts");

const run = (params: Record<string, unknown>) =>
  // The write tool's execute ignores ctx; cast keeps the test focused on params.
  (projectRegistryWriteTool.execute as (p: unknown) => Promise<unknown>)(
    params,
  );

test("cloneRepo without confirm surfaces target path + url and never clones", async () => {
  upsertProject({
    id: "clone-me",
    name: "Clone Me",
    key: "CM",
    repoUrl: "ssh://example.test/repo.git",
  });
  await assert.rejects(
    () => run({ operation: "cloneRepo", id: "clone-me" }),
    /confirm=true/,
  );
  await assert.rejects(
    () => run({ operation: "cloneRepo", id: "clone-me" }),
    /repo\.git/,
  );
  await assert.rejects(
    () => run({ operation: "cloneRepo", id: "clone-me" }),
    /clone-me/,
  );
});

test("cloneRepo requires the project to have a repository URL", async () => {
  upsertProject({ id: "no-url", name: "No URL", key: "NU" });
  await assert.rejects(
    () => run({ operation: "cloneRepo", id: "no-url", confirm: true }),
    /repository URL/i,
  );
});

test("cloneRepo rejects an unknown project", async () => {
  await assert.rejects(
    () => run({ operation: "cloneRepo", id: "nope", confirm: true }),
    /not found/i,
  );
});

test("updateProject can set the managed clone URL (repoUrl), enabling cloneRepo", async () => {
  upsertProject({ id: "set-url", name: "Set URL", key: "SU" });
  await run({
    operation: "updateProject",
    id: "set-url",
    project: { repoUrl: "ssh://example.test/set.git" },
  });
  assert.equal(getProject("set-url")?.repoUrl, "ssh://example.test/set.git");
  // With repoUrl now set, cloneRepo passes the URL gate and only stops on confirmation.
  await assert.rejects(
    () => run({ operation: "cloneRepo", id: "set-url" }),
    /confirm=true/,
  );
});
