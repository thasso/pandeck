/**
 * Resolving a definition for a spawn (`docs/agent-definitions.md` "Spawning
 * by name"): the library's current bytes, the runtime check, the account
 * function, and never a fallback.
 *
 * Run with:
 *   pnpm --filter @assistant/server test src/agents/agentSpawn.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelOption } from "@assistant/shared";
import { afterEach, beforeEach, test } from "vitest";
import { agentKind, formatAgentManifest } from "./agentLibrary.ts";
import { setAgentRuntimeSourcesForTests } from "./agentRuntime.ts";
import {
  AgentSpawnRefusedError,
  listSpawnableAgents,
  resolveAgentSpawn,
  setAgentSpawnSourcesForTests,
} from "./agentSpawn.ts";
import { gitBlobId } from "./sessionAgent.ts";
import { LibraryStore } from "../library/libraryStore.ts";

function model(
  provider: string,
  id: string,
  levels: ModelOption["supportedThinkingLevels"] = ["low", "medium", "high"],
): ModelOption {
  return {
    provider,
    id,
    name: id,
    reasoning: true,
    supportedThinkingLevels: levels,
    contextWindow: 200_000,
  };
}

let root: string;
let models: ModelOption[];
let offered: boolean;
const accounts: string[] = [];

function write(folder: string, source: string): string {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, "AGENT.md"), source);
  return source;
}

const reviewer = (patch: Record<string, unknown> = {}) =>
  formatAgentManifest({
    name: "test-reviewer",
    description: "Checks that new tests fail without the change.",
    persona: "developer",
    model: "opus",
    denyTools: ["worktree_push"],
    skills: [],
    body: "You are a test reviewer.",
    ...patch,
  } as never);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "agent-spawn-"));
  const store = new LibraryStore(agentKind, root);
  await store.ensureInitialized();
  models = [model("claude-sdk", "opus"), model("openai-codex", "gpt-6.1-sol")];
  offered = true;
  accounts.length = 0;
  setAgentRuntimeSourcesForTests({
    models: async () => models,
    skillNames: async () => [],
    toolNames: async () => ["worktree_push"],
  });
  setAgentSpawnSourcesForTests({
    library: () => store,
    accountFor: (provider) => {
      accounts.push(provider);
      return `acct-${provider}`;
    },
    offers: async () => offered,
    accountName: (id) => `Account ${id}`,
  });
});

afterEach(() => {
  setAgentRuntimeSourcesForTests(null);
  setAgentSpawnSourcesForTests(null);
});

test("a definition resolves to its model, account and the exact bytes it froze", async () => {
  const source = write("test-reviewer", reviewer({ effort: "high" }));
  const runtime = await resolveAgentSpawn("test-reviewer");
  assert.deepEqual(runtime.agent, {
    name: "test-reviewer",
    blob: gitBlobId(source),
    persona: "developer",
    provider: "claude-sdk",
    model: "opus",
    effort: "high",
    denyTools: ["worktree_push"],
    skills: [],
    body: "You are a test reviewer.",
  });
  assert.equal(runtime.credentialProfileId, "acct-claude-sdk");
  assert.equal(runtime.accountName, "Account acct-claude-sdk");
  assert.deepEqual(accounts, ["claude-sdk"]);
});

test("no effort runs at the default, fitted to the model", async () => {
  models = [model("claude-sdk", "opus", ["high", "max"])];
  write("test-reviewer", reviewer());
  const runtime = await resolveAgentSpawn("test-reviewer");
  assert.equal(runtime.thinkingLevel, "high");
  assert.equal(runtime.agent.effort, "high");
});

test("a model that stopped resolving refuses; nothing falls back", async () => {
  write("test-reviewer", reviewer());
  models = [model("openai-codex", "gpt-6.1-sol")];
  await assert.rejects(
    resolveAgentSpawn("test-reviewer"),
    (error: Error) =>
      error instanceof AgentSpawnRefusedError &&
      /Agent "test-reviewer" cannot run: No enabled account offers a model "opus"/.test(
        error.message,
      ),
  );
});

test("an account that does not offer the model refuses", async () => {
  write("test-reviewer", reviewer());
  offered = false;
  await assert.rejects(
    resolveAgentSpawn("test-reviewer"),
    /the account its claude-sdk sessions use \(Account acct-claude-sdk\) does not offer claude-sdk\/opus/,
  );
});

test("an unknown or invalid name says why, in the scanner's words", async () => {
  await assert.rejects(
    resolveAgentSpawn("nobody"),
    /There is no agent definition named "nobody"\. Call session_spawn with operation "agents"/,
  );
  write("broken", "---\nname: broken\ndescription: d\n---\n");
  await assert.rejects(
    resolveAgentSpawn("broken"),
    /Agent definition "broken" is not valid: /,
  );
});

test('operation "agents" lists runnable definitions and why the rest are not', async () => {
  write("test-reviewer", reviewer());
  write("solo", reviewer({ name: "solo", model: "gemini" }));
  write("broken", "---\nname: broken\n---\nBody\n");
  const rows = await listSpawnableAgents();
  const byName = new Map(rows.map((row) => [row.name, row]));
  const ok = byName.get("test-reviewer");
  assert.ok(ok && "runtime" in ok);
  assert.equal(ok.runtime.modelId, "opus");
  const solo = byName.get("solo");
  assert.ok(solo && "problem" in solo);
  assert.match(solo.problem, /No enabled account offers a model "gemini"/);
  const broken = byName.get("broken");
  assert.ok(broken && "problem" in broken);
});
