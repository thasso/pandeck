import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "pi-skill-injection-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { SKILLS_LIBRARY_DIR, SKILLS_RUNTIME_DIR } = await import("../config.ts");
const { SkillRuntimeMaterializationError } =
  await import("../skills/skillRuntimeMaterializer.ts");
const { buildAgentOptions } = await import("./options.ts");

async function writeSkill(
  root: string,
  folder: string,
  name: string,
  proof = `${name} support file\n`,
): Promise<string> {
  const directory = join(root, folder);
  await mkdir(join(directory, "references"), { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} test skill\n---\n# ${name}\n`,
    "utf8",
  );
  await writeFile(join(directory, "references", "proof.txt"), proof, "utf8");
  return directory;
}

function projectSkillRoot(cwd: string): string {
  return join(cwd, ".pi", "skills");
}

test("coding option builders load whole frozen skill folders and recreate them on reload", async () => {
  await writeSkill(
    SKILLS_LIBRARY_DIR,
    "whole-folder-source",
    "whole-folder",
    "relative support works\n",
  );
  const cwd = join(tmp, "whole-folder-project");
  await mkdir(cwd, { recursive: true });

  const loaders = [];
  for (const agentType of ["developer", "workshop"] as const) {
    const options = await buildAgentOptions(
      agentType,
      cwd,
      "cp_test",
      undefined,
      ["whole-folder"],
    );
    const loaded = options.resourceLoader.getSkills();
    const skill = loaded.skills.find(({ name }) => name === "whole-folder");
    assert.ok(skill, `${agentType} loads the frozen library skill`);
    assert.ok(
      skill.baseDir.startsWith(`${resolve(SKILLS_RUNTIME_DIR)}/`),
      "pi sees the materialized path rather than the library source path",
    );
    assert.equal(
      await readFile(join(skill.baseDir, "references", "proof.txt"), "utf8"),
      "relative support works\n",
    );
    loaders.push({
      loader: options.resourceLoader,
      root: dirname(dirname(skill.baseDir)),
    });
  }

  const first = loaders[0]!;
  await rm(first.root, { recursive: true, force: true });
  await first.loader.reload();
  const reloaded = first.loader
    .getSkills()
    .skills.find(({ name }) => name === "whole-folder");
  assert.ok(
    reloaded,
    "reload recreates the frozen runtime after generated cleanup",
  );
  assert.equal(
    await readFile(join(reloaded.baseDir, "references", "proof.txt"), "utf8"),
    "relative support works\n",
  );
});

test("a missing frozen library skill fails option construction loudly", async () => {
  const cwd = join(tmp, "missing-project");
  await mkdir(cwd, { recursive: true });

  await assert.rejects(
    buildAgentOptions("developer", cwd, "cp_test", undefined, [
      "missing-frozen",
    ]),
    (error: unknown) =>
      error instanceof SkillRuntimeMaterializationError &&
      /Frozen skill "missing-frozen" is missing or invalid/.test(error.message),
  );
});

test("pi silently deduplicates a project skill and library skill with the same realpath", async () => {
  const source = await writeSkill(
    SKILLS_LIBRARY_DIR,
    "same-realpath-source",
    "same-realpath",
  );
  const cwd = join(tmp, "same-realpath-project");
  const projectRoot = projectSkillRoot(cwd);
  await mkdir(projectRoot, { recursive: true });
  await symlink(source, join(projectRoot, "linked-library-skill"), "dir");

  const options = await buildAgentOptions(
    "developer",
    cwd,
    "cp_test",
    undefined,
    ["same-realpath"],
  );
  const loaded = options.resourceLoader.getSkills();

  assert.equal(
    loaded.skills.filter(({ name }) => name === "same-realpath").length,
    1,
  );
  assert.equal(
    loaded.diagnostics.filter(
      ({ type, collision }) =>
        type === "collision" && collision?.name === "same-realpath",
    ).length,
    0,
  );
});

test("a same-name project skill shadows the library skill with pi's collision diagnostic", async () => {
  await writeSkill(
    SKILLS_LIBRARY_DIR,
    "library-shadow-source",
    "shadowed-skill",
    "library proof\n",
  );
  const cwd = join(tmp, "shadow-project");
  const projectRoot = projectSkillRoot(cwd);
  const projectSource = await writeSkill(
    projectRoot,
    "project-shadow-source",
    "shadowed-skill",
    "project proof\n",
  );

  const options = await buildAgentOptions(
    "developer",
    cwd,
    "cp_test",
    undefined,
    ["shadowed-skill"],
  );
  const loaded = options.resourceLoader.getSkills();
  const winner = loaded.skills.find(({ name }) => name === "shadowed-skill");
  const collision = loaded.diagnostics.find(
    ({ type, collision: detail }) =>
      type === "collision" && detail?.name === "shadowed-skill",
  )?.collision;

  assert.equal(winner?.filePath, join(projectSource, "SKILL.md"));
  assert.equal(collision?.winnerPath, join(projectSource, "SKILL.md"));
  assert.ok(
    collision?.loserPath.startsWith(`${resolve(SKILLS_RUNTIME_DIR)}/`),
    "the materialized library copy is the losing same-name skill",
  );
});

test("assistant personas receive neither project nor frozen library skills", async () => {
  const cwd = join(tmp, "assistant-project");
  await writeSkill(
    projectSkillRoot(cwd),
    "project-assistant-source",
    "project-assistant-skill",
  );

  for (const agentType of [
    "assistant",
    "personal-assistant",
    "workflow-coordinator",
  ] as const) {
    const options = await buildAgentOptions(
      agentType,
      cwd,
      "cp_test",
      undefined,
      ["not-even-in-the-library"],
    );
    assert.deepEqual(options.resourceLoader.getSkills(), {
      skills: [],
      diagnostics: [],
    });
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
