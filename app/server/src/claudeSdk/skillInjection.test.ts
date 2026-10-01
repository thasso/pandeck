import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "claude-skill-injection-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { SKILLS_LIBRARY_DIR } = await import("../config.ts");
const { SkillRuntimeMaterializationError } =
  await import("../skills/skillRuntimeMaterializer.ts");
const { buildClaudeSdkQueryOptions } = await import("./options.ts");
const { prepareClaudeSkillRuntime } = await import("./skillInjection.ts");

async function writeSkill(): Promise<{ supportFile: string }> {
  const directory = join(SKILLS_LIBRARY_DIR, "whole-folder-source");
  const supportFile = join(directory, "references", "proof.txt");
  await mkdir(join(directory, "references"), { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    "---\nname: whole-folder\ndescription: Reads a relative support file\n---\n# Whole folder\n\nRead `references/proof.txt`.\n",
    "utf8",
  );
  await writeFile(supportFile, "first live value\n", "utf8");
  return { supportFile };
}

function codingOptions() {
  return buildClaudeSdkQueryOptions({
    cwd: tmp,
    abortController: new AbortController(),
    modelId: "sonnet",
    thinkingLevel: "low",
    agentType: "developer",
    frozenSkillNames: ["whole-folder"],
  });
}

function pluginRoot(): string {
  const plugins = codingOptions().plugins as
    Array<{ path: string }> | undefined;
  assert.equal(plugins?.length, 1);
  return plugins[0]!.path;
}

test("Claude plugin materialization preserves live relative supporting files and recreates generated output", async () => {
  const { supportFile } = await writeSkill();
  await prepareClaudeSkillRuntime(["whole-folder"]);

  const root = pluginRoot();
  const runtimeSupport = join(
    root,
    "skills",
    "whole-folder",
    "references",
    "proof.txt",
  );
  assert.equal(await readFile(runtimeSupport, "utf8"), "first live value\n");

  await writeFile(supportFile, "uncommitted second value\n", "utf8");
  assert.equal(
    await readFile(runtimeSupport, "utf8"),
    "uncommitted second value\n",
    "the whole-folder symlink exposes current supporting-file bytes",
  );

  await rm(root, { recursive: true, force: true });
  await prepareClaudeSkillRuntime(["whole-folder"]);
  assert.equal(
    await readFile(runtimeSupport, "utf8"),
    "uncommitted second value\n",
    "a resumed query can recreate a deleted runtime from the frozen names",
  );

  const options = codingOptions();
  assert.equal(
    (options as { skills?: unknown }).skills,
    undefined,
    "library injection does not filter normal repository skill discovery",
  );
  assert.equal(options.settingSources, undefined);
});

test("a missing frozen skill fails Claude runtime preparation loudly", async () => {
  await assert.rejects(
    prepareClaudeSkillRuntime(["missing-frozen"]),
    (error: unknown) =>
      error instanceof SkillRuntimeMaterializationError &&
      /Frozen skill "missing-frozen" is missing or invalid/.test(error.message),
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
