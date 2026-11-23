/**
 * Which models and accounts the Runtime pickers offer a started session, and
 * why one is disabled (`docs/session-runtime-switching.md`).
 *   pnpm --filter @assistant/web test src/lib/sessionRuntimeControl.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@assistant/shared";
import {
  OTHER_ACCOUNT_KIND_REASON,
  OTHER_HARNESS_REASON,
  runtimeAccountChoices,
  runtimeCommandContext,
  runtimeModelRefusal,
  sessionRuntimeControl,
} from "./sessionRuntimeControl.ts";

const model = (provider: string, id: string): ModelOption => ({
  provider,
  id,
  name: id,
  reasoning: true,
  contextWindow: 1,
});
const claude = model("claude-sdk", "opus");
const codex = model("openai-codex", "gpt-5.5");
const endpoint = model("openai-compatible-0123456789ab", "local");

const personal = { id: "cp-a", name: "Personal", provider: "claude" as const };
const work = { id: "cp-b", name: "Work", provider: "claude" as const };
const chatgpt = {
  id: "cp-c",
  name: "ChatGPT",
  provider: "openai-codex" as const,
};
const team = {
  id: "openai-compatible-0123456789ab",
  name: "Team LLM",
  provider: "openai-compatible" as const,
};

const actions = () => ({
  listSessionAccountMoveTargets: vi.fn(),
  setPendingRuntime: vi.fn(),
  clearPendingRuntime: vi.fn(),
});

const input = (
  over: Partial<Parameters<typeof sessionRuntimeControl>[0]> = {},
): Parameters<typeof sessionRuntimeControl>[0] => ({
  sessionId: "s1",
  started: true,
  harness: "claude-sdk",
  model: { provider: "claude-sdk", id: "opus" },
  thinkingLevel: "high",
  pending: undefined,
  account: personal,
  accounts: [personal, work],
  models: [codex, claude],
  targets: undefined,
  busy: false,
  actions: actions(),
  ...over,
});

describe("runtimeModelRefusal", () => {
  it("refuses another harness first, then another account kind", () => {
    expect(runtimeModelRefusal(claude, "claude-sdk", personal)).toBeUndefined();
    expect(runtimeModelRefusal(codex, "claude-sdk", personal)).toBe(
      OTHER_HARNESS_REASON,
    );
    expect(runtimeModelRefusal(endpoint, "pi", chatgpt)).toBe(
      OTHER_ACCOUNT_KIND_REASON,
    );
    expect(runtimeModelRefusal(endpoint, "pi", team)).toBeUndefined();
    expect(runtimeModelRefusal(codex, "pi", undefined)).toBeUndefined();
  });
});

describe("sessionRuntimeControl", () => {
  it("exists only for a started session", () => {
    expect(sessionRuntimeControl(input({ started: false }))).toBeUndefined();
    expect(
      sessionRuntimeControl(input({ sessionId: undefined })),
    ).toBeUndefined();
  });

  it("lists this engine's models first and sends changes for this session", () => {
    const acts = actions();
    const control = sessionRuntimeControl(input({ actions: acts }))!;
    expect(control.models.map((option) => option.id)).toEqual([
      "opus",
      "gpt-5.5",
    ]);
    expect(control.modelRefusal(codex)).toBe(OTHER_HARNESS_REASON);
    control.onChange({ thinkingLevel: "low" });
    control.onReset();
    control.accounts!.onOpen();
    expect(acts.setPendingRuntime).toHaveBeenCalledWith("s1", {
      thinkingLevel: "low",
    });
    expect(acts.clearPendingRuntime).toHaveBeenCalledWith("s1");
    expect(acts.listSessionAccountMoveTargets).toHaveBeenCalledWith("s1");
    expect(control.accounts!.nameOf("cp-b")).toBe("Work");
  });

  it("offers no account picker for an account that cannot move", () => {
    const control = sessionRuntimeControl(
      input({
        harness: "pi",
        account: team,
        accounts: [team],
        model: { provider: team.id, id: "local" },
      }),
    )!;
    expect(control.accounts).toBeUndefined();
    expect(control.current.accountName).toBe("Team LLM");
  });
});

describe("runtimeAccountChoices", () => {
  it("names the enabled accounts of the bound kind that serve the model", () => {
    const accounts = [
      { ...personal, enabled: true },
      { ...work, enabled: true },
      { id: "cp-d", name: "Off", provider: "claude" as const, enabled: false },
      { ...chatgpt, enabled: true },
    ];
    expect(runtimeAccountChoices(personal, accounts, "claude-sdk")).toEqual([
      { id: "cp-a", name: "Personal" },
      { id: "cp-b", name: "Work" },
    ]);
    expect(runtimeAccountChoices(team, accounts, team.id)).toEqual([]);
    expect(runtimeAccountChoices(undefined, accounts, "claude-sdk")).toEqual(
      [],
    );
  });
});

describe("runtimeCommandContext", () => {
  it("resolves effort against the pending model, else the current one", () => {
    const other = model("claude-sdk", "sonnet");
    const control = sessionRuntimeControl(input({ models: [claude, other] }))!;
    expect(
      runtimeCommandContext({ control, accountChoices: [] }).targetModel,
    ).toBe(claude);
    const pending = sessionRuntimeControl(
      input({
        models: [claude, other],
        pending: {
          model: { provider: "claude-sdk", id: "sonnet" },
          thinkingLevel: "high",
          account: { kind: "automatic" },
          setBy: "user",
        },
      }),
    )!;
    expect(
      runtimeCommandContext({ control: pending, accountChoices: [] })
        .targetModel,
    ).toBe(other);
  });
});
