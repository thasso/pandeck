import assert from "node:assert/strict";
import { test } from "vitest";
import { permanentAssistantProfileInstructions } from "./permanentAssistantProfile.ts";

test("permanent Assistant profile includes its configured identity and instructions", () => {
  const prompt = permanentAssistantProfileInstructions({
    name: "Ada",
    provider: "github-copilot",
    modelId: "gpt-4.1",
    thinkingLevel: "off",
    additionalInstructions: "Prefer concise replies.",
  });
  assert.match(prompt, /Your name is "Ada"/);
  assert.match(prompt, /Prefer concise replies\./);
});
