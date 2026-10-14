import { describe, expect, it } from "vitest";
import {
  agentAcrossPersonaSwitch,
  leftNewSessionPage,
  stagedSessionRecord,
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
