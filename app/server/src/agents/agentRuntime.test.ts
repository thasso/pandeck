/**
 * Whether a definition can run (`docs/agent-definitions.md` "Model and
 * effort", "Tools"): model resolution never guesses, effort is lowered to the
 * model, and denied tools and mounted skills must exist.
 *
 * Run with:
 *   pnpm --filter @assistant/server test src/agents/agentRuntime.test.ts
 */
import assert from "node:assert/strict";
import type { ModelOption } from "@assistant/shared";
import { describe, test } from "vitest";
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
    assert.equal(
      (await checkAgentRuntime(base, { sources }))?.thinkingLevel,
      undefined,
    );
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
