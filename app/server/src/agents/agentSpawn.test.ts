/**
 * Resolving a definition for a spawn (`docs/agent-definitions.md` "Spawning
 * by name"): the library's current bytes, the runtime check, the account
 * function, and router-owned account-health fallback.
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
import { spawnableAgentsText } from "../tools/sessions/sessionSpawnTool.ts";
import { agentKind, formatAgentManifest } from "./agentLibrary.ts";
import {
  setAgentRuntimeSourcesForTests,
  type AgentModelOption,
} from "./agentRuntime.ts";
import {
  AgentSpawnRefusedError,
  listSpawnableAgents,
  resolveAgentOnRuntime,
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

/** A definition's source; a `model` patch is its one listed model. */
const reviewer = (patch: Record<string, unknown> = {}) => {
  const { model, ...definition } = {
    name: "test-reviewer",
    description: "Checks that new tests fail without the change.",
    persona: "developer",
    model: "opus",
    denyTools: ["worktree_push"],
    skills: [],
    body: "You are a test reviewer.",
    ...patch,
  };
  return formatAgentManifest({
    models: [model],
    ...definition,
  } as never);
};

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
    accountFor: ({ model: { provider } }) => {
      accounts.push(provider);
      return { profileId: `acct-${provider}` };
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
    runtimeSource: "definition",
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

test("a caller picks a listed model by any name it resolves to; the role is the same", async () => {
  write(
    "test-reviewer",
    reviewer({ model: undefined, models: ["sol", "opus"], effort: "high" }),
  );
  const byDefault = await resolveAgentSpawn("test-reviewer");
  assert.equal(byDefault.provider, "openai-codex");
  assert.equal(byDefault.modelId, "gpt-6.1-sol");
  assert.deepEqual(
    byDefault.listed.map((choice) => choice.spec),
    ["sol", "opus"],
  );
  for (const name of ["opus", "claude-sdk/opus", "OPUS"]) {
    const picked = await resolveAgentSpawn("test-reviewer", undefined, {
      model: name,
    });
    assert.equal(picked.provider, "claude-sdk");
    assert.equal(picked.modelId, "opus");
    assert.equal(picked.credentialProfileId, "acct-claude-sdk");
    const { provider: _p, model: _m, ...role } = picked.agent;
    const { provider: _dp, model: _dm, ...defaultRole } = byDefault.agent;
    assert.deepEqual(role, defaultRole, "only the runtime differs");
  }
  assert.equal(
    (
      await resolveAgentSpawn("test-reviewer", undefined, {
        model: "gpt-6.1-sol",
      })
    ).modelId,
    "gpt-6.1-sol",
  );
});

test("health fallback follows definition order and skips unresolved or degraded alternatives", async () => {
  models.push(model("claude-sdk", "sonnet"));
  write(
    "test-reviewer",
    reviewer({ models: ["sol", "missing", "opus", "sonnet"] }),
  );
  const picks: string[] = [];
  setAgentSpawnSourcesForTests({
    library: () => new LibraryStore(agentKind, root),
    offers: async () => true,
    accountFor: ({ model: { provider, modelId } }) => {
      picks.push(modelId);
      return {
        profileId: `acct-${provider}`,
        ...(modelId !== "sonnet"
          ? { degraded: "no-eligible-account" as const }
          : {}),
      };
    },
  });

  const runtime = await resolveAgentSpawn("test-reviewer", undefined, {
    allowModelFallback: true,
  });

  assert.equal(runtime.modelId, "sonnet");
  assert.deepEqual(picks, ["gpt-6.1-sol", "opus", "sonnet"]);
  assert.equal(
    runtime.agent.modelFallbackReason,
    "sol has no eligible account; missing does not resolve; opus has no eligible account; used sonnet",
  );
  const [browser] = await listSpawnableAgents();
  assert.ok(browser && "runtime" in browser);
  assert.equal(
    browser.runtime.modelId,
    "gpt-6.1-sol",
    "browser prefill does not follow temporary health",
  );
  const text = spawnableAgentsText(
    await listSpawnableAgents(undefined, { allowModelFallback: true }),
  );
  assert.match(text, /developer on claude-sdk\/sonnet/);
  assert.match(
    text,
    /sol has no eligible account; missing does not resolve; opus has no eligible account; used sonnet/,
  );
  assert.match(text, /also runs on: sol/);
  assert.doesNotMatch(text, /also runs on: .*sonnet \(claude-sdk\/sonnet,/);
});

test("without a healthy alternative the router's degraded default still runs", async () => {
  write("test-reviewer", reviewer({ models: ["sol", "opus"] }));
  setAgentSpawnSourcesForTests({
    library: () => new LibraryStore(agentKind, root),
    offers: async () => true,
    accountFor: ({ model: { provider } }) => ({
      profileId: `acct-${provider}`,
      degraded: "no-eligible-account",
    }),
  });
  const runtime = await resolveAgentSpawn("test-reviewer", undefined, {
    allowModelFallback: true,
  });
  assert.equal(runtime.modelId, "gpt-6.1-sol");
  assert.equal(runtime.agent.modelFallbackReason, undefined);
});

test("an account pin never causes model fallback", async () => {
  write("test-reviewer", reviewer({ models: ["sol", "opus"] }));
  const runtime = await resolveAgentSpawn("test-reviewer", undefined, {
    profileId: "pinned",
    allowModelFallback: true,
  });
  assert.equal(runtime.modelId, "gpt-6.1-sol");
  assert.equal(runtime.credentialProfileId, "pinned");
  assert.deepEqual(accounts, []);
});

test("a healthy default never probes later listed accounts", async () => {
  write("test-reviewer", reviewer({ models: ["sol", "opus"] }));
  const runtime = await resolveAgentSpawn("test-reviewer", undefined, {
    allowModelFallback: true,
  });
  assert.equal(runtime.modelId, "gpt-6.1-sol");
  assert.deepEqual(accounts, ["openai-codex"]);
  assert.equal(runtime.agent.modelFallbackReason, undefined);
});

test("a model the definition does not list is refused, never approximated", async () => {
  models.push(model("claude-sdk", "sonnet"));
  write("test-reviewer", reviewer({ model: undefined, models: ["opus"] }));
  await assert.rejects(
    resolveAgentSpawn("test-reviewer", undefined, { model: "sonnet" }),
    /does not list "sonnet"; it runs only on opus\. To run it on another model, use operation "propose"/,
  );
});

test("a listed model that cannot run refuses when named; the default still runs", async () => {
  write(
    "test-reviewer",
    reviewer({ model: undefined, models: ["opus", "gemini"] }),
  );
  await assert.rejects(
    resolveAgentSpawn("test-reviewer", undefined, { model: "gemini" }),
    /Agent "test-reviewer" cannot run on "gemini": No enabled account offers a model "gemini"/,
  );
  const runtime = await resolveAgentSpawn("test-reviewer");
  assert.equal(runtime.modelId, "opus");
  assert.match(runtime.listed[1]?.problem ?? "", /"gemini"/);
});

test("a name matching two listed models is refused as ambiguous", async () => {
  models = [
    { ...model("claude-sdk", "opus"), pinnedId: "claude-opus-5-5" },
    model("openai-codex", "gpt-6.1-sol"),
  ];
  write(
    "test-reviewer",
    reviewer({ model: undefined, models: ["opus", "claude-opus-5-5"] }),
  );
  await assert.rejects(
    resolveAgentSpawn("test-reviewer", undefined, { model: "claude-sdk/opus" }),
    /names more than one model agent "test-reviewer" lists \(opus, claude-opus-5-5\)/,
  );
  const pinned = await resolveAgentSpawn("test-reviewer", undefined, {
    model: "claude-opus-5-5",
  });
  assert.equal(pinned.agent.pinnedModel, "claude-opus-5-5");
});

test("a listing keeps every listed model when only the default cannot run", async () => {
  write(
    "test-reviewer",
    reviewer({ model: undefined, models: ["gemini", "sol"] }),
  );
  const [row] = await listSpawnableAgents();
  assert.ok(row && "problem" in row);
  assert.match(row.problem, /cannot run on its default model "gemini"/);
  assert.deepEqual(
    row.listed?.map((choice) => [choice.spec, choice.runtime?.model.id]),
    [
      ["gemini", undefined],
      ["sol", "gpt-6.1-sol"],
    ],
  );
  // The default resolved but its account refused it: it is no alternative.
  write(
    "test-reviewer",
    reviewer({ model: undefined, models: ["opus", "sol"] }),
  );
  offered = false;
  const [refused] = await listSpawnableAgents();
  assert.ok(refused && "problem" in refused);
  assert.equal(refused.listed?.[0]?.runtime, undefined);
  assert.match(
    refused.listed?.[0]?.problem ?? "",
    /does not offer claude-sdk\/opus/,
  );
  assert.equal(refused.listed?.[1]?.runtime?.model.id, "gpt-6.1-sol");
  const text = spawnableAgentsText([refused]);
  assert.doesNotMatch(text, /named as modelId: [^\n]*opus \(/);
  assert.match(
    text,
    /other listed models that resolve now, named as modelId: sol \(openai-codex\/gpt-6\.1-sol/,
  );
});

test("a picked runtime that is a listed model at its effort runs as listed, pin included", async () => {
  models = [
    { ...model("claude-sdk", "opus"), pinnedId: "claude-opus-5-5" },
    model("openai-codex", "gpt-6.1-sol"),
  ];
  write(
    "test-reviewer",
    reviewer({
      model: undefined,
      models: ["sol", "claude-opus-5-5"],
      effort: "high",
    }),
  );
  const { agent: listed } = await resolveAgentOnRuntime(
    "test-reviewer",
    { provider: "claude-sdk", modelId: "opus", thinkingLevel: "high" },
    "acct-claude-sdk",
  );
  assert.equal(listed.runtimeSource, "definition");
  assert.equal(listed.pinnedModel, "claude-opus-5-5");
  // Another effort is the user's own pick: no pin, and the role is the same.
  const { agent: picked } = await resolveAgentOnRuntime(
    "test-reviewer",
    { provider: "claude-sdk", modelId: "opus", thinkingLevel: "low" },
    "acct-claude-sdk",
  );
  assert.equal(picked.runtimeSource, "user");
  assert.equal(picked.pinnedModel, undefined);
  assert.deepEqual(picked.denyTools, listed.denyTools);
  assert.equal(picked.body, listed.body);
  offered = false;
  await assert.rejects(
    resolveAgentOnRuntime(
      "test-reviewer",
      { provider: "claude-sdk", modelId: "opus", thinkingLevel: "high" },
      "acct-claude-sdk",
    ),
    /the account picked for it \(Account acct-claude-sdk\) does not offer claude-sdk\/opus/,
  );
});

test("a model that stopped resolving refuses; nothing falls back", async () => {
  write("test-reviewer", reviewer());
  models = [model("openai-codex", "gpt-6.1-sol")];
  await assert.rejects(
    resolveAgentSpawn("test-reviewer"),
    (error: Error) =>
      error instanceof AgentSpawnRefusedError &&
      /Agent "test-reviewer" cannot run on its default model "opus": No enabled account offers a model "opus".* None of its listed models resolve now\./.test(
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
    accountFor: ({ model: { provider } }) => ({
      profileId: `acct-${provider}`,
    }),
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

test("a name no definition could declare is refused without being quoted", async () => {
  const name = `bad name ${"x".repeat(5000)}`;
  await assert.rejects(resolveAgentSpawn(name), (error: Error) => {
    assert.ok(error instanceof AgentSpawnRefusedError);
    assert.match(error.message, /not a valid agent name/);
    assert.ok(error.message.length < 200);
    return true;
  });
});

test("tools.deny names are bounded, and a refusal quotes only a few of them", async () => {
  write(
    "long-deny",
    reviewer({ name: "long-deny", denyTools: [`t${"x".repeat(64)}`] }),
  );
  const unknown = Array.from({ length: 20 }, (_, at) => `missing_tool_${at}`);
  write("many-deny", reviewer({ name: "many-deny", denyTools: unknown }));

  await assert.rejects(
    resolveAgentSpawn("long-deny"),
    /names of at most 64 characters/,
  );
  await assert.rejects(resolveAgentSpawn("many-deny"), (error: Error) => {
    assert.match(error.message, /missing_tool_4 and 15 more/);
    assert.doesNotMatch(error.message, /missing_tool_19/);
    return true;
  });
});
