/**
 * Task 290/291: prompt-asset resolution is observable, packaged, and never
 * silently degraded.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/promptAssets.test.ts
 *
 * The suite's own environment is the strongest available proof of the Task-291
 * contract: `test/setup.ts` points `ASSISTANT_CWD` at a temp directory — the
 * same defect shape production had — and every persona must STILL resolve its
 * tracked markdown from the packaged directory. A missing asset must throw, and
 * the `ASSISTANT_PROMPTS_DIR` override must be validated rather than silently
 * ignored.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { AGENT_TYPES, type AgentType } from "./agentTypes.ts";
import {
  CWD,
  PACKAGED_PROMPTS_DIR,
  packagedPromptsDirFor,
  PROMPTS_DIR,
  resolvePromptsDirFrom,
} from "./config.ts";
import {
  assertPromptAssets,
  promptAssetProblems,
  personaPromptText,
  PromptAssetError,
  promptAssetDiagnostic,
  promptAssetInventory,
  TRACKED_PROMPT_ASSETS,
} from "./promptAssets.ts";

/** The repository's tracked prompt assets, independent of `ASSISTANT_CWD`. */
const repoPromptsDir = fileURLToPath(
  new URL("../../../config/prompts", import.meta.url),
);

const AGENT_TYPE_LIST = Object.keys(AGENT_TYPES) as AgentType[];

test("prompt lookup is packaged, not derived from the working directory", () => {
  // The harness's ASSISTANT_CWD is a temp dir with no config/prompts in it. If
  // resolution were cwd-derived (Task-262), everything below would miss.
  assert.ok(CWD.startsWith(tmpdir()), "the suite roots CWD at a temp dir");
  assert.equal(
    PROMPTS_DIR,
    PACKAGED_PROMPTS_DIR,
    "the running process resolves the packaged prompt assets",
  );
  assert.equal(
    PROMPTS_DIR,
    repoPromptsDir,
    "in a checkout the packaged directory IS config/prompts",
  );
  assert.ok(
    !PROMPTS_DIR.startsWith(CWD),
    `PROMPTS_DIR (${PROMPTS_DIR}) must not live under CWD (${CWD})`,
  );
  assert.deepEqual(
    promptAssetProblems(),
    [],
    "every tracked asset is readable in the packaged directory",
  );
});

test("only the retained persona/project assets are required and packaged", () => {
  assert.deepEqual([...TRACKED_PROMPT_ASSETS].sort(), [
    "assistant.md",
    // Shared, unconditional: how a session SHOWS a file it produced
    // (Task 636).
    "chat-files.md",
    // Shared, unconditional: the `$$` math syntax the chat renderer parses.
    "chat-math.md",
    "developer.md",
    // Conditional sections (Task 287) ship like every other persona layer:
    // a session that meets the condition must find them packaged.
    "integration-google.md",
    "integration-slack.md",
    "integration-tempo.md",
    "personal-assistant.md",
    "project-registry.md",
    "workflow-coordinator.md",
    "workshop.md",
  ]);
  // Task-264 deleted the Task-workflow role prompts; repairing resolution must
  // not resurrect or ship them (the boundary note on Task-262).
  const packaged = readdirSync(PACKAGED_PROMPTS_DIR);
  for (const name of packaged)
    assert.doesNotMatch(
      name,
      /^(role-|planner|plan-reviewer|implementer|reviewer|project-manager)/,
      `${name} is a deleted workflow-role prompt`,
    );
});

test("in a checkout, the prompts directory is resolved relative to the server sources", () => {
  // Dev, tests and worktree dev servers run the sources, so prompts resolve off
  // `import.meta.url`, never off the agent's working directory. The packaged
  // Bun bundle resolves them from its runtime asset root instead, which its
  // install check covers.
  assert.equal(
    packagedPromptsDirFor(
      "file:///tmp/example/personal-assistant/app/server/src/config.ts",
    ),
    "/tmp/example/personal-assistant/config/prompts",
  );
});

test("every persona resolves its packaged prompt assets from tracked files", () => {
  const inventory = promptAssetInventory();
  assert.equal(inventory.promptsDir, PACKAGED_PROMPTS_DIR);
  assert.deepEqual(
    inventory.personas.map((p) => p.agentType).sort(),
    [...AGENT_TYPE_LIST].sort(),
    "the inventory covers every persona in the registry",
  );
  for (const persona of inventory.personas) {
    const byId = new Map(persona.layers.map((l) => [l.id, l]));
    const file = byId.get(`persona:${persona.agentType}`);
    const registry = byId.get("project-registry");
    assert.equal(
      file?.source,
      "file",
      `${persona.agentType} persona layer must come from its markdown asset`,
    );
    if (persona.agentType === "workflow-coordinator") {
      assert.equal(
        registry,
        undefined,
        "the coordinator receives Task context only",
      );
      assert.equal(persona.layers.length, 1);
      continue;
    }
    assert.equal(
      registry?.source,
      "file",
      `${persona.agentType} project-registry layer must come from its markdown asset`,
    );
    // The code-built layers have no file form and must say so.
    for (const id of ["kb-guidance", "memory-guidance"])
      assert.equal(
        byId.get(id)?.source,
        "builtin-code",
        `${persona.agentType} ${id} is generated in code`,
      );
    for (const layer of persona.layers) {
      assert.ok(layer.chars > 0, `${persona.agentType} ${layer.id} is empty`);
      assert.match(
        layer.hash,
        /^[0-9a-f]{12}$/,
        `${persona.agentType} ${layer.id} exposes a hash`,
      );
    }
    assert.ok(
      persona.chars >= persona.layers.reduce((sum, l) => sum + l.chars, 0),
      "the composed size covers every layer",
    );
  }
  const diagnostic = promptAssetDiagnostic();
  assert.equal(diagnostic.level, "info");
  assert.match(diagnostic.lines[0] ?? "", /resolved 11\/11 .*\(packaged\)/);
});

test("a missing prompt asset throws instead of degrading to built-in text", () => {
  const empty = mkdtempSync(join(tmpdir(), "prompt-assets-empty-"));
  assert.deepEqual(
    promptAssetProblems({ promptsDir: empty }),
    [...TRACKED_PROMPT_ASSETS]
      .sort()
      .map((file) => ({ file, problem: "missing" })),
    "the non-throwing check names every missing file",
  );
  for (const agentType of AGENT_TYPE_LIST)
    assert.throws(
      () => personaPromptText(agentType, { promptsDir: empty }),
      (err: unknown) =>
        err instanceof PromptAssetError &&
        err.path.startsWith(empty) &&
        err.problem === "missing" &&
        /prompt asset missing/.test(err.message),
      `${agentType} must fail loudly when its asset is missing`,
    );

  const diagnostic = promptAssetDiagnostic({ promptsDir: empty });
  assert.equal(diagnostic.level, "warn");
  for (const file of TRACKED_PROMPT_ASSETS)
    assert.ok(
      diagnostic.lines[0]?.includes(file),
      `the diagnostic names ${file}`,
    );
});

test("one missing asset fails only the personas that need it", () => {
  // The genuinely supported partial case: an override directory mid-edit. The
  // personas whose assets are present still resolve from file.
  const partial = mkdtempSync(join(tmpdir(), "prompt-assets-partial-"));
  for (const file of TRACKED_PROMPT_ASSETS)
    if (file !== "workshop.md") writeFileSync(join(partial, file), `# ${file}`);
  assert.deepEqual(promptAssetProblems({ promptsDir: partial }), [
    { file: "workshop.md", problem: "missing" },
  ]);
  assert.throws(
    () => personaPromptText("workshop", { promptsDir: partial }),
    PromptAssetError,
  );
  assert.ok(personaPromptText("developer", { promptsDir: partial }).length > 0);
});

test("a present-but-unusable asset is caught by the startup check, not by the first session", () => {
  // Existence is not readability: a directory (or an unreadable/empty file) at
  // an asset path would satisfy an existsSync check, report a healthy install,
  // and then throw EISDIR on the first session of that persona. The startup
  // check performs the same READ resolution does.
  const dirs = mkdtempSync(join(tmpdir(), "prompt-assets-unreadable-"));
  for (const file of TRACKED_PROMPT_ASSETS) mkdirSync(join(dirs, file));
  assert.deepEqual(
    promptAssetProblems({ promptsDir: dirs }),
    [...TRACKED_PROMPT_ASSETS]
      .sort()
      .map((file) => ({ file, problem: "unreadable (EISDIR)" })),
  );
  assert.equal(promptAssetDiagnostic({ promptsDir: dirs }).level, "warn");
  assert.throws(
    () => assertPromptAssets({ promptsDir: dirs, packagedDir: dirs }),
    /not usable .*developer\.md \(unreadable \(EISDIR\)\)/,
  );
  assert.throws(
    () => personaPromptText("developer", { promptsDir: dirs }),
    (err: unknown) =>
      err instanceof PromptAssetError && err.problem === "unreadable (EISDIR)",
  );
});

test("a whitespace-only asset is unusable at resolution time too, not silently dropped", () => {
  // Composition trims and drops empty layers, so accepting blank content would
  // remove the persona layer without a word. The startup check and resolution
  // share one judgement (`readPromptAsset`), so they cannot disagree: whatever
  // the diagnostic calls unusable also fails the session, including under the
  // ASSISTANT_PROMPTS_DIR override where startup only warns.
  const blank = mkdtempSync(join(tmpdir(), "prompt-assets-blank-"));
  for (const file of TRACKED_PROMPT_ASSETS)
    writeFileSync(
      join(blank, file),
      file === "workshop.md" ? "\n  \n" : `# ${file}`,
    );
  assert.deepEqual(promptAssetProblems({ promptsDir: blank }), [
    { file: "workshop.md", problem: "empty" },
  ]);
  assert.throws(
    () => personaPromptText("workshop", { promptsDir: blank }),
    (err: unknown) =>
      err instanceof PromptAssetError &&
      err.problem === "empty" &&
      err.path === join(blank, "workshop.md"),
    "an empty persona asset must throw, not compose a prompt without its persona layer",
  );
  // The shared project-registry layer is judged the same way.
  writeFileSync(join(blank, "project-registry.md"), "   ");
  assert.throws(
    () => personaPromptText("developer", { promptsDir: blank }),
    (err: unknown) =>
      err instanceof PromptAssetError && err.problem === "empty",
  );
  assert.throws(
    () => assertPromptAssets({ promptsDir: blank, packagedDir: blank }),
    /project-registry\.md \(empty\), workshop\.md \(empty\)/,
  );
});

test("startup refuses to serve on an unusable PACKAGED directory", () => {
  // The real installation is complete, so the fatal branch is exercised by
  // treating a temp dir as the packaged one.
  assertPromptAssets();
  const empty = mkdtempSync(join(tmpdir(), "prompt-assets-startup-"));
  assert.throws(
    () => assertPromptAssets({ promptsDir: empty, packagedDir: empty }),
    /packaged prompt assets are not usable/,
  );
  // The same directory as a development OVERRIDE only warns: the user is
  // editing those files, and the failure surfaces per session instead.
  assertPromptAssets({ promptsDir: empty, packagedDir: PACKAGED_PROMPTS_DIR });
});

test("the ASSISTANT_PROMPTS_DIR override is validated, never silently ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-assets-override-"));
  assert.equal(resolvePromptsDirFrom(undefined), PACKAGED_PROMPTS_DIR);
  assert.equal(resolvePromptsDirFrom("  "), PACKAGED_PROMPTS_DIR);
  assert.equal(resolvePromptsDirFrom(dir), dir);
  // A relative override would reintroduce the working-directory coupling.
  assert.throws(
    () => resolvePromptsDirFrom("config/prompts"),
    /must be an absolute path/,
  );
  assert.throws(
    () => resolvePromptsDirFrom(join(dir, "nope")),
    /is not a directory/,
  );
  const file = join(dir, "assistant.md");
  writeFileSync(file, "# not a directory");
  assert.throws(() => resolvePromptsDirFrom(file), /is not a directory/);
});

test("the inventory reports the same prompt each persona actually ships", () => {
  for (const agentType of AGENT_TYPE_LIST) {
    const composed = personaPromptText(agentType);
    assert.equal(
      composed,
      AGENT_TYPES[agentType].systemPrompt(),
      `${agentType}'s inventory composition is the live system prompt`,
    );
    const persona = promptAssetInventory().personas.find(
      (p) => p.agentType === agentType,
    );
    assert.equal(
      persona?.chars,
      composed.length,
      `${agentType}'s reported size is the shipped prompt's size`,
    );
  }
});
