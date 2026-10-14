/**
 * Task 92: the singleton-only `personal-assistant` persona.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/personalAssistantPersona.test.ts
 *
 * Covers the persona registry, picker/availability exclusion, the client
 * creation guard, per-harness option construction, and the pi session-store
 * directory mapping — the deterministic pieces that do not require a live
 * runtime or database.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isOrdinarilyCreatableAgentType,
  isPersonalAssistantAgentType,
  ORDINARILY_CREATABLE_AGENT_TYPES,
} from "@assistant/shared";
import { AGENT_TYPES } from "./agentTypes.ts";
import {
  availableAgents,
  isAgentAvailable,
  isAgentSessionAvailable,
  personalAssistantSystemPromptText,
} from "./agents.ts";
import {
  buildClaudeSdkQueryOptions,
  CLAUDE_SDK_NATIVE_TOOLS,
} from "./claudeSdk/options.ts";
import { sessionDirFor } from "./piSdk/options.ts";
import { PERSONAL_ASSISTANT_SESSION_DIR } from "./config.ts";
import { assertPromptRules } from "./test/promptRules.ts";

test("personal-assistant is a real persona with integrations, settings and coding-start tools", () => {
  const def = AGENT_TYPES["personal-assistant"];
  assert.ok(def, "AGENT_TYPES has a personal-assistant entry");
  assert.equal(def.label, "Personal Assistant");
  assert.equal(def.agentType, "personal-assistant");
  // The ordinary Assistant's universe plus settings and coding-start tools.
  const paNames = def
    .tools()
    .map((t) => t.name)
    .sort();
  const asstNames = AGENT_TYPES.assistant
    .tools()
    .map((t) => t.name)
    .sort();
  assert.deepEqual(
    paNames,
    [
      ...asstNames,
      "settings_read",
      "settings_update",
      "settings_request_input",
      "accounts_read",
      "accounts_update",
      "accounts_sign_in",
      "worktree_create",
      "worktree_status",
    ].sort(),
    "personal-assistant adds settings and managed worktree startup",
  );
});

test("personal-assistant is never available for ordinary creation or the picker", () => {
  assert.equal(
    isAgentAvailable("personal-assistant"),
    false,
    "not available for generic creation",
  );
  assert.equal(
    isAgentSessionAvailable("personal-assistant"),
    true,
    "server-created singleton sessions remain loadable",
  );
  assert.ok(
    !availableAgents().some((a) => a.agentType === "personal-assistant"),
    "excluded from the persona picker",
  );
  // Ordinary assistant remains selectable.
  assert.ok(
    availableAgents().some((a) => a.agentType === "assistant"),
    "ordinary assistant stays selectable",
  );
});

test("the client creation guard rejects a crafted personal-assistant key", () => {
  assert.equal(isOrdinarilyCreatableAgentType("personal-assistant"), false);
  assert.equal(isOrdinarilyCreatableAgentType("assistant"), true);
  assert.equal(isOrdinarilyCreatableAgentType("workshop"), true);
  assert.equal(isOrdinarilyCreatableAgentType("developer"), true);
  assert.equal(isOrdinarilyCreatableAgentType("nonsense"), false);
  assert.equal(isOrdinarilyCreatableAgentType(undefined), false);
  assert.ok(
    !ORDINARILY_CREATABLE_AGENT_TYPES.includes("personal-assistant" as never),
  );
  assert.ok(isPersonalAssistantAgentType("personal-assistant"));
  assert.ok(!isPersonalAssistantAgentType("assistant"));
});

test("pi session store maps personal-assistant to its own dedicated directory", () => {
  assert.equal(
    sessionDirFor("personal-assistant"),
    PERSONAL_ASSISTANT_SESSION_DIR,
  );
  assert.notEqual(
    sessionDirFor("personal-assistant"),
    sessionDirFor("assistant"),
  );
});

test("claude-sdk personal-assistant has native access and always carries the profile suffix", async () => {
  const base = {
    cwd: "/tmp",
    abortController: new AbortController(),
    modelId: "sonnet",
    thinkingLevel: "low" as const,
  };
  const pa = buildClaudeSdkQueryOptions({
    ...base,
    agentType: "personal-assistant",
    additionalSystemPrompt: "Call me T.",
  });
  assert.deepEqual(pa.tools, [...CLAUDE_SDK_NATIVE_TOOLS, "ToolSearch"]);
  for (const t of CLAUDE_SDK_NATIVE_TOOLS) {
    assert.ok(!(pa.disallowedTools as string[]).includes(t));
    const verdict = await pa.canUseTool!(t, {}, {} as never);
    assert.equal(verdict?.behavior, "allow", `allows native ${t}`);
  }
  // Locked-down (non-preset) prompt with the profile suffix appended.
  assert.equal(
    pa.systemPrompt,
    `${AGENT_TYPES["personal-assistant"].systemPrompt()}\n\n## Personal profile instructions\n\nCall me T.`,
    "personal-assistant appends the permanent profile suffix to its locked-down prompt",
  );
});

test("the personal-assistant prompt states its persona rules", () => {
  assertPromptRules({
    "personal-assistant prompt": {
      text: personalAssistantSystemPromptText(),
      rules: {
        "is-the-permanent-assistant": /permanent Personal Assistant/i,
        "differs-from-assistant": (text) =>
          text !== AGENT_TYPES.assistant.systemPrompt(),
        // The persona file wraps its lines, so a sentence may span several.
        "continuous-across-days-and-channels": /across[^.]*days[^.]*channels/i,
        "records-people-via-contacts": /contacts_manage/,
        "project-edits-use-delegation":
          /worktree_create[\s\S]*session_spawn[\s\S]*developer/,
        "no-direct-checkout-edits": /never direct checkout edits/,
        "enrichment-is-expected": /not optional/i,
        // The shared Memory section forbids secrets too; this is the PA's own rule.
        "enrichment-skips-sensitive-personal-data":
          /never[^.]*sensitive\s+personal\s+data/i,
      },
    },
  });
});
