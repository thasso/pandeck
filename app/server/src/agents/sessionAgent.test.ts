/**
 * The frozen per-session agent definition (`docs/agent-definitions.md` "What a
 * spawn freezes"): insert-only, fail-closed on an unreadable row, and applied
 * the same way on both harnesses.
 *
 * Run with:
 *   pnpm --filter @assistant/server test src/agents/sessionAgent.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
  sessionAgent,
  sessionAgentSummary,
  SessionAgentUnreadableError,
  withoutDeniedTools,
} = await import("./sessionAgent.ts");
const { buildClaudeSdkQueryOptions, claudeSdkSystemPrompt } =
  await import("../claudeSdk/options.ts");
const { buildAgentOptions } = await import("../piSdk/options.ts");
const { CLAUDE_SDK_MODELS } = await import("../claudeSdk/modelSettings.ts");
const { ClaudeSdkSession } = await import("../claudeSdk/ClaudeSdkSession.ts");
const { createClaudeSessionToolServer } =
  await import("../claudeSdk/toolServer.ts");

const reviewer = {
  name: "test-reviewer",
  blob: "0".repeat(40),
  persona: "developer" as const,
  provider: "claude-sdk",
  model: "opus",
  effort: "high" as const,
  runtimeSource: "definition" as const,
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

test("a row stored before runtimes had a source ran its definition's own", () => {
  const { runtimeSource: _source, ...older } = reviewer;
  sessionStore.freezeAgent("older-row", JSON.stringify(older));
  assert.equal(sessionAgent("older-row")?.runtimeSource, "definition");
  const summary = sessionAgentSummary("older-row");
  assert.equal(
    summary && !summary.unreadable && summary.runtimeSource,
    "definition",
  );
  // A source this build does not know fails closed like any unreadable row.
  sessionStore.freezeAgent(
    "unknown-source",
    JSON.stringify({ ...reviewer, runtimeSource: "someone" }),
  );
  assert.throws(
    () => sessionAgent("unknown-source"),
    SessionAgentUnreadableError,
  );
});

test("an approved runtime is frozen and shown with its source", () => {
  const approved = {
    ...reviewer,
    provider: "openai-codex",
    model: "gpt-6.1-sol",
    runtimeSource: "approval" as const,
  };
  assert.deepEqual(freezeSessionAgent("approved-row", approved), approved);
  assert.deepEqual(sessionAgentSummary("approved-row"), {
    name: "test-reviewer",
    blob: reviewer.blob,
    model: "openai-codex/gpt-6.1-sol",
    effort: "high",
    runtimeSource: "approval",
    denyTools: reviewer.denyTools,
    skills: [],
  });
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
  assert.deepEqual(developer.excludeTools, [
    "ask_question",
    "worktree_push",
    "bash",
    "powershell",
    "monitor",
    "write",
  ]);
  const names = developer.agentTools.map((tool) => tool.name);
  assert.ok(!names.includes("worktree_push"));
  assert.ok(names.includes("worktree_commit"));

  const assistantAgent = {
    ...reviewer,
    persona: "assistant" as const,
    denyTools: ["task_manage"],
  };
  const assistant = await buildAgentOptions(
    "assistant",
    tmp,
    "default",
    undefined,
    [],
    assistantAgent,
  );
  assert.ok(
    assistant.resourceLoader
      .getSystemPrompt()
      ?.endsWith(agentPromptLayer(assistantAgent)),
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

test("Claude: a pinned agent runs its version even after the alias moves", () => {
  const pinned = { ...reviewer, pinnedModel: "claude-opus-5-5" };
  freezeSessionAgent("claude-pinned", pinned);
  assert.deepEqual(sessionAgent("claude-pinned"), pinned);
  const query = (modelId: string) =>
    buildClaudeSdkQueryOptions({
      cwd: tmp,
      abortController: new AbortController(),
      modelId,
      thinkingLevel: "high",
      agentType: "developer",
      agent: pinned,
    }).model;
  const opus = CLAUDE_SDK_MODELS.find((entry) => entry.id === "opus")!;
  const original = opus.sdkModelId;
  opus.sdkModelId = "claude-opus-future";
  try {
    assert.equal(query("opus"), "claude-opus-5-5");
    // A model the user switched the session to runs as usual.
    assert.equal(
      query("sonnet"),
      CLAUDE_SDK_MODELS.find((entry) => entry.id === "sonnet")!.sdkModelId,
    );
    // An unpinned agent follows its alias.
    assert.equal(
      buildClaudeSdkQueryOptions({
        cwd: tmp,
        abortController: new AbortController(),
        modelId: "opus",
        thinkingLevel: "high",
        agentType: "developer",
        agent: reviewer,
      }).model,
      "claude-opus-future",
    );
  } finally {
    opus.sdkModelId = original;
  }
});

test("Claude: a retained process switched back to the agent's alias runs the pin", async () => {
  freezeSessionAgent("claude-retained", {
    ...reviewer,
    pinnedModel: "claude-opus-5-5",
  });
  const switches = async (id: string) => {
    const session = new ClaudeSdkSession(id, {
      seam: async () => ({
        query() {
          throw new Error("no query in this test");
        },
      }),
      modelId: "opus",
      agentType: "developer",
    });
    const calls: string[] = [];
    // A process kept alive for background work takes model switches as
    // controls rather than as a new query.
    Object.assign(session, {
      activeQuery: {
        async setModel(model: string) {
          calls.push(model);
        },
      },
      retainedEpochKey: "retained",
      queryEpochKey: "retained",
    });
    await session.setModel("sonnet");
    await session.setModel("opus");
    return calls;
  };
  const opus = CLAUDE_SDK_MODELS.find((entry) => entry.id === "opus")!;
  const sonnet = CLAUDE_SDK_MODELS.find((entry) => entry.id === "sonnet")!;
  const original = opus.sdkModelId;
  opus.sdkModelId = "claude-opus-future";
  try {
    assert.deepEqual(await switches("claude-retained"), [
      sonnet.sdkModelId,
      "claude-opus-5-5",
    ]);
    // A session not spawned from a pinned definition follows the alias.
    assert.deepEqual(await switches("claude-retained-plain"), [
      sonnet.sdkModelId,
      "claude-opus-future",
    ]);
  } finally {
    opus.sdkModelId = original;
  }
});
