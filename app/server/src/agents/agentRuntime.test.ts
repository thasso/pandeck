/**
 * Whether a definition can run (`docs/agent-definitions.md` "Model and
 * effort", "Tools"): model resolution never guesses, effort is lowered to the
 * model, and denied tools and mounted skills must exist.
 *
 * Run with:
 *   pnpm --filter @assistant/server test src/agents/agentRuntime.test.ts
 */
import assert from "node:assert/strict";
import type { AppSettings, ModelOption } from "@assistant/shared";
import { describe, test } from "vitest";
import { pinnedModelIdsFor } from "../harnesses/models.ts";
import type { AgentManifest } from "./agentLibrary.ts";
import {
  checkAgentRuntime,
  resolveAgentModel,
  type AgentRuntimeSources,
} from "./agentRuntime.ts";

function model(
  provider: string,
  id: string,
  levels: ModelOption["supportedThinkingLevels"] = [
    "off",
    "low",
    "medium",
    "high",
  ],
): ModelOption {
  return {
    provider,
    id,
    name: id,
    reasoning: true,
    supportedThinkingLevels: levels,
    contextWindow: 200_000,
  };
}

const models = [
  model("claude-sdk", "opus"),
  model("claude-sdk", "sonnet"),
  model("openai-codex", "gpt-6.1-sol", ["low", "medium", "high", "xhigh"]),
  model("openai-codex", "gpt-6-luna"),
  model("openai-codex", "gpt-6-nova"),
  model("openai-codex", "gpt-6-nova-mini"),
];

const sources: AgentRuntimeSources = {
  models: async () => models,
  skillNames: async () => ["castlabs-ui"],
  toolNames: async (persona) =>
    persona === "developer"
      ? ["worktree_push", "worktree_commit", "task_read"]
      : ["task_read"],
};

const base: Pick<
  AgentManifest,
  "persona" | "models" | "effort" | "denyTools" | "skills"
> = {
  persona: "developer",
  models: ["opus"],
  denyTools: [],
  skills: [],
};

describe("resolveAgentModel", () => {
  test("an exact id or a Claude family alias resolves directly", () => {
    assert.equal(resolveAgentModel("opus", models).id, "opus");
    assert.equal(resolveAgentModel("GPT-6-LUNA", models).id, "gpt-6-luna");
  });

  test("a short OpenAI name matches one whole token of exactly one id", () => {
    assert.equal(resolveAgentModel("sol", models).id, "gpt-6.1-sol");
  });

  test("a name matching more than one model is refused, never guessed", () => {
    assert.throws(
      () => resolveAgentModel("nova", models),
      /matches more than one connected model \(openai-codex\/gpt-6-nova, openai-codex\/gpt-6-nova-mini\)/,
    );
    assert.throws(
      () => resolveAgentModel("opus", [...models, model("anthropic", "opus")]),
      /matches more than one connected model/,
    );
  });

  test("a concrete Claude id resolves to its alias only while the alias runs exactly it", () => {
    // The real pin data the models port reports for an enabled Claude account.
    const pins = pinnedModelIdsFor({ provider: "claude" }, {
      claudeSdk: { enabled: true },
    } as AppSettings);
    assert.ok(pins.size > 0);
    const live = [...pins].map(([key, pinnedId]) => ({
      ...model("claude-sdk", key.slice(key.indexOf(":") + 1)),
      pinnedId,
    }));
    for (const row of live)
      assert.equal(resolveAgentModel(row.pinnedId, live).id, row.id);
    // A version the alias no longer runs is refused, never moved to the alias.
    assert.throws(
      () => resolveAgentModel("claude-opus-1-0", live),
      /No enabled account offers a model "claude-opus-1-0"/,
    );
  });

  test("provider/id names one row when two providers offer the same id", () => {
    const twice = [...models, model("openai", "gpt-6-luna")];
    assert.throws(
      () => resolveAgentModel("gpt-6-luna", twice),
      /matches more than one connected model .*name one of them exactly, as provider\/id/,
    );
    const resolved = resolveAgentModel("openai/gpt-6-luna", twice);
    assert.equal(`${resolved.provider}/${resolved.id}`, "openai/gpt-6-luna");
  });

  test("provider/id also names a pin when two providers offer the concrete id", () => {
    const rows = [
      { ...model("claude-sdk", "opus"), pinnedId: "claude-opus-5-5" },
      model("anthropic", "claude-opus-5-5"),
    ];
    assert.throws(
      () => resolveAgentModel("claude-opus-5-5", rows),
      /matches more than one connected model/,
    );
    assert.equal(
      resolveAgentModel("claude-sdk/claude-opus-5-5", rows).provider,
      "claude-sdk",
    );
    assert.equal(
      resolveAgentModel("anthropic/claude-opus-5-5", rows).provider,
      "anthropic",
    );
    // A row without a pin is never matched as "provider/undefined".
    assert.throws(
      () => resolveAgentModel("anthropic/undefined", rows),
      /No enabled account offers/,
    );
    // Once the alias runs another version, the qualified pin is refused too.
    const moved = [
      { ...model("claude-sdk", "opus"), pinnedId: "claude-opus-6-0" },
    ];
    assert.throws(
      () => resolveAgentModel("claude-sdk/claude-opus-5-5", moved),
      /No enabled account offers a model "claude-sdk\/claude-opus-5-5"/,
    );
  });

  test("an unknown model names what is available, and no accounts says so", () => {
    assert.throws(
      () => resolveAgentModel("gemini", models),
      /No enabled account offers a model "gemini"\. .*claude-sdk\/opus/,
    );
    assert.throws(
      () => resolveAgentModel("opus", []),
      /no enabled account offers any model/,
    );
  });
});

describe("checkAgentRuntime", () => {
  /** The default (first) model's runtime. */
  async function defaultOf(
    manifest: typeof base,
    options: Parameters<typeof checkAgentRuntime>[1] = { sources },
  ) {
    return (await checkAgentRuntime(manifest, options))?.[0]?.runtime;
  }

  test("resolves the model and lowers the effort to what it supports", async () => {
    const runtime = await defaultOf({
      ...base,
      models: ["sol"],
      effort: "off",
    });
    assert.equal(runtime?.model.id, "gpt-6.1-sol");
    assert.equal(runtime?.thinkingLevel, "low");
    // No effort runs at the default, fitted the same way.
    assert.equal((await defaultOf(base))?.thinkingLevel, "medium");
    assert.equal(
      (await defaultOf({ ...base, models: ["sol"] }))?.thinkingLevel,
      "medium",
    );
    const highOnly = {
      ...sources,
      models: async () => [model("claude-sdk", "opus", ["off", "high"])],
    };
    assert.equal(
      (await defaultOf(base, { sources: highOnly }))?.thinkingLevel,
      "high",
    );
  });

  test("every listed model resolves in order, each with the effort fitted to it", async () => {
    const choices = await checkAgentRuntime(
      { ...base, models: ["sol", "opus"], effort: "off" },
      { sources },
    );
    assert.deepEqual(
      choices?.map((choice) => [
        choice.spec,
        choice.runtime?.model.id,
        choice.runtime?.thinkingLevel,
      ]),
      [
        ["sol", "gpt-6.1-sol", "low"],
        ["opus", "opus", "off"],
      ],
    );
  });

  test("authoring needs every listed model; a spawn reads each on its own", async () => {
    const manifest = { ...base, models: ["opus", "gemini"] };
    await assert.rejects(
      checkAgentRuntime(manifest, { sources }),
      /No enabled account offers a model "gemini"/,
    );
    const each = await checkAgentRuntime(manifest, {
      sources,
      checkModel: "each",
    });
    assert.equal(each?.[0]?.runtime?.model.id, "opus");
    assert.match(each?.[1]?.problem ?? "", /"gemini"/);
  });

  test("two specs for one model are refused when authoring", async () => {
    await assert.rejects(
      checkAgentRuntime(
        { ...base, models: ["sol", "gpt-6.1-sol"] },
        { sources },
      ),
      /Models "sol" and "gpt-6\.1-sol" both resolve to openai-codex\/gpt-6\.1-sol; list it once\./,
    );
  });

  test("a concrete version is reported as the pin; the alias is not", async () => {
    const pinnedSources = {
      ...sources,
      models: async () => [
        { ...model("claude-sdk", "opus"), pinnedId: "claude-opus-5-5" },
      ],
    };
    const pinned = await defaultOf(
      { ...base, models: ["claude-opus-5-5"] },
      { sources: pinnedSources },
    );
    assert.equal(pinned?.model.id, "opus");
    assert.equal(pinned?.pinnedModel, "claude-opus-5-5");
    assert.ok(!("pinnedId" in pinned!.model));
    const alias = await defaultOf(base, { sources: pinnedSources });
    assert.equal(alias?.pinnedModel, undefined);
  });

  test("denied tools must be the persona's own or a native capability", async () => {
    await checkAgentRuntime(
      { ...base, denyTools: ["worktree_push", "bash", "edit", "write"] },
      { sources },
    );
    await assert.rejects(
      checkAgentRuntime(
        { ...base, persona: "assistant", denyTools: ["worktree_push"] },
        { sources },
      ),
      /tools\.deny names worktree_push, which the assistant persona does not have/,
    );
    // An assistant has no native tools to deny.
    await assert.rejects(
      checkAgentRuntime(
        { ...base, persona: "assistant", denyTools: ["bash"] },
        { sources },
      ),
      /tools\.deny names bash, which the assistant persona does not have; deny only its own tools \(unprefixed, e\.g\. worktree_push\)\./,
    );
  });

  test("every problem is reported in one refusal", async () => {
    await assert.rejects(
      checkAgentRuntime(
        {
          ...base,
          models: ["gemini"],
          denyTools: ["worktree_pusj"],
          skills: ["missing-skill"],
        },
        { sources },
      ),
      (error: Error) =>
        /No enabled account offers a model "gemini"/.test(error.message) &&
        /worktree_pusj/.test(error.message) &&
        /skills names missing-skill/.test(error.message),
    );
  });

  test("the model can be left unchecked for edits that keep it", async () => {
    assert.equal(
      await checkAgentRuntime(
        { ...base, models: ["retired-model"] },
        { sources, checkModel: false },
      ),
      undefined,
    );
  });
});
