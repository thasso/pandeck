import { describe, expect, it } from "vitest";
import type { EntryLibraryList } from "@assistant/shared";
import {
  agentAcrossPersonaSwitch,
  agentDraft,
  leftNewSessionPage,
  reconcileStagedAgent,
  reissuedFirstSend,
  stagedSessionRecord,
  withoutAgent,
} from "./stagedSession.ts";

/**
 * What a new-session draft keeps across restages (`docs/agent-definitions.md`
 * "UI"): a picked agent definition rides on the record, so only a restage
 * that keeps the agent's runtime carries it, and leaving the page drops it.
 */
describe("staged session record", () => {
  const agentDraft = stagedSessionRecord({
    id: "draft",
    harness: "claude-sdk",
    agentType: "developer",
    provider: "claude-sdk",
    modelId: "opus",
    thinkingLevel: "high",
    mode: "plan",
    agent: "test-reviewer",
  });

  it("carries the agent only when a restage passes it on", () => {
    expect(agentDraft.agent).toBe("test-reviewer");
    // A model, effort or account pick restages without it, from any picker.
    const repicked = stagedSessionRecord({
      id: agentDraft.id,
      harness: "claude-sdk",
      agentType: "developer",
      provider: "claude-sdk",
      modelId: "sonnet",
      thinkingLevel: "high",
      mode: agentDraft.mode,
    });
    expect(repicked.agent).toBeUndefined();
    expect(repicked.mode).toBe("plan");
  });

  it("keeps the agent across a same-persona restage, never across a persona switch", () => {
    expect(agentAcrossPersonaSwitch(agentDraft, "developer")).toBe(
      "test-reviewer",
    );
    expect(agentAcrossPersonaSwitch(agentDraft, "assistant")).toBeUndefined();
    expect(agentAcrossPersonaSwitch(null, "developer")).toBeUndefined();
  });

  it("drops Plan and the agent once the user leaves the page, keeping the runtime", () => {
    const left = leftNewSessionPage(agentDraft);
    expect(left).toEqual({
      id: "draft",
      harness: "claude-sdk",
      agentType: "developer",
      provider: "claude-sdk",
      modelId: "opus",
      thinkingLevel: "high",
    });
    expect(leftNewSessionPage(left)).toBe(left);
    expect(leftNewSessionPage(null)).toBeNull();
  });
});

describe("re-issuing a failed first send", () => {
  const held = {
    id: "draft",
    harness: "claude-sdk" as const,
    agentType: "developer" as const,
    text: "first try",
    modelProvider: "claude-sdk",
    modelId: "opus",
    thinkingLevel: "high" as const,
    agent: "test-reviewer",
    credentialProfileId: "claude-work",
    attachTaskId: "780",
    worktreeId: "wt-1",
    clientRequestId: "req-1",
  };

  it("keeps the consumed context and request, and sends what the pickers show now", () => {
    expect(
      reissuedFirstSend(
        held,
        {
          harness: "claude-sdk",
          agentType: "developer",
          credentialProfileId: "claude-work",
          provider: "claude-sdk",
          modelId: "sonnet",
          thinkingLevel: "low",
        },
        { text: "second try" },
      ),
    ).toEqual({
      id: "draft",
      harness: "claude-sdk",
      agentType: "developer",
      text: "second try",
      modelProvider: "claude-sdk",
      modelId: "sonnet",
      thinkingLevel: "low",
      credentialProfileId: "claude-work",
      attachTaskId: "780",
      worktreeId: "wt-1",
      clientRequestId: "req-1",
    });
  });

  it("follows the draft's engine, persona and account, not the held ones", () => {
    // After a refused Claude agent send the user moves to an OpenAI account
    // and the assistant persona: the retry is what they see now.
    expect(
      reissuedFirstSend(
        held,
        {
          harness: "pi",
          agentType: "assistant",
          credentialProfileId: "openai-work",
          provider: "openai-codex",
          modelId: "gpt-6-luna",
          thinkingLevel: "medium",
        },
        { text: "third try" },
      ),
    ).toEqual({
      id: "draft",
      harness: "pi",
      agentType: "assistant",
      credentialProfileId: "openai-work",
      text: "third try",
      modelProvider: "openai-codex",
      modelId: "gpt-6-luna",
      thinkingLevel: "medium",
      attachTaskId: "780",
      worktreeId: "wt-1",
      clientRequestId: "req-1",
    });
  });

  it("carries the agent only while the draft still has it", () => {
    expect(
      reissuedFirstSend(
        held,
        {
          harness: "claude-sdk",
          agentType: "developer",
          provider: "claude-sdk",
          modelId: "opus",
          thinkingLevel: "high",
          agent: "test-reviewer",
        },
        { text: "again" },
      ).agent,
    ).toBe("test-reviewer");
  });

  it("lands on the draft's own id when a restage gave it a new one", () => {
    const draft = {
      harness: "claude-sdk" as const,
      agentType: "developer" as const,
      provider: "claude-sdk",
      modelId: "opus",
    };
    expect(
      reissuedFirstSend(held, { ...draft, id: "restaged" }, { text: "again" })
        .id,
    ).toBe("restaged");
    expect(reissuedFirstSend(held, draft, { text: "again" }).id).toBe("draft");
  });
});

describe("staging an agent definition", () => {
  const list: EntryLibraryList = {
    libraryPath: "/data/agents",
    entries: [],
    diagnostics: [],
    agentRuntimes: {
      "test-reviewer": {
        persona: "developer",
        provider: "claude-sdk",
        modelId: "opus",
        thinkingLevel: "high",
      },
      stale: { problem: "No model." },
    },
  };
  const accounts = [
    { id: "openai-1", provider: "openai-codex" },
    { id: "claude-1", provider: "claude" },
    { id: "claude-2", provider: "claude" },
  ];

  it("stages the definition's runtime on an account of its provider", () => {
    expect(agentDraft(list, "test-reviewer", accounts, "claude-2")).toEqual({
      harness: "claude-sdk",
      agentType: "developer",
      provider: "claude-sdk",
      modelId: "opus",
      thinkingLevel: "high",
      agent: "test-reviewer",
      accountId: "claude-2",
    });
    // A picked account of another provider gives way to the first Claude one.
    expect(
      agentDraft(list, "test-reviewer", accounts, "openai-1")?.accountId,
    ).toBe("claude-1");
    expect(agentDraft(list, "stale", accounts, "claude-1")).toBeUndefined();
    // No account of its provider (or none read yet): nothing is staged.
    expect(agentDraft(list, "test-reviewer", [], undefined)).toBeUndefined();
    expect(
      agentDraft(list, "test-reviewer", [accounts[0]!], "openai-1"),
    ).toBeUndefined();
    expect(agentDraft(list, "nobody", accounts, "claude-1")).toBeUndefined();
  });

  it("follows the library: keep, restage on a changed runtime, drop when gone", () => {
    const record = stagedSessionRecord({
      id: "draft",
      ...agentDraft(list, "test-reviewer", accounts, "claude-1")!,
      mode: undefined,
    });
    expect(reconcileStagedAgent(record, list)).toBe("keep");
    expect(reconcileStagedAgent(record, undefined)).toBe("keep");
    expect(
      reconcileStagedAgent(record, {
        ...list,
        agentRuntimes: {
          "test-reviewer": {
            persona: "developer",
            provider: "claude-sdk",
            modelId: "opus",
            thinkingLevel: "medium",
          },
        },
      }),
    ).toBe("restage");
    expect(
      reconcileStagedAgent(record, {
        ...list,
        agentRuntimes: { "test-reviewer": { problem: "Gone." } },
      }),
    ).toBe("drop");
    expect(reconcileStagedAgent(record, { ...list, agentRuntimes: {} })).toBe(
      "drop",
    );
    expect(withoutAgent(record).agent).toBeUndefined();
    expect(withoutAgent(record).modelId).toBe("opus");
  });
});
