/**
 * Task 281: the prompt/schema inventory is a committed measurement, so the
 * things that would let it silently lie are pinned here.
 *
 *   pnpm --filter @assistant/server test src/promptInventory.test.ts
 *
 * Pinned: the row set per harness (a layer cannot vanish from the table without
 * this failing), reconciliation of the counted rows against the real assembled
 * prompt, the resolved source of every file-backed layer (the packaged assets by
 * default since Task-291, and a hard failure for a directory without them), and
 * the reach into pi's internal `buildSystemPrompt`, which a pi upgrade could
 * move.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { AGENT_TYPES } from "./agentTypes.ts";
import type { AgentType } from "@assistant/shared";
import { PACKAGED_PROMPTS_DIR } from "./config.ts";
import {
  loadPiPromptBuilder,
  piBuiltinDefinitionChars,
  PI_PACKAGE_LABEL,
} from "./piSdk/piPromptMeasure.ts";
import { PromptAssetError } from "./promptAssets.ts";
import {
  promptInventory,
  REPO_PROMPTS_DIR,
  REPO_ROOT,
  type PersonaInventory,
} from "./promptInventory.ts";

const AGENT_TYPE_LIST = Object.keys(AGENT_TYPES) as AgentType[];

/**
 * The conditional persona sections (Task 287) each persona can carry, in
 * composition order. The inventory measures with every condition ON, so they
 * all appear — for the personas whose prompt has them.
 */
const CONDITIONAL_LAYER_IDS: Record<AgentType, string[]> = {
  assistant: ["integration:slack", "integration:google"],
  "personal-assistant": ["integration:tempo"],
  workshop: [],
  developer: [],
  "workflow-coordinator": [],
};

/** Rows every persona reports on the pi harness, in order. */
const PI_LAYER_IDS = [
  "harness-base",
  "harness-base:pi-docs",
  "pi-tool-list:builtin",
  "pi-tool-list:app-eager",
  "pi-guidelines:builtin",
  "pi-guidelines:app-eager",
  "persona",
  "conditional",
  "project-registry",
  "chat-files",
  "chat-math",
  "kb-guidance",
  "memory-guidance",
  "profile-suffix",
  "project-context",
  "assembly-overhead",
  "tools:eager:names",
  "tools:eager:descriptions",
  "tools:eager:schemas",
  "tools:eager:harness-builtin",
  "tools:deferred:universe",
];

/** Rows every persona reports on the Claude harness, in order. */
const CLAUDE_LAYER_IDS = [
  "harness-base",
  "persona",
  "conditional",
  "project-registry",
  "chat-files",
  "chat-math",
  "kb-guidance",
  "memory-guidance",
  "profile-suffix",
  "project-context",
  "assembly-overhead",
  "tools:eager:names",
  "tools:eager:descriptions",
  "tools:eager:schemas",
  "tools:eager:harness-builtin",
  "tools:deferred:universe",
];

/** `persona:<agentType>` is reported as the generic `persona` row here. */
function layerIds(persona: PersonaInventory): string[] {
  return persona.layers.map((l) =>
    l.id === `persona:${persona.agentType}` ? "persona" : l.id,
  );
}

/** The baseline row set with this persona's conditional sections spliced in. */
function expectedLayerIds(baseline: string[], agentType: AgentType): string[] {
  return baseline.flatMap((id) => {
    if (id === "conditional") return CONDITIONAL_LAYER_IDS[agentType];
    if (
      agentType === "workflow-coordinator" &&
      [
        "project-registry",
        "chat-files",
        "chat-math",
        "kb-guidance",
        "memory-guidance",
      ].includes(id)
    )
      return [];
    return [id];
  });
}

function find(
  personas: PersonaInventory[],
  agentType: AgentType,
  harness: string,
) {
  const found = personas.find(
    (p) => p.agentType === agentType && p.harness === harness,
  );
  assert.ok(found, `no inventory for ${agentType}/${harness}`);
  return found;
}

describe("prompt inventory", () => {
  test("pi's internal buildSystemPrompt is still reachable", async () => {
    const builder = await loadPiPromptBuilder();
    assert.match(builder.modulePath, /pi-coding-agent.*system-prompt\.js$/);
    const prompt = builder.build({
      cwd: REPO_ROOT,
      contextFiles: [],
      selectedTools: [],
      toolSnippets: {},
      promptGuidelines: [],
    });
    assert.ok(
      prompt.includes("<tools>") && prompt.includes("<rules>"),
      "pi's default prompt no longer has the shape the inventory decomposes",
    );
  });

  test("pi's install path is normalized out, so the sizes travel", async () => {
    const builder = await loadPiPromptBuilder();
    const prompt = builder.build({
      cwd: "/repo",
      contextFiles: [],
      selectedTools: [],
      toolSnippets: {},
      promptGuidelines: [],
    });
    // pi's default prompt names its own README/docs/examples by absolute path.
    // Left raw, the measured length would depend on where the checkout lives —
    // a CI container's /workspace against a developer's home directory.
    assert.ok(
      !prompt.includes(builder.packageRoot),
      `the measured prompt still carries pi's install path ${builder.packageRoot}`,
    );
    assert.ok(
      prompt.includes(`${PI_PACKAGE_LABEL}/README.md`),
      "pi's documentation block no longer resolves under the normalized label",
    );
  });

  test("every persona is measured on both harnesses with a stable row set", async () => {
    const report = await promptInventory({ promptsDir: REPO_PROMPTS_DIR });
    assert.deepEqual(
      [...new Set(report.personas.map((p) => p.agentType))].sort(),
      [...AGENT_TYPE_LIST].sort(),
    );
    for (const agentType of AGENT_TYPE_LIST) {
      assert.deepEqual(
        layerIds(find(report.personas, agentType, "pi")),
        expectedLayerIds(PI_LAYER_IDS, agentType),
        `${agentType}/pi layer rows changed — update the baseline with them`,
      );
      assert.deepEqual(
        layerIds(find(report.personas, agentType, "claude")),
        expectedLayerIds(CLAUDE_LAYER_IDS, agentType),
        `${agentType}/claude layer rows changed — update the baseline with them`,
      );
    }
  });

  test("counted rows reconcile with the real assembled prompt", async () => {
    const report = await promptInventory({ promptsDir: REPO_PROMPTS_DIR });
    for (const persona of report.personas) {
      assert.equal(
        persona.promptChars,
        persona.assembledPromptChars,
        `${persona.agentType}/${persona.harness}: counted prompt rows must sum to the assembled prompt`,
      );
      assert.ok(persona.reconciled);
      assert.ok(
        persona.eagerToolChars > 0 && persona.firstRequestChars > 0,
        `${persona.agentType}/${persona.harness}: empty tool block`,
      );
      for (const layer of persona.layers)
        assert.ok(
          layer.source.length > 0,
          `${persona.agentType}/${persona.harness}: layer ${layer.id} reports no source`,
        );
    }
  });

  test("layer sources record tracked files, not just sizes", async () => {
    const report = await promptInventory({ promptsDir: REPO_PROMPTS_DIR });
    for (const persona of report.personas) {
      const byId = new Map(persona.layers.map((l) => [l.id, l]));
      assert.match(
        byId.get(`persona:${persona.agentType}`)?.source ?? "",
        /config\/prompts\/.*\.md$/,
        `${persona.agentType}/${persona.harness}: persona layer must name its tracked file`,
      );
      if (persona.agentType === "workflow-coordinator") {
        assert.equal(byId.get("project-registry"), undefined);
        assert.equal(byId.get("kb-guidance"), undefined);
      } else {
        assert.match(
          byId.get("project-registry")?.source ?? "",
          /config\/prompts\/project-registry\.md$/,
        );
        assert.equal(byId.get("kb-guidance")?.source, "builtin-code");
      }
    }
  });

  test("the default measurement is the packaged prompt assets", async () => {
    // No promptsDir override. Before Task-291 this measured built-in fallbacks,
    // because the vitest harness (like production) pointed ASSISTANT_CWD at a
    // directory with no prompts in it.
    const report = await promptInventory();
    assert.equal(report.promptsDir, PACKAGED_PROMPTS_DIR);
    assert.equal(PACKAGED_PROMPTS_DIR, REPO_PROMPTS_DIR);
    for (const persona of report.personas)
      for (const id of [
        `persona:${persona.agentType}`,
        ...(persona.agentType === "workflow-coordinator"
          ? []
          : ["project-registry"]),
      ])
        assert.match(
          persona.layers.find((l) => l.id === id)?.source ?? "",
          /config\/prompts\/.*\.md$/,
          `${persona.agentType}/${persona.harness}: ${id} must name its tracked file`,
        );
  });

  test("measuring a directory without the assets fails, never guesses", async () => {
    const empty = mkdtempSync(join(tmpdir(), "prompt-inventory-empty-"));
    await assert.rejects(
      promptInventory({ promptsDir: empty }),
      PromptAssetError,
    );
  });

  test("pi renders no app tool guidance for ANY persona", async () => {
    // Was finding #1 of the sub-epic (the assistant personas lost all tool
    // guidance on the customPrompt branch); since Task-282 deleted
    // promptSnippet/promptGuidelines it holds for every persona, and the
    // coding rows are zero too. Our tools reach a pi session only through the
    // tool-definition block and find_tools — the accepted consequence.
    const report = await promptInventory({ promptsDir: REPO_PROMPTS_DIR });
    for (const agentType of AGENT_TYPE_LIST) {
      const persona = find(report.personas, agentType, "pi");
      for (const id of ["pi-tool-list:app-eager", "pi-guidelines:app-eager"])
        assert.equal(
          persona.layers.find((l) => l.id === id)?.chars,
          0,
          `${agentType}: ${id} must be zero — app tools carry no prompt extras`,
        );
    }
    // pi's own builtins still populate both lists for the coding personas.
    for (const agentType of ["workshop", "developer"] as const) {
      const persona = find(report.personas, agentType, "pi");
      for (const id of ["pi-tool-list:builtin", "pi-guidelines:builtin"])
        assert.ok(
          (persona.layers.find((l) => l.id === id)?.chars ?? 0) > 0,
          `${agentType}: ${id} should still measure pi's builtins`,
        );
    }
  });

  test("the harness's own tool definitions are priced, not just their snippets", async () => {
    // Task-316: pi's prompt carries a one-line snippet per builtin, but the
    // DEFINITIONS (name + description + schema) are the real wire cost and used
    // to be missing from the report entirely — which would have priced enabling
    // grep/find at ~126 chars instead of ~2k.
    const report = await promptInventory({ promptsDir: REPO_PROMPTS_DIR });
    const expected = piBuiltinDefinitionChars(report.cwd);
    const row = (agentType: AgentType, harness: string) =>
      find(report.personas, agentType, harness).layers.find(
        (l) => l.id === "tools:eager:harness-builtin",
      )!;

    for (const agentType of ["workshop", "developer"] as const) {
      const pi = row(agentType, "pi");
      assert.equal(
        pi.chars,
        expected.reduce((n, tool) => n + tool.chars, 0),
        `${agentType}: the builtin definition row must price every active builtin`,
      );
      assert.ok(pi.counted, "pi's builtins reach the model and must count");
      for (const name of ["grep", "find"])
        assert.ok(
          pi.note?.includes(name),
          `${agentType}: the row must break out ${name}`,
        );
    }
    for (const agentType of ["assistant", "personal-assistant"] as const)
      assert.equal(
        row(agentType, "pi").chars,
        0,
        `${agentType}: runs noTools: "builtin" and carries no builtin block`,
      );
    // Claude's natives ship inside the CLI: reported, never guessed.
    const claude = row("workshop", "claude");
    assert.equal(claude.chars, 0);
    assert.equal(claude.counted, false);
    assert.match(claude.note ?? "", /NOT measurable in-process/);
  });
});
