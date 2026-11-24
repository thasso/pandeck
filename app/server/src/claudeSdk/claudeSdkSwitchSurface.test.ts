/**
 * A harness switch keeps the session's prompt conditions
 * (`docs/session-runtime-switching.md`): every binding reads the one
 * insert-only record the session froze at its start, and each engine still
 * renders its OWN prompt and tool surface from it — pi its persona layer and
 * bare tool names, Claude the `claude_code` preset's append and the
 * `mcp__pa__`-prefixed names of its mounted server.
 */
import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AGENT_TYPES } from "../agentTypes.ts";
import { permanentAssistantProfileInstructions } from "../permanentAssistantProfile.ts";
import { getSettings } from "../settings.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { externalToolName } from "../mcp/names.ts";
import { resolvePiEngineStart } from "../piSdk/piEngineStart.ts";
import {
  computePromptConditions,
  sessionPromptConditions,
  type PromptConditions,
} from "../promptConditions.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";
import { ensureRuntimeSessionWithRuntime } from "../session/runtimePrompt.ts";
import { installClaudeStateBuilder } from "../test/claudeSdkSession.ts";
import { claudeTurnSeam } from "../test/claudeTurnSeam.ts";
import { seedLegacyDefaultAccounts } from "../test/legacyDefaultAccounts.ts";
import { eagerToolNamesFor } from "../tools/catalog.ts";
import type { ClaudeQueryParams } from "./sdkSeam.ts";
import { claudeSdkStore } from "./claudeSdkStore.ts";
import { createClaudeSessionToolServer } from "./toolServer.ts";

installClaudeStateBuilder(claudeSdkStore);
await seedLegacyDefaultAccounts();

const ID = `switch-surface-${Date.now()}`;
const PA_ID = `switch-surface-pa-${Date.now()}`;
const queries: ClaudeQueryParams[] = [];

beforeAll(() =>
  claudeSdkStore.setSeam(() =>
    Promise.resolve({
      ...claudeTurnSeam,
      query: (params) => {
        queries.push(params);
        return claudeTurnSeam.query(params);
      },
    }),
  ),
);
afterAll(() => {
  claudeSdkStore.remove(ID);
  claudeSdkStore.remove(PA_ID);
});

/**
 * What the session froze when it started on pi: a first prompt with user
 * files, the Knowledge Base off and a known Project. A Claude binding starting
 * today would compute none of that.
 */
const FROZEN: PromptConditions = {
  attachments: true,
  slack: false,
  google: false,
  tempo: false,
  knowledgeBase: false,
  projectRegistryPointer: false,
  memoryWrite: false,
  guidedSetup: false,
};

test("each engine renders its own prompt and tools from the one frozen record", async () => {
  assert.ok(
    sessionStore.upsert({
      id: ID,
      harness: "pi",
      agentType: "developer",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      credentialProfileId: "cp_pi",
    }),
  );
  assert.deepEqual(
    sessionPromptConditions(ID, "developer", undefined, FROZEN),
    FROZEN,
  );
  const record = sessionStore.getPromptConditions(ID);
  assert.notDeepEqual(
    computePromptConditions("developer"),
    FROZEN,
    "a binding that computed its own would differ",
  );
  const persona = AGENT_TYPES.developer.systemPrompt({ conditions: FROZEN });
  assert.notEqual(
    persona,
    AGENT_TYPES.developer.systemPrompt({
      conditions: computePromptConditions("developer"),
    }),
  );
  const eager = [...eagerToolNamesFor("developer", FROZEN)].sort();
  assert.ok(eager.includes("list_attachments"), "the record's eager group");

  // pi: the persona layer appended to pi's own prompt, bare tool names.
  const pi = await resolvePiEngineStart({
    kind: "developer",
    credentialProfileId: "cp_pi",
    knownId: ID,
  });
  assert.deepEqual(pi.start.conditions, FROZEN);
  assert.ok("append" in pi.persona.systemPrompt);
  assert.equal(pi.persona.systemPrompt.append[0], persona);
  assert.deepEqual([...pi.persona.eagerToolNames].sort(), eager);
  assert.ok(pi.persona.eagerToolNames.every((name) => !name.includes("__")));

  // Claude, bound later to the same session: the `claude_code` preset with
  // the same persona appended.
  const claude = claudeSdkStore.openForBinding(ID, {
    model: "claude-opus-5-5",
    thinkingLevel: "high",
    credentialProfileId: "claude-default",
    providerSessionId: undefined,
    agentType: "developer",
    mode: "build",
    title: "Switched",
    createdAt: Date.now(),
  });
  ensureRuntimeSessionWithRuntime(sessionRuntime, claude);
  await sessionRuntime.prompt(ID, "carry on");
  assert.deepEqual(queries.at(-1)?.options?.systemPrompt, {
    type: "preset",
    preset: "claude_code",
    append: persona,
  });

  // …and its mounted server marks the same eager tools under their
  // `mcp__pa__` names.
  const server = createClaudeSessionToolServer({
    id: ID,
    agentType: "developer",
    sessionMode: "build",
    cwd: claude.cwd,
    timelineEntries: () => [],
    broadcastState: () => {},
    assertToolAdmission() {},
  });
  const client = new Client({ name: "switch-surface", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const listed = await client.listTools();
    const alwaysLoaded = listed.tools
      .filter((tool) => tool._meta?.["anthropic/alwaysLoad"] === true)
      .map((tool) => externalToolName(tool.name))
      .sort();
    assert.deepEqual(alwaysLoaded, eager.map(externalToolName));
    assert.ok(alwaysLoaded.includes("mcp__pa__list_attachments"));
  } finally {
    await client.close();
    await server.close();
  }

  assert.equal(
    sessionStore.getPromptConditions(ID),
    record,
    "neither engine rewrote the record",
  );
});

test("the permanent assistant's profile suffix comes from settings on both engines", async () => {
  assert.ok(
    sessionStore.upsert({
      id: PA_ID,
      harness: "pi",
      agentType: "personal-assistant",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      credentialProfileId: "cp_pi",
    }),
  );
  const conditions = sessionPromptConditions(
    PA_ID,
    "personal-assistant",
    undefined,
    { ...FROZEN, memoryWrite: true },
  );
  const expected = `${AGENT_TYPES["personal-assistant"].systemPrompt({ conditions })}\n\n## Personal profile instructions\n\n${permanentAssistantProfileInstructions(getSettings().permanentAssistant)}`;

  const pi = await resolvePiEngineStart({
    kind: "personal-assistant",
    credentialProfileId: "cp_pi",
    knownId: PA_ID,
  });
  assert.deepEqual(pi.persona.systemPrompt, { replace: expected });

  const claude = claudeSdkStore.openForBinding(PA_ID, {
    model: "claude-opus-5-5",
    thinkingLevel: "high",
    credentialProfileId: "claude-default",
    providerSessionId: undefined,
    agentType: "personal-assistant",
    mode: "build",
    title: "Switched",
    createdAt: Date.now(),
  });
  ensureRuntimeSessionWithRuntime(sessionRuntime, claude);
  await sessionRuntime.prompt(PA_ID, "carry on");
  assert.equal(queries.at(-1)?.options?.systemPrompt, expected);
});
