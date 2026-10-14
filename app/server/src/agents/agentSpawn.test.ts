/**
 * Resolving a definition for a spawn (`docs/agent-definitions.md` "Spawning
 * by name"): the library's current bytes, the runtime check, the account
 * function, and never a fallback.
 *
 * Run with:
 *   pnpm --filter @assistant/server test src/agents/agentSpawn.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelOption } from "@assistant/shared";
import { afterEach, beforeEach, test } from "vitest";
import { agentKind, formatAgentManifest } from "./agentLibrary.ts";
import {
  setAgentRuntimeSourcesForTests,
  type AgentModelOption,
} from "./agentRuntime.ts";
import {
  AgentSpawnRefusedError,
  listSpawnableAgents,
  resolveAgentSpawn,
  setAgentSpawnSourcesForTests,
} from "./agentSpawn.ts";
import { LibraryStore } from "../library/libraryStore.ts";
import { scanLibrary } from "../library/libraryScanner.ts";

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
let models: AgentModelOption[];
let offered: boolean;
const accounts: string[] = [];

/** What `git hash-object` says for a definition's file in its repository. */
function hashObject(folder: string): string {
  return execFileSync("git", ["hash-object", join(folder, "AGENT.md")], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

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
  write("test-reviewer", reviewer({ effort: "high" }));
  const runtime = await resolveAgentSpawn("test-reviewer");
  assert.deepEqual(runtime.agent, {
    name: "test-reviewer",
    blob: hashObject("test-reviewer"),
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

test("a definition naming a concrete version freezes that version", async () => {
  models = [{ ...model("claude-sdk", "opus"), pinnedId: "claude-opus-5-5" }];
  write("test-reviewer", reviewer({ model: "claude-opus-5-5" }));
  const { agent } = await resolveAgentSpawn("test-reviewer");
  assert.equal(agent.model, "opus");
  assert.equal(agent.pinnedModel, "claude-opus-5-5");
  write("test-reviewer", reviewer());
  assert.equal(
    (await resolveAgentSpawn("test-reviewer")).agent.pinnedModel,
    undefined,
  );
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

test("the frozen blob id is the library repository's own, SHA-256 included", async () => {
  root = mkdtempSync(join(tmpdir(), "agent-spawn-sha256-"));
  execFileSync("git", ["init", "-q", "--object-format=sha256", root]);
  const store = new LibraryStore(agentKind, root);
  await store.ensureInitialized();
  setAgentSpawnSourcesForTests({
    library: () => store,
    accountFor: (provider) => `acct-${provider}`,
    offers: async () => true,
    accountName: () => undefined,
  });
  write("test-reviewer", reviewer({ body: "Body — with ünïcode." }));

  const { agent } = await resolveAgentSpawn("test-reviewer");
  assert.equal(agent.blob.length, 64);
  assert.equal(agent.blob, hashObject("test-reviewer"));
});

test("the frozen blob id names the bytes on disk, a BOM or invalid UTF-8 included", async () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const invalid = Buffer.from([0xff, 0xfe, 0x0a]);
  const files = {
    "with-bom": Buffer.concat([
      bom,
      Buffer.from(reviewer({ name: "with-bom" })),
    ]),
    "bad-utf8": Buffer.concat([
      Buffer.from(reviewer({ name: "bad-utf8" })),
      invalid,
    ]),
  };
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "AGENT.md"), bytes);
  }
  // Both still parse; only the decoded text differs from the file.
  for (const name of Object.keys(files)) {
    const { agent } = await resolveAgentSpawn(name);
    assert.equal(agent.blob, hashObject(name), name);
  }
});

test("a refusal for an invalid definition stays bounded, however much is wrong", async () => {
  // Thousands of unknown keys, each its own problem quoting its key.
  const keys = Array.from(
    { length: 2500 },
    (_, at) => `k${at}${"x".repeat(40)}: 1`,
  ).join("\n");
  mkdirSync(join(root, "rev"), { recursive: true });
  writeFileSync(
    join(root, "rev", "AGENT.md"),
    `---\nname: rev\ndescription: Reviews.\npersona: developer\nmodel: opus\n${keys}\n---\nReview.\n`,
  );
  // And a name a thousand folders declare, each with a problem of its own.
  for (let at = 0; at < 1000; at++)
    write(`dup-${at}`, reviewer().replace("---\n", `---\nextra${at}: 1\n`));

  for (const name of ["rev", "test-reviewer"]) {
    const refusal = await resolveAgentSpawn(name).then(
      () => assert.fail(`${name} should be refused`),
      (error: Error) => error,
    );
    assert.ok(refusal instanceof AgentSpawnRefusedError);
    assert.ok(
      refusal.message.length < 3_000,
      `${name}: ${refusal.message.length}`,
    );
  }
});

test("a folder keeps a few diagnostics, the last saying how many more", async () => {
  const keys = Array.from({ length: 8 }, (_, at) => `extra${at}: 1`).join("\n");
  write("noisy", reviewer().replace("---\n", `---\n${keys}\n`));

  const { diagnostics } = await scanLibrary(agentKind, root);

  assert.equal(diagnostics.length, 5);
  assert.match(
    diagnostics.at(-1)!.error,
    /And 3 more problems in noisy\/AGENT\.md\.$/,
  );
});
