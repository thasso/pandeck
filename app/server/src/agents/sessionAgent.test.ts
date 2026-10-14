/**
 * The frozen per-session agent definition (`docs/agent-definitions.md` "What a
 * spawn freezes"): insert-only, fail-closed on an unreadable row, and applied
 * the same way on both harnesses.
 *
 * Run with:
 *   pnpm --filter @assistant/server test src/agents/sessionAgent.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "session-agent-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { sessionStore } = await import("../db/sessionStore.ts");
const {
  agentPromptLayer,
  freezeSessionAgent,
  gitBlobId,
  sessionAgent,
  sessionAgentSummary,
  SessionAgentUnreadableError,
  withoutDeniedTools,
} = await import("./sessionAgent.ts");
const { buildClaudeSdkQueryOptions, claudeSdkSystemPrompt } =
  await import("../claudeSdk/options.ts");
const { buildAgentOptions } = await import("../piSdk/options.ts");
const { createClaudeSessionToolServer } =
  await import("../claudeSdk/toolServer.ts");

const reviewer = {
  name: "test-reviewer",
  blob: "0".repeat(40),
  persona: "developer" as const,
  provider: "claude-sdk",
  model: "opus",
  effort: "high" as const,
  denyTools: ["worktree_push", "bash", "write"],
  skills: [],
  body: "Prove every new test fails without the change.",
};

test("the first freeze wins for the session's life", () => {
  assert.equal(sessionAgent("fresh"), undefined);
  assert.deepEqual(freezeSessionAgent("frozen", reviewer), reviewer);
  const later = { ...reviewer, name: "other", body: "Something else." };
  assert.deepEqual(freezeSessionAgent("frozen", later), reviewer);
  assert.deepEqual(sessionAgent("frozen"), reviewer);
});

test("an unreadable row refuses to run rather than run without the agent", () => {
  sessionStore.freezeAgent("corrupt", '{"name":"x"}');
  assert.throws(() => sessionAgent("corrupt"), SessionAgentUnreadableError);
  assert.deepEqual(sessionAgentSummary("corrupt"), {
    name: "unreadable",
    unreadable: true,
  });
  assert.equal(sessionAgentSummary("never-spawned"), undefined);
});

test("the blob id is git's own, so a row names its exact AGENT.md", () => {
  const source = "---\nname: x\n---\nBody — with ünïcode\n";
  const file = join(tmp, "AGENT.md");
  writeFileSync(file, source);
  assert.equal(
    gitBlobId(source),
    execFileSync("git", ["hash-object", file], { encoding: "utf8" }).trim(),
  );
});

test("denied app tools leave the toolset; native names never match app tools", () => {
  const tools = [
    { name: "worktree_push" },
    { name: "worktree_commit" },
    { name: "bash" },
  ];
  assert.deepEqual(
    withoutDeniedTools(tools, reviewer).map((tool) => tool.name),
    ["worktree_commit", "bash"],
  );
  assert.equal(withoutDeniedTools(tools, undefined), tools);
});

test("Claude: the body is the last prompt layer and denied natives leave tools", () => {
  const options = buildClaudeSdkQueryOptions({
    cwd: tmp,
    abortController: new AbortController(),
    modelId: "opus",
    thinkingLevel: "high",
    agentType: "developer",
    agent: reviewer,
  });
  const prompt = options.systemPrompt as { append: string };
  const tools = options.tools as string[];
  assert.ok(prompt.append.endsWith(agentPromptLayer(reviewer)));
  for (const name of ["Bash", "Monitor", "Write"]) {
    assert.ok(!tools.includes(name), `${name} is not a tool`);
    assert.ok(options.disallowedTools?.includes(name), `${name} is disallowed`);
  }
  for (const name of ["Read", "Edit", "Grep"])
    assert.ok(tools.includes(name), `${name} stays`);
  // The assistant persona's own prompt carries the layer the same way.
  assert.ok(
    (
      claudeSdkSystemPrompt("assistant", undefined, undefined, {
        ...reviewer,
        persona: "assistant",
      }) as string
    ).endsWith(agentPromptLayer(reviewer)),
  );
});

test("pi: the body is the last prompt layer and denied tools are excluded", async () => {
  const developer = await buildAgentOptions(
    "developer",
    tmp,
    "default",
    undefined,
    [],
    reviewer,
  );
  assert.equal(
    developer.resourceLoader.getAppendSystemPrompt().at(-1),
    agentPromptLayer(reviewer),
  );
  assert.deepEqual(developer.excludeTools, ["ask_question", "bash", "write"]);
  const names = developer.agentTools.map((tool) => tool.name);
  assert.ok(!names.includes("worktree_push"));
  assert.ok(names.includes("worktree_commit"));

  const assistant = await buildAgentOptions(
    "assistant",
    tmp,
    "default",
    undefined,
    [],
    { ...reviewer, persona: "assistant", denyTools: ["task_manage"] },
  );
  assert.ok(
    assistant.resourceLoader
      .getSystemPrompt()
      ?.endsWith(agentPromptLayer(reviewer)),
  );
  assert.ok(!assistant.agentTools.some((tool) => tool.name === "task_manage"));
});

test("Claude: a denied app tool is neither listed nor callable", async () => {
  freezeSessionAgent("claude-tools", reviewer);
  const server = createClaudeSessionToolServer({
    id: "claude-tools",
    agentType: "developer",
    sessionMode: "build",
    cwd: tmp,
    timelineEntries: () => [],
    broadcastState() {},
  });
  const client = new Client({ name: "agent-test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.server.connect(serverSide),
    client.connect(clientSide),
  ]);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("worktree_commit"));
    assert.ok(!names.includes("worktree_push"));
    const called = await client.callTool({
      name: "worktree_push",
      arguments: {},
    });
    assert.equal(called.isError, true);
    assert.match(JSON.stringify(called.content), /Unknown tool: worktree_push/);
  } finally {
    await client.close();
    await server.close();
  }
});
