/**
 * Tests for the generic per-session MCP tool server.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/mcp/sessionToolServer.test.ts
 *
 * Part 1 drives a synthetic toolset over an in-memory transport pair with a
 * real MCP `Client` and proves the wire contract: list metadata (`pa/pi`
 * extras), toolCallId via `_meta`, progress notifications carrying
 * JSON-encoded partial results, details → `_meta` (never structuredContent),
 * terminate → `_meta`, active-set enforcement, and error mapping. It also
 * covers a proxied tool whose whole answer is text ([Task-439](pa://task/439)).
 *
 * Part 2 is the claude-sdk integration path (successor of the old
 * claudeSdkBridge test): builds the session tool server for a fake `claude-sdk`
 * session and proves the persona toolset lists with external `mcp__pa__*`
 * names, and that `task_manage` creates a Task linking back to the session
 * with harness "claude-sdk".
 *
 * Part 3 is the Claude counterpart of pi's cache-prefix guard
 * (`piSdk/toolActivation.test.ts`, Task-289): the whole first-request surface —
 * our system prompt plus the `tools/list` payload the CLI caches — must be
 * byte-identical across a deferred activation, which on this harness is the
 * CLI's own ToolSearch and never touches our state.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DATA_DIR } from "../config.ts";
import { AGENT_TYPES } from "../agentTypes.ts";
import type { AgentType } from "@assistant/shared";
import {
  integrationGatedActiveToolNames,
  eagerToolNamesFor,
  toolGroupsFor,
} from "../tools/catalog.ts";
import { maximalPromptConditions } from "../promptConditions.ts";
import { claudeSdkStore } from "../claudeSdk/claudeSdkStore.ts";
import { removeClaudeSdkRecord } from "../claudeSdk/claudeSdkRecords.ts";
import { claudeSdkSystemPrompt } from "../claudeSdk/options.ts";
import { createClaudeSessionToolServer } from "../claudeSdk/toolServer.ts";
import { deleteTask, listSessionTasks, readTask } from "../tasks.ts";
import {
  deleteToolGroupSessionData,
  toolsForToolGroup,
} from "./toolGroups/registry.ts";
import {
  closeProxiedConnection,
  setProxiedClientFactoryForTests,
} from "./toolGroups/proxiedServer.ts";
import { externalToolName } from "./names.ts";
import { mcpToolNamesFor } from "./agentToolNames.ts";
import {
  createSessionToolServer,
  type SessionToolServer,
} from "./sessionToolServer.ts";
import { defineAgentTool, type AgentTool } from "./tool.ts";

interface ToolListResult {
  tools: Array<{
    name: string;
    title?: string;
    _meta?: Record<string, unknown>;
  }>;
}
interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

async function connect(server: SessionToolServer): Promise<Client> {
  const client = new Client(
    { name: "tool-server-test", version: "0.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

test("session tool server wire contract", async () => {
  const seenCtx: Record<string, unknown>[] = [];
  const tools: AgentTool[] = [
    defineAgentTool<{ value?: string }>({
      name: "probe",
      label: "Probe",
      description: "test tool",
      searchHint: "probing diagnostics",
      executionMode: "sequential",
      parameters: { type: "object", properties: { value: { type: "string" } } },
      async execute(params, ctx) {
        seenCtx.push({
          toolCallId: ctx.toolCallId,
          sessionId: ctx.session.sessionId,
          harness: ctx.session.harness,
        });
        ctx.progress?.({
          content: [{ type: "text", text: "working" }],
          details: { status: "half" },
        });
        ctx.progress?.({
          content: [{ type: "text", text: "almost" }],
          details: { status: "nearly" },
        });
        return {
          content: [{ type: "text", text: `ok:${params.value ?? ""}` }],
          details: { echoed: params.value ?? null },
          terminate: true,
        };
      },
    }),
    defineAgentTool({
      name: "inactive_probe",
      label: "Inactive",
      description: "not enabled",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [{ type: "text", text: "should never run" }] };
      },
    }),
    defineAgentTool({
      name: "list_details",
      label: "List details",
      description: "returns array details",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [{ type: "text", text: "[]" }], details: [1, 2, 3] };
      },
    }),
    defineAgentTool({
      name: "boom",
      label: "Boom",
      description: "always throws",
      parameters: { type: "object", properties: {} },
      async execute() {
        throw new Error("kapow");
      },
    }),
  ];
  const active = new Set(["probe", "list_details", "boom"]);
  const server = createSessionToolServer({
    sessionId: "sess-1",
    harness: "pi",
    tools: () => tools,
    activeToolNames: () => active,
    eagerToolNames: () => new Set(["probe"]),
    session: () => ({
      sessionId: "sess-1",
      harness: "pi",
      agentType: "workshop",
    }),
  });
  const client = await connect(server);
  try {
    // tools/list: only the active tools are listed, extras ride _meta.
    const listed = (await client.listTools()) as ToolListResult;
    assert.deepEqual(listed.tools.map((t) => t.name).sort(), [
      "boom",
      "list_details",
      "probe",
    ]);
    const probe = listed.tools.find((t) => t.name === "probe")!;
    assert.equal(probe.title, "Probe");
    // pa/pi carries executionMode only: Task-282 deleted the prompt extras
    // that used to ride here (and that the Claude CLI ignored anyway).
    assert.deepEqual(probe._meta?.["pa/pi"], {
      executionMode: "sequential",
    });

    // Claude tool-search metadata: eager tools are marked alwaysLoad, search
    // hints ride anthropic/searchHint, deferred tools carry neither by default.
    assert.equal(probe._meta?.["anthropic/alwaysLoad"], true);
    assert.equal(probe._meta?.["anthropic/searchHint"], "probing diagnostics");
    const deferredListed = listed.tools.find((t) => t.name === "list_details")!;
    assert.equal(deferredListed._meta?.["anthropic/alwaysLoad"], undefined);
    assert.equal(deferredListed._meta?.["anthropic/searchHint"], undefined);

    // tools/call with _meta toolCallId + progress token: partials arrive as
    // progress notifications with the partial ToolResult JSON-encoded in message.
    const progressMessages: string[] = [];
    const result = (await client.callTool(
      {
        name: "probe",
        arguments: { value: "hi" },
        _meta: { "pa/toolCallId": "call-42" },
      },
      undefined,
      {
        onprogress: (p) => {
          if (typeof p.message === "string") progressMessages.push(p.message);
        },
      },
    )) as ToolCallResult;
    assert.equal(result.isError ?? false, false);
    assert.equal(result.content[0]?.text, "ok:hi");
    // Details ride _meta and never displace the text content (Task-439).
    assert.equal(result.structuredContent, undefined);
    assert.deepEqual(result._meta?.["pa/details"], { echoed: "hi" });
    assert.equal(result._meta?.["pa/terminate"], true);
    assert.equal(seenCtx[0]?.toolCallId, "call-42");
    assert.equal(seenCtx[0]?.sessionId, "sess-1");
    assert.equal(progressMessages.length, 2);
    assert.deepEqual(JSON.parse(progressMessages[0]!), {
      content: [{ type: "text", text: "working" }],
      details: { status: "half" },
    });

    // Non-object details ride the same key — no shape is special-cased.
    const arr = (await client.callTool({
      name: "list_details",
      arguments: {},
    })) as ToolCallResult;
    assert.equal(arr.structuredContent, undefined);
    assert.deepEqual(arr._meta?.["pa/details"], [1, 2, 3]);

    // Inactive tools are rejected even though listed in "all" mode.
    const denied = (await client.callTool({
      name: "inactive_probe",
      arguments: {},
    })) as ToolCallResult;
    assert.equal(denied.isError, true);
    assert.match(denied.content[0]?.text ?? "", /not enabled/);

    // Thrown errors map to isError results with the message as text.
    const boom = (await client.callTool({
      name: "boom",
      arguments: {},
    })) as ToolCallResult;
    assert.equal(boom.isError, true);
    assert.equal(boom.content[0]?.text, "kapow");
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

test("a proxied tool's text-only answer survives the wire", async () => {
  // Task-439: browser_snapshot's whole value is the accessibility tree in the
  // TEXT content — its details are the thin {mcpTool, artifacts} envelope. When
  // details rode structuredContent the Claude CLI kept only that envelope and
  // the agent saw nothing, so the guard is: text through, structuredContent
  // absent.
  const ID = `proxied-text-${Date.now()}`;
  const SNAPSHOT = '- generic [active] [ref=e1]:\n  - heading "T439" [level=1]';
  const pack = toolsForToolGroup("browser");
  const snapshotTool = pack.find((tool) => tool.name === "browser_snapshot");
  const consoleTool = pack.find((tool) => tool.name === "browser_console");
  assert.ok(snapshotTool, "browser pack is missing browser_snapshot");
  assert.ok(consoleTool, "browser pack is missing browser_console");
  setProxiedClientFactoryForTests(async () => ({
    pid: undefined,
    async callTool(name, args) {
      // The console tool answers with nothing at all: silently (the empty
      // case) or as a failure that carries no message (the error case).
      if (name === "browser_console_messages")
        return args.all ? { content: [], isError: true } : { content: [] };
      return { content: [{ type: "text", text: SNAPSHOT }] };
    },
    async close() {},
    onUnexpectedClose() {},
  }));
  const server = createSessionToolServer({
    sessionId: ID,
    harness: "claude-sdk",
    tools: () => [snapshotTool, consoleTool],
    session: () => ({
      sessionId: ID,
      harness: "claude-sdk",
      agentType: "workshop",
    }),
  });
  const client = await connect(server);
  try {
    const result = (await client.callTool({
      name: "browser_snapshot",
      arguments: {},
    })) as ToolCallResult;
    assert.equal(result.isError ?? false, false);
    assert.equal(result.content[0]?.text, SNAPSHOT);
    assert.equal(result.structuredContent, undefined);
    assert.deepEqual(result._meta?.["pa/details"], {
      mcpTool: "browser_snapshot",
      artifacts: [],
    });

    // A call that returns nothing says so under the name the agent called —
    // browser_console, not the upstream browser_console_messages it has no
    // tool for — so an empty page cannot read like a lost payload.
    const empty = (await client.callTool({
      name: "browser_console",
      arguments: {},
    })) as ToolCallResult;
    assert.equal(
      empty.content[0]?.text,
      "browser_console (upstream browser_console_messages) returned no content.",
    );

    // A messageless upstream FAILURE reads as a failure, not as an empty page.
    const failed = (await client.callTool({
      name: "browser_console",
      arguments: { all: true },
    })) as ToolCallResult;
    assert.equal(failed.isError, true);
    assert.equal(
      failed.content[0]?.text,
      "browser_console (upstream browser_console_messages) failed without an error message.",
    );
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await closeProxiedConnection(ID);
    setProxiedClientFactoryForTests(undefined);
    deleteToolGroupSessionData(ID);
  }
});

test("notifyToolsChanged is safe before the server is connected", async () => {
  const server = createSessionToolServer({
    sessionId: "unconnected",
    harness: "pi",
    tools: () => [],
    session: () => ({
      sessionId: "unconnected",
      harness: "pi",
      agentType: "workshop",
    }),
  });
  server.notifyToolsChanged();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await server.close().catch(() => {});
});

test("claude-sdk session tool server exposes persona tools and links tasks", async () => {
  const ID = `tool-server-test-${Date.now()}`;
  const cleanupRecord = () => {
    try {
      removeClaudeSdkRecord(join(DATA_DIR, "claude-sdk"), ID);
    } catch {
      // ignore
    }
  };
  cleanupRecord();

  const session = claudeSdkStore.acquire(ID, {
    modelId: "opus",
    thinkingLevel: "high",
  });
  assert.equal(session.harness, "claude-sdk");
  assert.equal(session.kind, "workshop");

  const createdTaskIds: string[] = [];
  const server = createClaudeSessionToolServer(session);
  const client = await connect(server);
  try {
    const listed = (await client.listTools()) as ToolListResult;
    const externalNames = listed.tools
      .map((t) => externalToolName(t.name))
      .sort();
    // Every catalog tool the persona's integration gates allow is active, so
    // listed — browser tool groups are ordinary ungated/gated catalog groups
    // now, no separate per-session enable step.
    const workshopTools = AGENT_TYPES.workshop.tools();
    const expected = [
      ...integrationGatedActiveToolNames(
        "workshop",
        workshopTools,
        new Set(workshopTools.map((tool) => tool.name)),
      ),
    ]
      .map(externalToolName)
      .sort();
    assert.ok(
      expected.length >= 8,
      `expected at least 8 tools, got ${expected.length}`,
    );
    assert.deepEqual(
      externalNames,
      expected,
      "external mcp__pa__ names match the persona's active toolset",
    );
    assert.ok(
      externalNames.includes("mcp__pa__task_manage"),
      "task_manage is exposed",
    );
    assert.ok(
      externalNames.includes("mcp__pa__task_read"),
      "task_read is exposed",
    );
    assert.ok(
      !externalNames.includes("mcp__pa__commit_changes"),
      "commits stay host-driven through /commit",
    );
    assert.ok(
      externalNames.includes("mcp__pa__browser_navigate"),
      "browser tool group tools are always usable (no approval step)",
    );
    assert.ok(
      mcpToolNamesFor("workshop").includes("mcp__pa__browser_navigate"),
      "browser tool group stays in the allowlist names",
    );
    assert.ok(
      !externalNames.includes("mcp__pa__browser_mcp_call"),
      "raw-mcp stays gated off by default",
    );

    // Task-286 loading tiers as the Claude CLI sees them: memory stays
    // always-loaded, the KB reads are ToolSearch-discovered and carry the
    // searchHint their discovery ranks on.
    const metaOf = (name: string) =>
      listed.tools.find((t) => t.name === name)?._meta ?? {};
    for (const eager of ["memory_search", "memory_manage"])
      assert.equal(
        metaOf(eager)["anthropic/alwaysLoad"],
        true,
        `${eager} must stay always-loaded for the Claude harness`,
      );
    for (const deferred of ["kb_search", "kb_get_entry"]) {
      assert.equal(
        metaOf(deferred)["anthropic/alwaysLoad"],
        undefined,
        `${deferred} must be ToolSearch-discovered, not always-loaded`,
      );
      assert.match(
        String(metaOf(deferred)["anthropic/searchHint"] ?? ""),
        /knowledge base/i,
        `${deferred} needs a searchHint naming the Knowledge Base`,
      );
    }
    const collidingFamilies = new Set([
      "sessions",
      "project-registry",
      "contacts",
      "context7",
      "knowledge-core",
      "knowledge",
    ]);
    for (const group of toolGroupsFor("workshop").filter((candidate) =>
      collidingFamilies.has(candidate.id),
    ))
      for (const tool of group.tools)
        assert.ok(
          String(metaOf(tool.name)["anthropic/searchHint"] ?? "").length > 10,
          `${tool.name} needs discriminating Claude ToolSearch metadata`,
        );

    const read = (await client.callTool({
      name: "task_read",
      arguments: {},
    })) as ToolCallResult;
    assert.ok(
      !read.isError,
      `task_read should not error: ${JSON.stringify(read.content)}`,
    );

    const title = `tool server probe ${ID}`;
    const create = (await client.callTool({
      name: "task_manage",
      arguments: {
        operations: [
          { operation: "create", title, description: "Task context." },
        ],
      },
    })) as ToolCallResult;
    assert.ok(
      !create.isError,
      `task_manage create should not error: ${JSON.stringify(create.content)}`,
    );

    const linked = listSessionTasks("workshop", ID);
    const probe = linked.find((t) => t.title === title);
    assert.ok(probe, "created task is linked to the claude-sdk session");
    createdTaskIds.push(probe.id);
    const detail = readTask(probe.id);
    assert.ok(
      (detail?.sessionRefs ?? []).some(
        (ref) =>
          ref.harness === "claude-sdk" &&
          ref.agentType === "workshop" &&
          ref.sessionId === ID,
      ),
      "detail sessionRef harness is claude-sdk",
    );
    assert.deepEqual(
      probe.sessionRefs,
      [{ sessionId: ID }],
      "list session refs stay lean",
    );
    assert.equal(probe.source?.createdBy, "agent", "source.createdBy is agent");

    session.setMode("plan");
    const planListed = (await client.listTools()) as ToolListResult;
    const planNames = new Set(planListed.tools.map((tool) => tool.name));
    assert.ok(planNames.has("task_read"), "Plan keeps read-only app tools");
    assert.ok(
      planNames.has("task_manage"),
      "Plan permits durable Task mutations",
    );
    assert.ok(
      !planNames.has("browser_navigate"),
      "Plan does not list side-effecting browser tools",
    );
    const denied = (await client.callTool({
      name: "browser_navigate",
      arguments: {},
    })) as ToolCallResult;
    assert.equal(denied.isError, true);
    assert.match(
      denied.content[0]?.text ?? "",
      /not available in Plan mode because it can make changes/,
    );
    const planTitle = `plan task probe ${ID}`;
    const planCreate = (await client.callTool({
      name: "task_manage",
      arguments: { operations: [{ operation: "create", title: planTitle }] },
    })) as ToolCallResult;
    assert.ok(
      !planCreate.isError,
      `Plan task creation should not error: ${JSON.stringify(planCreate.content)}`,
    );
    const planProbe = listSessionTasks("workshop", ID).find(
      (task) => task.title === planTitle,
    );
    assert.ok(planProbe, "Plan-created task is linked to the session");
    createdTaskIds.push(planProbe.id);

    const implementationPlan =
      "## Implementation plan\n\n- Verify Plan-mode Task mutations.";
    const planUpdate = (await client.callTool({
      name: "task_manage",
      arguments: {
        operations: [
          {
            operation: "update",
            id: probe.id,
            descriptionEdits: [
              { oldText: "Task context.", newText: implementationPlan },
            ],
          },
        ],
      },
    })) as ToolCallResult;
    assert.ok(
      !planUpdate.isError,
      `Plan task update should not error: ${JSON.stringify(planUpdate.content)}`,
    );
    assert.equal(
      readTask(probe.id)?.description,
      implementationPlan,
      "Plan writes an implementation plan into an existing Task description",
    );

    session.setMode("build");
    const restored = (await client.listTools()) as ToolListResult;
    assert.deepEqual(
      restored.tools.map((tool) => externalToolName(tool.name)).sort(),
      externalNames,
      "switching back to Build restores the unchanged exposure",
    );
  } finally {
    for (const id of createdTaskIds) {
      try {
        deleteTask(id);
      } catch {
        // ignore
      }
    }
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    claudeSdkStore.remove(ID);
    deleteToolGroupSessionData(ID);
    cleanupRecord();
  }
});

test("a deferred activation leaves the Claude first-request surface byte-identical", async () => {
  // pi rebuilds its whole system prompt on activation, so its guard drives pi's
  // real buildSystemPrompt (piSdk/toolActivation.test.ts). Claude's deferred
  // activation is the CLI's ToolSearch reading THIS listing, so the surface to
  // pin is the pair the provider caches: our system prompt and the tools/list
  // payload. Both must be pure functions of the session-start conditions —
  // anything dynamic in a description, schema or listing order (a path, a
  // timestamp, a Set iteration) would move the prefix mid-conversation.
  for (const agentType of Object.keys(AGENT_TYPES) as AgentType[]) {
    const conditions = maximalPromptConditions(agentType);
    const tools = AGENT_TYPES[agentType].tools();
    const eager = eagerToolNamesFor(agentType, conditions);
    const active = integrationGatedActiveToolNames(
      agentType,
      tools,
      new Set(tools.map((tool) => tool.name)),
    );
    const listOnce = async () => {
      const server = createSessionToolServer({
        sessionId: `prefix-${agentType}`,
        harness: "claude-sdk",
        tools: () => tools,
        activeToolNames: () => active,
        eagerToolNames: () => eager,
        session: () => ({
          sessionId: `prefix-${agentType}`,
          harness: "claude-sdk",
          agentType,
        }),
      });
      const client = await connect(server);
      try {
        return JSON.stringify(await client.listTools());
      } finally {
        await client.close().catch(() => {});
        await server.close().catch(() => {});
      }
    };

    // Two independent builds stand in for before/after a ToolSearch load: the
    // CLI resolves a deferred tool out of the payload it already holds and
    // reports it back as load state, which no listing input reads.
    assert.equal(
      await listOnce(),
      await listOnce(),
      `${agentType}: the tools/list payload moved — the Claude cache prefix is not stable`,
    );
    assert.equal(
      JSON.stringify(claudeSdkSystemPrompt(agentType, "", { conditions })),
      JSON.stringify(claudeSdkSystemPrompt(agentType, "", { conditions })),
      `${agentType}: the system prompt moved under identical session-start conditions`,
    );
  }
});
