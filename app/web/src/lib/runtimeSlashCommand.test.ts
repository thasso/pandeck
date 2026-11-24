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
});
