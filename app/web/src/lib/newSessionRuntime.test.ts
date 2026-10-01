import { describe, expect, it } from "vitest";
import type { ModelOption, SessionState } from "@assistant/shared";
import {
  carryOverRuntimeSelection,
  composerDraftStorageKey,
  firstPromptRuntimeSelection,
  newSessionRuntimeDefaults,
  reviewHandoffSessionTarget,
  routeComposerSend,
  visibleSessionDraft,
} from "./newSessionRuntime.ts";

const sonnet: ModelOption = {
  provider: "claude-sdk",
  id: "sonnet",
  name: "Sonnet",
  reasoning: true,
  supportedThinkingLevels: ["off", "low", "medium", "high"],
  contextWindow: 200_000,
};

const terra: ModelOption = {
  provider: "openai-codex",
  id: "gpt-5.6-terra",
  name: "GPT-5.6 Terra",
  reasoning: true,
  supportedThinkingLevels: ["low", "medium", "high"],
  contextWindow: 200_000,
};

describe("new session runtime selection", () => {
  it("stages the visible default model and thinking level for a worktree session", () => {
    expect(newSessionRuntimeDefaults(terra, "medium")).toEqual({
      harness: "pi",
      provider: "openai-codex",
      modelId: "gpt-5.6-terra",
      thinkingLevel: "medium",
    });
  });

  it("sends the model shown by the optimistic session instead of an incomplete staging record", () => {
    const session = {
      model: terra,
      thinkingLevel: "medium",
    } as Pick<SessionState, "model" | "thinkingLevel">;

    expect(firstPromptRuntimeSelection(session)).toEqual({
      harness: "pi",
      provider: "openai-codex",
      modelId: "gpt-5.6-terra",
      thinkingLevel: "medium",
    });
  });

  // A staged record built before the model was known carries the "pi" fallback
  // harness; sending it with the Claude model the pickers actually show fails
  // server-side ("Select an OpenAI credential profile for this pi session").
  it("derives the harness from the shown model, not from the staging record", () => {
    const session = {
      model: sonnet,
      thinkingLevel: "high",
    } as Pick<SessionState, "model" | "thinkingLevel">;

    expect(firstPromptRuntimeSelection(session)).toEqual({
      harness: "claude-sdk",
      provider: "claude-sdk",
      modelId: "sonnet",
      thinkingLevel: "high",
    });
  });

  it("falls back to pi with no model when nothing is staged", () => {
    expect(firstPromptRuntimeSelection(null)).toEqual({
      harness: "pi",
      provider: undefined,
      modelId: undefined,
      thinkingLevel: "off",
    });
  });

  // Build/Plan travels with the same optimistic record as model/thinking, so a
  // session staged in Plan is created in Plan (Task 332).
  it("carries the staged mode into the first-send runtime", () => {
    const session = {
      model: terra,
      thinkingLevel: "medium",
      mode: "plan",
    } as Pick<SessionState, "model" | "thinkingLevel" | "mode">;

    expect(firstPromptRuntimeSelection(session).mode).toBe("plan");
    expect(firstPromptRuntimeSelection(null).mode).toBeUndefined();
  });

  // Model and thinking level are remembered picks; Plan is not. A fresh staging
  // entry point (a Task, a worktree, the /review handoff) states Build, so a mode
  // picked for an earlier session cannot follow the user into the next one.
  it("starts a fresh staged runtime in Build", () => {
    expect(newSessionRuntimeDefaults(terra, "medium").mode).toBeUndefined();
    expect(newSessionRuntimeDefaults(sonnet, "high").mode).toBeUndefined();
  });
});

// A review handoff creates its session server-side, so this target — not a
// first prompt — carries the staged runtime. Mode included: the draft is staged
// on the ordinary new-session surface, where Build/Plan is picked next to the
// model, and a session created in Build after the composer showed Plan runs
// tools the user meant to withhold.
describe("review handoff session target", () => {
  const base = {
    agentType: "developer" as const,
    credentialProfileId: "profile-work",
    additionalPrompt: "Look at the mobile behavior.",
    attachments: [],
  };

  it("carries the whole staged runtime, mode included", () => {
    expect(
      reviewHandoffSessionTarget({
        ...base,
        runtime: firstPromptRuntimeSelection({
          model: terra,
          thinkingLevel: "medium",
          mode: "plan",
        } as Pick<SessionState, "model" | "thinkingLevel" | "mode">),
      }),
    ).toEqual({
      kind: "new",
      harness: "pi",
      agentType: "developer",
      modelProvider: "openai-codex",
      modelId: "gpt-5.6-terra",
      thinkingLevel: "medium",
      mode: "plan",
      credentialProfileId: "profile-work",
      additionalPrompt: "Look at the mobile behavior.",
    });
  });

  it("omits mode for a Build draft and attachments when there are none", () => {
    const target = reviewHandoffSessionTarget({
      ...base,
      runtime: newSessionRuntimeDefaults(sonnet, "high"),
    });

    expect(target.mode).toBeUndefined();
    expect("attachments" in target).toBe(false);
    expect(target.harness).toBe("claude-sdk");
  });

  it("passes staged attachments along", () => {
    const attachment = {
      id: "a1",
      name: "notes.txt",
      mimeType: "text/plain",
      data: "bm90ZXM=",
      size: 5,
    };

    expect(
      reviewHandoffSessionTarget({
        ...base,
        attachments: [attachment],
        runtime: newSessionRuntimeDefaults(terra, "medium"),
      }).attachments,
    ).toEqual([attachment]);
  });
});

describe("composer draft slot", () => {
  // Restaging re-mints the staged client id; the typed prompt must not move
  // with it (switching provider account on the new-session page used to clear
  // the composer).
  it("keeps one slot for a staged session however often it is restaged", () => {
    expect(composerDraftStorageKey("pending-pi-session", true)).toBe(
      composerDraftStorageKey("c-9f2a", true),
    );
    expect(composerDraftStorageKey(undefined, true)).toBe(
      "assistant.composerDraft.session:new-v2",
    );
  });

  it("gives an established session its own slot", () => {
    expect(composerDraftStorageKey("s-1", false)).toBe(
      "assistant.composerDraft.session:s-1",
    );
  });

  it("only exposes a staged session draft on its destination session", () => {
    const draft = { sessionId: "fork-child", text: "Retry this", token: 1 };
    expect(visibleSessionDraft(draft, "fork-child")).toBe(draft);
    expect(visibleSessionDraft(draft, "pending-pi-session")).toBeNull();
    expect(visibleSessionDraft(draft, undefined)).toBeNull();
  });
});

describe("carrying the selection across a provider-account switch", () => {
  const opus: ModelOption = {
    provider: "claude-sdk",
    id: "opus",
    name: "Opus",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    contextWindow: 200_000,
  };
  const haiku: ModelOption = { ...opus, id: "haiku", name: "Haiku" };
  const mini: ModelOption = {
    ...terra,
    id: "gpt-5.6-mini",
    name: "GPT-5.6 Mini",
    supportedThinkingLevels: ["off", "minimal", "low", "medium", "high", "max"],
  };
  const claudeModels = [opus, sonnet, haiku];
  const openAiModels = [terra, mini];

  it("keeps the same model and level when another account offers it", () => {
    expect(
      carryOverRuntimeSelection({
        model: sonnet,
        thinkingLevel: "high",
        fromModels: claudeModels,
        toModels: [...claudeModels],
      }),
    ).toEqual({ model: sonnet, thinkingLevel: "high" });
  });

  it("maps across providers by position in the user's model order", () => {
    // sonnet is 2nd of the Claude list → 2nd of the OpenAI list.
    expect(
      carryOverRuntimeSelection({
        model: sonnet,
        thinkingLevel: "medium",
        fromModels: claudeModels,
        toModels: openAiModels,
      }).model,
    ).toBe(mini);
    // The reverse trip lands back on the model it came from.
    expect(
      carryOverRuntimeSelection({
        model: mini,
        thinkingLevel: "medium",
        fromModels: openAiModels,
        toModels: claudeModels,
      }).model,
    ).toBe(sonnet);
  });

  it("clamps a position past the end of the shorter list", () => {
    expect(
      carryOverRuntimeSelection({
        model: haiku,
        thinkingLevel: "medium",
        fromModels: claudeModels,
        toModels: openAiModels,
      }).model,
    ).toBe(mini);
  });

  it("maps a level the destination model cannot accept onto its nearest one", () => {
    // "minimal" exists on pi models only; Claude's nearest offer is "low".
    expect(
      carryOverRuntimeSelection({
        model: mini,
        thinkingLevel: "minimal",
        fromModels: openAiModels,
        toModels: claudeModels,
      }),
    ).toEqual({ model: sonnet, thinkingLevel: "low" });
    // terra has no "off" at all — a non-thinking pick becomes its lowest level.
    expect(
      carryOverRuntimeSelection({
        model: opus,
        thinkingLevel: "off",
        fromModels: claudeModels,
        toModels: [terra],
      }),
    ).toEqual({ model: terra, thinkingLevel: "low" });
  });

  it("falls back to the first model when the current one is not in either list", () => {
    expect(
      carryOverRuntimeSelection({
        model: { ...opus, id: "retired" },
        thinkingLevel: "high",
        fromModels: [],
        toModels: openAiModels,
      }).model,
    ).toBe(terra);
  });

  it("reports no model for an account that offers none", () => {
    expect(
      carryOverRuntimeSelection({
        model: sonnet,
        thinkingLevel: "high",
        fromModels: claudeModels,
        toModels: [],
      }),
    ).toEqual({ model: undefined, thinkingLevel: "off" });
  });
});

describe("routeComposerSend", () => {
  const on = {
    isNewChatRoute: true,
    hasUserPrompt: false,
    firstSendRetryPending: false,
  };

  it("creates the session on the first send and prompts once one exists", () => {
    expect(routeComposerSend(on)).toBe("first-send");
    expect(routeComposerSend({ ...on, hasUserPrompt: true })).toBe("prompt");
    expect(routeComposerSend({ ...on, isNewChatRoute: false })).toBe("prompt");
  });

  it("re-issues the held first send while a failed one has created no session", () => {
    // The prompt IS visible (this browser's optimistic echo) but nothing was
    // created, so falling through to `prompt` would drive a turn into whichever
    // session the connection still views.
    expect(
      routeComposerSend({
        ...on,
        hasUserPrompt: true,
        firstSendRetryPending: true,
      }),
    ).toBe("reissue-first-send");
  });
});
