/**
 * Tests for the direct AgentTool → pi ToolDefinition adapter
 * (`agentToolAdapter.ts`): execute mapping (params/ctx/session), progress →
 * onUpdate, details/terminate passthrough, thrown-error contract, schema
 * passthrough vs TypeBox conversion for ref-bearing schemas, and description
 * parity with the MCP path that serves the Claude harness.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  defineAgentTool,
  type AgentTool,
  type ToolSession,
} from "../mcp/tool.ts";
import { createSessionToolServer } from "../mcp/sessionToolServer.ts";
import { agentToolsFor } from "../tools/catalog.ts";
import {
  jsonSchemaToTypeBox,
  toPiToolDefinitions,
} from "./agentToolAdapter.ts";

const SESSION: ToolSession = {
  sessionId: "sess-adapter",
  harness: "pi",
  agentType: "assistant",
};

test("adapts execute end-to-end: ctx, progress, details, terminate", async () => {
  const seen: Array<{ toolCallId: string; sessionId: string }> = [];
  const tool = defineAgentTool<{ value?: string }>({
    name: "probe",
    label: "Probe",
    description: "test tool",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      additionalProperties: false,
    },
    async execute(params, ctx) {
      seen.push({
        toolCallId: ctx.toolCallId,
        sessionId: ctx.session.sessionId,
      });
      ctx.progress?.({
        content: [{ type: "text", text: "working" }],
        details: { status: "half" },
      });
      return {
        content: [{ type: "text", text: `ok:${params.value ?? ""}` }],
        details: { echoed: params.value },
        terminate: true,
      };
    },
  });

  const [def] = toPiToolDefinitions([tool], { session: () => SESSION });
  assert.equal(def!.name, "probe");
  assert.equal(def!.label, "Probe");
  // Task-282: an AgentTool has no prompt extras, so the pi definition carries
  // none either and pi's Guidelines/Available-tools lists stay constant.
  assert.equal(def!.promptSnippet, undefined);
  assert.equal(def!.promptGuidelines, undefined);
  // Plain self-contained JSON Schema passes through byte-identical.
  assert.deepEqual(def!.parameters, tool.parameters);

  const updates: unknown[] = [];
  const result = await def!.execute(
    "call-1",
    { value: "hi" },
    undefined as never,
    (partial) => updates.push(partial),
    undefined as never,
  );
  assert.deepEqual(seen, [{ toolCallId: "call-1", sessionId: "sess-adapter" }]);
  assert.deepEqual(result.content, [{ type: "text", text: "ok:hi" }]);
  assert.deepEqual(result.details, { echoed: "hi" });
  assert.equal((result as { terminate?: boolean }).terminate, true);
  assert.deepEqual(updates, [
    {
      content: [{ type: "text", text: "working" }],
      details: { status: "half" },
    },
  ]);
});

test("thrown tool errors propagate as thrown errors (pi failure contract)", async () => {
  const tool: AgentTool = defineAgentTool({
    name: "boom",
    label: "Boom",
    description: "always throws",
    parameters: { type: "object", properties: {} },
    async execute() {
      throw new Error("kapow");
    },
  });
  const [def] = toPiToolDefinitions([tool], { session: () => SESSION });
  await assert.rejects(
    () =>
      def!.execute(
        "call-2",
        {},
        undefined as never,
        undefined as never,
        undefined as never,
      ),
    /kapow/,
  );
});

test("a policy-denied stale tool call fails legibly before execute", async () => {
  let executed = false;
  const tool = defineAgentTool({
    name: "mutating_probe",
    label: "Mutating probe",
    description: "must not execute",
    sideEffects: "local",
    parameters: { type: "object", properties: {} },
    async execute() {
      executed = true;
      return { content: [{ type: "text", text: "unexpected" }] };
    },
  });
  const [def] = toPiToolDefinitions([tool], {
    session: () => SESSION,
    unavailableReason: () =>
      "Tool mutating_probe is not available in Plan mode because it can make changes.",
  });
  await assert.rejects(
    () =>
      def!.execute(
        "blocked-call",
        {},
        undefined as never,
        undefined as never,
        undefined as never,
      ),
    /not available in Plan mode because it can make changes/,
  );
  assert.equal(executed, false);
});

test("session identity is read fresh per call", async () => {
  const sessions: string[] = [];
  let title: string | undefined;
  const tool: AgentTool = defineAgentTool({
    name: "identity",
    label: "Identity",
    description: "records the session title",
    parameters: { type: "object", properties: {} },
    async execute(_params, ctx) {
      sessions.push(ctx.session.title ?? "<none>");
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const [def] = toPiToolDefinitions([tool], {
    session: () => ({
      ...SESSION,
      ...(title !== undefined ? { title } : {}),
    }),
  });
  await def!.execute(
    "c1",
    {},
    undefined as never,
    undefined as never,
    undefined as never,
  );
  title = "Named later";
  await def!.execute(
    "c2",
    {},
    undefined as never,
    undefined as never,
    undefined as never,
  );
  assert.deepEqual(sessions, ["<none>", "Named later"]);
});

test("ref-bearing schemas are converted (defs inlined), plain schemas pass through", () => {
  const withRefs = {
    type: "object",
    properties: { item: { $ref: "#/$defs/Item" } },
    required: ["item"],
    $defs: {
      Item: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  };
  const tool: AgentTool = defineAgentTool({
    name: "refy",
    label: "Refy",
    description: "ref-bearing schema",
    parameters: withRefs,
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const [def] = toPiToolDefinitions([tool], { session: () => SESSION });
  const params = def!.parameters as { properties?: Record<string, unknown> };
  const item = params.properties?.["item"] as
    { type?: string; properties?: Record<string, unknown> } | undefined;
  assert.equal(item?.type, "object", "the $ref was inlined");
  assert.ok(item?.properties?.["id"], "the referenced shape survived");
});

// pi turns any `constrainedSampling` into provider `strict: true` based on MODEL
// capability alone; our schemas use optional properties, which OpenAI's strict
// subset rejects outright (whole request fails, not just the one tool).
test("no tool requests constrained sampling", () => {
  const native: AgentTool = defineAgentTool({
    name: "native",
    label: "Native",
    description: "self-contained schema",
    parameters: {
      type: "object",
      properties: { q: { type: "string" } },
      additionalProperties: false,
    },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const optionalProps: AgentTool = defineAgentTool({
    name: "optional_props",
    label: "Optional props",
    description: "optional property, strict-incompatible",
    parameters: {
      type: "object",
      properties: { timeZone: { type: "string" } },
      additionalProperties: false,
    },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const proxied: AgentTool = defineAgentTool({
    name: "proxied",
    label: "Proxied",
    description: "ref-bearing schema",
    parameters: {
      type: "object",
      properties: { item: { $ref: "#/$defs/Item" } },
      $defs: {
        Item: { type: "object", properties: { id: { type: "string" } } },
      },
    },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  for (const def of toPiToolDefinitions([native, optionalProps, proxied], {
    session: () => SESSION,
  })) {
    assert.equal(
      def.constrainedSampling,
      undefined,
      `${def.name} stays on normal function calling`,
    );
  }
});

/**
 * Every rule now lives in `description`/`parameters`, so both harnesses must
 * receive them verbatim: the pi definition here and the MCP listing that serves
 * the Claude harness. Near-by-construction — both read the same AgentTool
 * fields — and this pins it, because the deleted `promptGuidelines` were
 * exactly the surface Claude sessions never saw (Task-282).
 */
test("pi and MCP list the same descriptions for every tool", async () => {
  const tools = agentToolsFor("assistant");
  const piDescriptions = new Map(
    toPiToolDefinitions(tools, { session: () => SESSION }).map((def) => [
      def.name,
      def.description,
    ]),
  );

  const toolServer = createSessionToolServer({
    sessionId: SESSION.sessionId,
    harness: "claude-sdk",
    listMode: "active",
    tools: () => tools,
    session: () => ({ ...SESSION, harness: "claude-sdk" }),
  });
  const client = new Client(
    { name: "adapter-parity-test", version: "0.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    toolServer.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const listed = (await client.listTools()) as {
      tools: Array<{ name: string; description?: string }>;
    };
    const mcpDescriptions = new Map(
      listed.tools.map((tool) => [tool.name, tool.description]),
    );
    assert.deepEqual(
      [...mcpDescriptions.keys()].sort(),
      [...piDescriptions.keys()].sort(),
    );
    for (const [name, description] of piDescriptions) {
      assert.equal(
        mcpDescriptions.get(name),
        description,
        `${name}: pi and Claude sessions must receive the same rules`,
      );
      assert.ok(description, `${name}: description must not be empty`);
    }
  } finally {
    await client.close();
    await toolServer.close();
  }
});

test("jsonSchemaToTypeBox converts unions, enums, and arrays", () => {
  const converted = jsonSchemaToTypeBox({
    type: "object",
    properties: {
      kind: { enum: ["a", "b"] },
      values: { type: "array", items: { type: "integer", minimum: 0 } },
      either: { oneOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["kind"],
  }) as { properties?: Record<string, unknown>; required?: string[] };
  assert.ok(converted.properties?.["kind"]);
  assert.ok(converted.properties?.["values"]);
  assert.ok(converted.properties?.["either"]);
  assert.deepEqual(converted.required, ["kind"]);
});
