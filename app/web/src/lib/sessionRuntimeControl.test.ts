/**
 * Which models and accounts the Runtime pickers offer a started session, and
 * when a pending change switches engines (`docs/session-runtime-switching.md`).
 *   pnpm --filter @assistant/web test src/lib/sessionRuntimeControl.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@assistant/shared";
import { failed, loading, ready, refreshing } from "./loadState.ts";
import {
  accountTargetsRefreshKey,
  crossesEngines,
  handoffEstimateRefreshKey,
  runtimeAccountChoices,
  runtimeCommandContext,
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
  estimateSessionHandoff: vi.fn(),
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
  handoff: undefined,
  busy: false,
  actions: actions(),
  ...over,
});

describe("crossesEngines", () => {
  it("is another harness, or another kind of account than the bound one", () => {
    expect(crossesEngines(claude, "claude-sdk", personal)).toBe(false);
    expect(crossesEngines(codex, "claude-sdk", personal)).toBe(true);
    expect(crossesEngines(endpoint, "pi", chatgpt)).toBe(true);
    expect(crossesEngines(codex, "pi", team)).toBe(true);
    expect(crossesEngines(endpoint, "pi", team)).toBe(false);
    expect(crossesEngines(codex, "pi", undefined)).toBe(false);
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
    expect(control.engineSwitch).toBeUndefined();
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
  it("names the bound account only when the server judged it can run the next turn, then the accounts it may move to", () => {
    // An enabled personal account of the same kind that the server left out
    // (enterprise requirement, or its listing lacks the pending model) is
    // never offered: only the server's list counts.
    const targets = ready([
      { id: "cp-b", name: "Work", enterprise: true },
      { id: "cp-a", name: "Personal", enterprise: false },
    ]);
    expect(
      runtimeAccountChoices(personal, undefined, {
        targets,
        boundEligible: true,
      }),
    ).toEqual([
      { id: "cp-a", name: "Personal" },
      { id: "cp-b", name: "Work" },
    ]);
    // The server found nothing to move to: only the bound account, so
    // `/account` (offered for more than one) stays hidden.
    expect(
      runtimeAccountChoices(personal, undefined, {
        targets: ready([]),
        boundEligible: true,
      }),
    ).toEqual([{ id: "cp-a", name: "Personal" }]);
  });

  it("never counts a bound account the server judged unable to run the next turn", () => {
    // Bound and disabled (or lacking the pending model, or failing the
    // enterprise requirement), with one eligible account: one choice, so
    // `/account` is not offered for a choice that is no choice.
    const targets = ready([{ id: "cp-b", name: "Work", enterprise: true }]);
    expect(
      runtimeAccountChoices(personal, undefined, {
        targets,
        boundEligible: false,
      }),
    ).toEqual([{ id: "cp-b", name: "Work" }]);
    // An answer without the verdict counts it out too.
    expect(runtimeAccountChoices(personal, undefined, { targets })).toEqual([
      { id: "cp-b", name: "Work" },
    ]);
  });

  it("offers nothing until the server answered, keeps its last answer while refreshing, and nothing for an account that cannot move", () => {
    const list = [{ id: "cp-b", name: "Work", enterprise: false }];
    const answer = (targets: Parameters<typeof runtimeAccountChoices>[2]) =>
      runtimeAccountChoices(personal, undefined, targets);
    expect(answer(undefined)).toEqual([]);
    expect(answer({ targets: loading() })).toEqual([]);
    expect(answer({ targets: failed("lost") })).toEqual([]);
    expect(
      answer({ targets: refreshing(list), boundEligible: true }),
    ).toHaveLength(2);
    expect(
      runtimeAccountChoices(team, undefined, {
        targets: ready(list),
        boundEligible: true,
      }),
    ).toEqual([]);
    expect(
      runtimeAccountChoices(undefined, undefined, {
        targets: ready(list),
        boundEligible: true,
      }),
    ).toEqual([]);
  });
});

describe("accountTargetsRefreshKey", () => {
  const base = {
    sessionId: "s1",
    boundAccountId: "cp-a",
    model: { provider: "openai-codex", id: "gpt-5.5" },
    thinkingLevel: "off",
    requiresEnterprise: false,
    profiles: [
      {
        id: "cp-a",
        provider: "openai-codex" as const,
        enabled: true,
        enterprise: false,
        health: { state: "limited" as const, since: 1, benchRevision: 3 },
      },
    ],
    modelListings: {
      "cp-a": [
        { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
      ] as ModelOption[],
    },
  };
  const key = accountTargetsRefreshKey(base);

  it("changes when only an account's model listing changes (F010)", () => {
    // A listing refresh can drop the next turn's model from an account (or
    // add it) while the profile, its health and the selected model all stay.
    expect(
      accountTargetsRefreshKey({ ...base, modelListings: { "cp-a": [] } }),
    ).not.toBe(key);
    expect(
      accountTargetsRefreshKey({
        ...base,
        modelListings: {
          "cp-a": [
            ...base.modelListings["cp-a"]!,
            { provider: "openai-codex", id: "gpt-6", name: "GPT-6" },
          ] as ModelOption[],
        },
      }),
    ).not.toBe(key);
    expect(
      accountTargetsRefreshKey({
        ...base,
        modelListings: { "cp-a": [...base.modelListings["cp-a"]!] },
      }),
      "same content, new arrays: no refetch",
    ).toBe(key);
  });

  it("changes with a new bench scope even when the health state stays the same", () => {
    expect(
      accountTargetsRefreshKey({
        ...base,
        profiles: [
          {
            ...base.profiles[0]!,
            health: { state: "limited", since: 1, benchRevision: 4 },
          },
        ],
      }),
    ).not.toBe(key);
  });

  it("changes with everything else the server's judgement reads, and only then", () => {
    expect(accountTargetsRefreshKey({ ...base })).toBe(key);
    for (const change of [
      { sessionId: "s2" },
      { boundAccountId: "cp-b" },
      { model: { provider: "openai-codex", id: "gpt-other" } },
      { thinkingLevel: "high" },
      { requiresEnterprise: true },
      { profiles: [{ ...base.profiles[0]!, enabled: false }] },
      { profiles: [{ ...base.profiles[0]!, enterprise: true }] },
      {
        profiles: [
          { ...base.profiles[0]!, health: { state: "ok" as const, since: 2 } },
        ],
      },
    ])
      expect(accountTargetsRefreshKey({ ...base, ...change })).not.toBe(key);
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

describe("a pending change that switches engines", () => {
  const toCodex = {
    model: { provider: "openai-codex", id: "gpt-5.5" },
    thinkingLevel: "high" as const,
    account: { kind: "automatic" as const },
    setBy: "user" as const,
  };

  it("offers every model, and the target kind's accounts with the estimate", () => {
    const acts = actions();
    const estimate = ready(12_000);
    const control = sessionRuntimeControl(
      input({
        pending: toCodex,
        accounts: [personal, work, chatgpt],
        handoff: estimate,
        actions: acts,
      }),
    )!;
    expect(control.models.map((option) => option.id)).toEqual([
      "opus",
      "gpt-5.5",
    ]);
    expect(control.engineSwitch).toMatchObject({
      kindLabel: "OpenAI",
      handoff: estimate,
    });
    expect(control.engineSwitch?.fixedAccountName).toBeUndefined();
    control.engineSwitch!.onEstimate();
    expect(acts.estimateSessionHandoff).toHaveBeenCalledWith("s1");
    expect(control.accounts?.nameOf("cp-c")).toBe("ChatGPT");
  });

  it("names the one account an endpoint model runs on, with no picker", () => {
    const control = sessionRuntimeControl(
      input({
        harness: "pi",
        account: chatgpt,
        accounts: [chatgpt, team],
        model: { provider: "openai-codex", id: "gpt-5.5" },
        models: [codex, endpoint],
        pending: { ...toCodex, model: { provider: team.id, id: "local" } },
      }),
    )!;
    expect(control.accounts).toBeUndefined();
    expect(control.engineSwitch).toMatchObject({
      kindLabel: "OpenAI-compatible",
      fixedAccountName: "Team LLM",
    });
  });

  it("gives an endpoint-bound session an account picker for a subscription target", () => {
    const control = sessionRuntimeControl(
      input({
        harness: "pi",
        account: team,
        accounts: [team, personal],
        model: { provider: team.id, id: "local" },
        pending: { ...toCodex, model: { provider: "claude-sdk", id: "opus" } },
      }),
    )!;
    expect(control.accounts).toBeDefined();
    expect(control.engineSwitch?.kindLabel).toBe("Claude");
  });

  it("lets /account name only the target kind's accounts the server listed, never the bound one", () => {
    const targets = ready([{ id: "cp-c", name: "ChatGPT", enterprise: false }]);
    expect(
      runtimeAccountChoices(personal, codex, { targets, boundEligible: false }),
    ).toEqual([{ id: "cp-c", name: "ChatGPT" }]);
    // A stale verdict on the bound account never names it for another kind.
    expect(
      runtimeAccountChoices(personal, codex, { targets, boundEligible: true }),
    ).toEqual([{ id: "cp-c", name: "ChatGPT" }]);
    expect(
      runtimeAccountChoices(chatgpt, endpoint, {
        targets,
        boundEligible: false,
      }),
    ).toEqual([]);
  });
});

describe("handoffEstimateRefreshKey", () => {
  const base = {
    sessionId: "s1",
    pending: undefined,
    messageCount: 4,
    streaming: false,
    profiles: [
      {
        id: "cp-a",
        enabled: true,
        enterprise: false,
        health: { state: "ok" as const, since: 1 },
      },
    ],
  };
  const key = handoffEstimateRefreshKey(base);

  it("changes with the session, its target, its log between turns and the accounts, and only then", () => {
    expect(handoffEstimateRefreshKey({ ...base })).toBe(key);
    for (const change of [
      { sessionId: "s2" },
      {
        pending: {
          model: { provider: "openai-codex", id: "gpt-5.5" },
          thinkingLevel: "high" as const,
          account: { kind: "automatic" as const },
          setBy: "user" as const,
        },
      },
      { messageCount: 5 },
      { streaming: true },
      { profiles: [{ ...base.profiles[0]!, enabled: false }] },
    ])
      expect(handoffEstimateRefreshKey({ ...base, ...change })).not.toBe(key);
  });

  it("stays the same while a running turn adds entries, so the estimate is not asked again on each (F037)", () => {
    const running = handoffEstimateRefreshKey({ ...base, streaming: true });
    for (const messageCount of [5, 6, 40])
      expect(
        handoffEstimateRefreshKey({ ...base, streaming: true, messageCount }),
      ).toBe(running);
    // The turn ended: asked once more, for the log it left.
    expect(
      handoffEstimateRefreshKey({
        ...base,
        streaming: false,
        messageCount: 40,
      }),
    ).not.toBe(running);
  });
});
