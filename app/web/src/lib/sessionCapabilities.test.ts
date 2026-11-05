import { describe, expect, it } from "vitest";
import { hasModeAxis, startedModelDisabled } from "./sessionCapabilities";

describe("hasModeAxis", () => {
  it("offers Build/Plan to every interactive persona", () => {
    for (const agentType of [
      "assistant",
      "personal-assistant",
      "workshop",
      "developer",
    ] as const)
      expect(hasModeAxis({ agentType })).toBe(true);
  });

  it("keeps the server-owned workflow coordinator mode-less", () => {
    expect(hasModeAxis({ agentType: "workflow-coordinator" })).toBe(false);
    expect(hasModeAxis({})).toBe(false);
  });
});

describe("startedModelDisabled", () => {
  const endpointA = {
    id: "openai-compatible",
    provider: "openai-compatible",
  } as const;
  const endpointB = {
    id: "openai-compatible-0123456789ab",
    provider: "openai-compatible",
  } as const;
  const login = { id: "default", provider: "openai-codex" } as const;
  const model = (provider: string) => ({ provider, id: "m" });
  const pi = (account: typeof login | typeof endpointA | typeof endpointB) => ({
    harness: "pi" as const,
    started: true,
    account,
  });

  it("keeps a started pi session on its bound account's models", () => {
    expect(startedModelDisabled(pi(endpointA), model(endpointA.id))).toBe(
      false,
    );
    expect(startedModelDisabled(pi(endpointA), model(endpointB.id))).toBe(true);
    expect(startedModelDisabled(pi(endpointA), model("openai-codex"))).toBe(
      true,
    );
    expect(startedModelDisabled(pi(login), model("openai-codex"))).toBe(false);
    expect(startedModelDisabled(pi(login), model(endpointA.id))).toBe(true);
    expect(startedModelDisabled(pi(login), model("claude-sdk"))).toBe(true);
  });

  it("offers everything before the first turn", () => {
    expect(
      startedModelDisabled(
        { harness: "pi", started: false, account: endpointA },
        model("openai-codex"),
      ),
    ).toBe(false);
  });
});
