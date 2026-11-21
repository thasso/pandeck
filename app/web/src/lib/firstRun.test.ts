import { describe, expect, it } from "vitest";
import type { CredentialProfileSummary } from "@assistant/shared";
import {
  firstAccountSteps,
  firstRunAssistantName,
  welcomeGreeting,
} from "./firstRun.ts";

function account(
  patch: Partial<CredentialProfileSummary> &
    Pick<CredentialProfileSummary, "id" | "provider">,
): CredentialProfileSummary {
  return {
    name: patch.id,
    enabled: true,
    enterprise: false,
    status: "ready",
    health: { state: "unknown", since: null },
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}
describe("firstAccountSteps", () => {
  it("offers to create each kind when nothing exists", () => {
    expect(firstAccountSteps([], {})).toEqual([
      { kind: "claude", action: "create" },
      { kind: "openai-codex", action: "create" },
      { kind: "openai-compatible", action: "create" },
    ]);
  });

  it("continues an earlier account instead of creating another", () => {
    const steps = firstAccountSteps(
      [
        account({ id: "c", provider: "claude", status: "connecting" }),
        account({ id: "o", provider: "openai-codex", status: "error" }),
        account({
          id: "e",
          provider: "openai-compatible",
          status: "disconnected",
        }),
      ],
      {},
    );
    expect(
      steps.map((step) => [step.kind, step.action, step.profile?.id]),
    ).toEqual([
      ["claude", "continue-sign-in", "c"],
      ["openai-codex", "sign-in", "o"],
      ["openai-compatible", "finish-endpoint", "e"],
    ]);
  });

  it("turns the Claude SDK on for a signed-in Claude account with no models", () => {
    const [claude] = firstAccountSteps(
      [account({ id: "c", provider: "claude" })],
      { c: [] },
    );
    expect(claude?.action).toBe("enable-claude");
  });

  it("enables a disabled account, preferring an enabled one of the same kind", () => {
    const disabled = account({ id: "d", provider: "claude", enabled: false });
    expect(firstAccountSteps([disabled], {})[0]).toMatchObject({
      action: "enable",
      profile: { id: "d" },
    });
    const pending = account({
      id: "p",
      provider: "claude",
      status: "disconnected",
    });
    expect(firstAccountSteps([disabled, pending], {})[0]).toMatchObject({
      action: "sign-in",
      profile: { id: "p" },
    });
  });
});

describe("welcomeGreeting", () => {
  it("introduces Larry by default and keeps a custom name as plain text", () => {
    expect(welcomeGreeting("  ")).toContain("I’m Larry,");
    expect(welcomeGreeting("Personal Assistant")).toContain("I’m Larry,");
    expect(welcomeGreeting("**Ada** [x](y)")).toContain(
      "I’m \\*\\*Ada\\*\\* \\[x\\]\\(y\\),",
    );
  });
});

describe("first-run naming", () => {
  it("introduces Larry while no name is saved, and keeps a saved one", () => {
    expect(firstRunAssistantName("")).toBe("Larry");
    expect(firstRunAssistantName("Personal Assistant")).toBe("Larry");
    expect(firstRunAssistantName(" Ada ")).toBe("Ada");
  });
});
