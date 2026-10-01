import { describe, expect, it } from "vitest";
import { hasModeAxis } from "./sessionCapabilities";

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
