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

test("guided setup continues from models to Git, locations and selected integrations", () => {
  const prompt = permanentAssistantProfileInstructions(
    {
      name: "Larry",
      provider: "claude-sdk",
      modelId: "opus",
      thinkingLevel: "medium",
      additionalInstructions: "",
    },
    { guidedSetup: true },
  );
  assert.ok(
    prompt.indexOf("2. Use models_read") < prompt.indexOf("3. After models"),
  );
  assert.match(prompt, /call git_setup_read BEFORE claiming/);
  assert.match(prompt, /github_pat_setup_link/);
  assert.match(
    prompt,
    /classic PAT creation link with repo, workflow, read:packages and notifications/,
  );
  assert.match(
    prompt,
    /assistant message immediately BEFORE invoking settings_request_input/,
  );
  assert.match(
    prompt,
    /actual clickable link returned by github_pat_setup_link/,
  );
  assert.match(
    prompt,
    /it must be visible in your message WHEN you ask for the token/,
  );
  assert.match(prompt, /projectsRoot and worktrees.root/);
  assert.match(prompt, /multi-select ask_questions card/);
  assert.match(prompt, /memory.loadingEnabled/);
  assert.match(prompt, /End each setup reply with the next concrete question/);
});
