/**
 * `/model`, `/effort` and `/account`: what a typed line resolves to, and the
 * arguments the composer completes (`docs/session-runtime-switching.md`).
 *   pnpm --filter @assistant/web test src/lib/runtimeSlashCommand.test.ts
 */
import { describe, expect, it } from "vitest";
import type { ModelOption } from "@assistant/shared";
import {
  isRuntimeCommand,
  resolveRuntimeCommand,
  runtimeArgumentOptions,
  type RuntimeCommandContext,
} from "./runtimeSlashCommand.ts";

const opus: ModelOption = {
  provider: "claude-sdk",
  id: "claude-opus",
  name: "Claude Opus",
  reasoning: true,
  supportedThinkingLevels: ["low", "medium", "high"],
  contextWindow: 200_000,
};
const gpt: ModelOption = {
  ...opus,
  provider: "openai-codex",
  id: "gpt-5.5",
  name: "GPT-5.5",
  supportedThinkingLevels: ["off", "low", "high", "xhigh"],
};

const context = (
  over: Partial<RuntimeCommandContext> = {},
): RuntimeCommandContext => ({
  models: [opus, gpt],
  targetModel: opus,
  accounts: [
    { id: "cp-a", name: "Personal" },
    { id: "cp-b", name: "Work" },
  ],
  ...over,
});

describe("runtime slash commands", () => {
  it("names only the three runtime commands", () => {
    expect(
      ["model", "effort", "account", "rename"].map(isRuntimeCommand),
    ).toEqual([true, true, true, false]);
  });

  it("opens the Runtime section without an argument", () => {
    for (const name of ["model", "effort", "account"] as const)
      expect(resolveRuntimeCommand(name, "  ", context())).toEqual({
        kind: "open",
      });
  });

  it("resolves a model by id or name, another harness's too (a switch)", () => {
    const change = {
      kind: "change",
      change: { model: { provider: "claude-sdk", id: "claude-opus" } },
    };
    expect(resolveRuntimeCommand("model", "claude-opus", context())).toEqual(
      change,
    );
    expect(resolveRuntimeCommand("model", "claude OPUS", context())).toEqual(
      change,
    );
    expect(resolveRuntimeCommand("model", "gpt-5.5", context())).toEqual({
      kind: "change",
      change: { model: { provider: "openai-codex", id: "gpt-5.5" } },
    });
    expect(resolveRuntimeCommand("model", "nope", context())).toEqual({
      kind: "error",
      message: 'No model is named "nope".',
    });
  });

  it("resolves an effort the target model supports", () => {
    expect(resolveRuntimeCommand("effort", "High", context())).toEqual({
      kind: "change",
      change: { thinkingLevel: "high" },
    });
    expect(resolveRuntimeCommand("effort", "xhigh", context())).toEqual({
      kind: "error",
      message: "Effort must be one of: low, medium, high.",
    });
  });

  it("resolves Automatic or one account by name or id", () => {
    expect(resolveRuntimeCommand("account", "auto", context())).toEqual({
      kind: "change",
      change: { account: { kind: "automatic" } },
    });
    expect(resolveRuntimeCommand("account", "work", context())).toEqual({
      kind: "change",
      change: { account: { kind: "account", id: "cp-b" } },
    });
    expect(resolveRuntimeCommand("account", "cp-a", context())).toEqual({
      kind: "change",
      change: { account: { kind: "account", id: "cp-a" } },
    });
    expect(resolveRuntimeCommand("account", "Other", context())).toEqual({
      kind: "error",
      message: 'No account that can run this model is named "Other".',
    });
    expect(
      resolveRuntimeCommand(
        "account",
        "Work",
        context({
          accounts: [
            { id: "cp-b", name: "Work" },
            { id: "cp-c", name: "Work" },
          ],
        }),
      ),
    ).toEqual({
      kind: "error",
      message: 'More than one account is named "Work".',
    });
  });

  it("offers each argument, every harness's models enabled", () => {
    expect(runtimeArgumentOptions("model", context())).toEqual([
      { value: "claude-opus", label: "Claude Opus" },
      { value: "gpt-5.5", label: "GPT-5.5" },
    ]);
    expect(
      runtimeArgumentOptions("effort", context()).map((option) => option.value),
    ).toEqual(["low", "medium", "high"]);
    expect(
      runtimeArgumentOptions("account", context()).map(
        (option) => option.value,
      ),
    ).toEqual(["automatic", "Personal", "Work"]);
  });

  // F024: two OpenAI-compatible endpoints both offer `llama3`.
  const onEndpoint = (n: number): ModelOption => ({
    ...gpt,
    provider: `openai-compatible-${String(n).repeat(12)}`,
    providerName: `Endpoint ${n}`,
    id: "llama3",
    name: "Llama 3",
    supportedThinkingLevels: ["off"],
  });
  const endpoints = context({
    models: [opus, onEndpoint(1), onEndpoint(2)],
    targetModel: undefined,
    accounts: [],
  });

  it("completes a model two endpoints offer as provider/id, each to its own endpoint (F024)", () => {
    const options = runtimeArgumentOptions("model", endpoints);
    expect(options).toEqual([
      { value: "claude-opus", label: "Claude Opus" },
      {
        value: "openai-compatible-111111111111/llama3",
        label: "Llama 3",
        detail: "Endpoint 1",
      },
      {
        value: "openai-compatible-222222222222/llama3",
        label: "Llama 3",
        detail: "Endpoint 2",
      },
    ]);
    // Every suggestion, inserted as it is, names the model it showed.
    for (const [index, model] of [opus, onEndpoint(1), onEndpoint(2)].entries())
      expect(
        resolveRuntimeCommand("model", options[index]!.value, endpoints),
      ).toEqual({
        kind: "change",
        change: { model: { provider: model.provider, id: model.id } },
      });
  });

  it("refuses a bare id or name two endpoints offer, listing the provider/id choices (F024)", () => {
    const refusal = {
      kind: "error",
      message:
        'More than one model is named "llama3"; name one as provider/id: openai-compatible-111111111111/llama3, openai-compatible-222222222222/llama3.',
    };
    expect(resolveRuntimeCommand("model", "llama3", endpoints)).toEqual(
      refusal,
    );
    expect(resolveRuntimeCommand("model", "Llama 3", endpoints)).toMatchObject({
      kind: "error",
    });
    // A model offered once more under the same provider/id is still one model.
    expect(
      resolveRuntimeCommand(
        "model",
        "gpt-5.5",
        context({ models: [opus, gpt, { ...gpt }] }),
      ),
    ).toEqual({
      kind: "change",
      change: { model: { provider: "openai-codex", id: "gpt-5.5" } },
    });
  });

  // F026: an endpoint's id may hold a slash, and equal another model's
  // provider/id.
  const proxy: ModelOption = {
    ...gpt,
    provider: "openai-compatible-222222222222",
    providerName: "Proxy",
    id: "openai/gpt-5.5",
    name: "Proxy GPT",
  };
  const openai: ModelOption = { ...gpt, provider: "openai", name: "GPT 5.5" };

  it("never lets a slash id be read as another model's provider/id (F026)", () => {
    const lookalikes = context({
      models: [openai, proxy],
      targetModel: undefined,
      accounts: [],
    });
    const options = runtimeArgumentOptions("model", lookalikes);
    expect(options.map((option) => option.value)).toEqual([
      "gpt-5.5",
      "openai-compatible-222222222222/openai/gpt-5.5",
    ]);
    expect(
      resolveRuntimeCommand("model", options[1]!.value, lookalikes),
    ).toEqual({
      kind: "change",
      change: { model: { provider: proxy.provider, id: proxy.id } },
    });
    expect(
      resolveRuntimeCommand("model", "openai/gpt-5.5", lookalikes),
    ).toEqual({
      kind: "error",
      message:
        'More than one model is named "openai/gpt-5.5"; name one as provider/id: openai/gpt-5.5, openai-compatible-222222222222/openai/gpt-5.5.',
    });
  });

  /** A small deterministic generator, so a failure names its catalog. */
  function* catalogs(): Generator<ModelOption[]> {
    const providers = ["openai", "p2", "openai-compatible-1", "openai/x"];
    const ids = ["gpt", "openai/gpt", "p2/gpt", "x", "openai-compatible-1/gpt"];
    const names = ["GPT", "Other", "gpt", "x"];
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let round = 0; round < 400; round += 1) {
      const size = 2 + next(5);
      yield Array.from({ length: size }, () => ({
        ...gpt,
        provider: providers[next(providers.length)]!,
        id: ids[next(ids.length)]!,
        name: names[next(names.length)]!,
      }));
    }
  }

  it("round-trips every completion to exactly its own model, in any catalog (F026)", () => {
    const key = (model: { provider: string; id: string }) =>
      `${model.provider}\u0000${model.id}`.toLowerCase();
    const seen = { qualified: 0, disabled: 0 };
    for (const models of catalogs()) {
      const catalog = context({ models, targetModel: undefined, accounts: [] });
      const options = runtimeArgumentOptions("model", catalog);
      seen.disabled += options.filter((option) => option.disabled).length;
      seen.qualified += options.filter(
        (option) => !option.disabled && option.detail !== undefined,
      ).length;
      const distinct = new Map(models.map((model) => [key(model), model]));
      expect(options).toHaveLength(distinct.size);
      [...distinct.values()].forEach((model, index) => {
        const option = options[index]!;
        const resolved = resolveRuntimeCommand("model", option.value, catalog);
        if (!option.disabled) {
          expect(resolved, JSON.stringify(models)).toEqual({
            kind: "change",
            change: { model: { provider: model.provider, id: model.id } },
          });
          return;
        }
        // Disabled only when neither reading names this model alone.
        for (const text of [model.id, `${model.provider}/${model.id}`]) {
          const answer = resolveRuntimeCommand("model", text, catalog);
          expect(
            answer.kind === "change" &&
              key(answer.change.model!) === key(model),
            JSON.stringify({ models, text }),
          ).toBe(false);
        }
      });
    }
    // The catalogs reach both answers that need care.
    expect(seen.qualified).toBeGreaterThan(0);
    expect(seen.disabled).toBeGreaterThan(0);
  });
});
