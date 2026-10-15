/**
 * The `agents` topic list: the shared scan plus each definition's runtime or
 * problem, keyed by its declared name (`docs/agent-definitions.md` "UI").
 *
 * Run with:
 *   pnpm --filter @assistant/server test src/agents/agentLibraryList.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { LibraryStore } from "../library/libraryStore.ts";
import { agentKind, formatAgentManifest } from "./agentLibrary.ts";
import { agentLibraryListMessage } from "./agentLibraryList.ts";
import { setAgentRuntimeSourcesForTests } from "./agentRuntime.ts";
import { setAgentSpawnSourcesForTests } from "./agentSpawn.ts";

afterEach(() => {
  setAgentRuntimeSourcesForTests(null);
  setAgentSpawnSourcesForTests(null);
});

test("a definition named like an Object member still gets its runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-list-"));
  for (const name of ["constructor", "reviewer"]) {
    mkdirSync(join(root, name));
    writeFileSync(
      join(root, name, "AGENT.md"),
      formatAgentManifest({
        name,
        description: "An agent.",
        persona: "assistant",
        models: ["opus"],
        denyTools: [],
        skills: [],
        body: "Work.",
      }),
    );
  }
  setAgentRuntimeSourcesForTests({
    models: async () => [
      {
        provider: "claude-sdk",
        id: "opus",
        name: "Opus",
        reasoning: true,
        supportedThinkingLevels: ["low", "medium", "high"],
        contextWindow: 200_000,
      },
    ],
    skillNames: async () => [],
    toolNames: async () => [],
  });
  setAgentSpawnSourcesForTests({ offers: async () => true });

  const message = await agentLibraryListMessage(
    new LibraryStore(agentKind, root),
  );

  assert.ok(message.type === "libraryList" && message.list);
  for (const name of ["constructor", "reviewer"])
    assert.equal(
      Object.hasOwn(message.list.agentRuntimes ?? {}, name) &&
        message.list.agentRuntimes?.[name]?.persona,
      "assistant",
      name,
    );
});

test("a definition whose default cannot run still lists every model it names", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-list-"));
  mkdirSync(join(root, "reviewer"));
  writeFileSync(
    join(root, "reviewer", "AGENT.md"),
    formatAgentManifest({
      name: "reviewer",
      description: "Reviews.",
      persona: "developer",
      models: ["gemini", "opus"],
      effort: "high",
      body: "Review.",
    }),
  );
  setAgentRuntimeSourcesForTests({
    models: async () => [
      {
        provider: "claude-sdk",
        id: "opus",
        name: "Opus",
        reasoning: true,
        supportedThinkingLevels: ["low", "medium", "high"],
        contextWindow: 200_000,
      },
    ],
    skillNames: async () => [],
    toolNames: async () => [],
  });
  setAgentSpawnSourcesForTests({ offers: async () => true });

  const message = await agentLibraryListMessage(
    new LibraryStore(agentKind, root),
  );

  assert.ok(message.type === "libraryList" && message.list);
  const runtime = message.list.agentRuntimes?.reviewer;
  assert.match(runtime?.problem ?? "", /default model "gemini"/);
  assert.deepEqual(runtime?.models?.[1], {
    spec: "opus",
    provider: "claude-sdk",
    modelId: "opus",
    thinkingLevel: "high",
  });
  assert.match(runtime?.models?.[0]?.problem ?? "", /"gemini"/);
});
