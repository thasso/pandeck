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
  "persona" | "model" | "effort" | "denyTools" | "skills"
> = {
  persona: "developer",
  model: "opus",
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
  test("resolves the model and lowers the effort to what it supports", async () => {
    const runtime = await checkAgentRuntime(
      { ...base, model: "sol", effort: "off" },
      { sources },
    );
    assert.equal(runtime?.model.id, "gpt-6.1-sol");
    assert.equal(runtime?.thinkingLevel, "low");
    // No effort runs at the default, fitted the same way.
    assert.equal(
      (await checkAgentRuntime(base, { sources }))?.thinkingLevel,
      "medium",
    );
    assert.equal(
      (await checkAgentRuntime({ ...base, model: "sol" }, { sources }))
        ?.thinkingLevel,
      "medium",
    );
    const highOnly = {
      ...sources,
      models: async () => [model("claude-sdk", "opus", ["off", "high"])],
    };
    assert.equal(
      (await checkAgentRuntime(base, { sources: highOnly }))?.thinkingLevel,
      "high",
    );
  });

  test("a concrete version is reported as the pin; the alias is not", async () => {
    const pinnedSources = {
      ...sources,
      models: async () => [
        { ...model("claude-sdk", "opus"), pinnedId: "claude-opus-5-5" },
      ],
    };
    const pinned = await checkAgentRuntime(
      { ...base, model: "claude-opus-5-5" },
      { sources: pinnedSources },
    );
    assert.equal(pinned?.model.id, "opus");
    assert.equal(pinned?.pinnedModel, "claude-opus-5-5");
    assert.ok(!("pinnedId" in pinned!.model));
    const alias = await checkAgentRuntime(base, { sources: pinnedSources });
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
          model: "gemini",
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
        { ...base, model: "retired-model" },
        { sources, checkModel: false },
      ),
      undefined,
    );
  });
});
