/**
 * Tests for the AgentTool → pi ToolDefinition adapter (`agentToolAdapter.ts`):
 * execute mapping (params/ctx/session), progress → onUpdate,
 * details/terminate passthrough, thrown-error contract, schema passthrough vs
 * TypeBox conversion for ref-bearing schemas, and description parity with the
 * MCP path that serves the Claude harness. The routed cases run the same
 * contract through the in-process Worker and the server's binding
 * (`workers/appToolHost.ts`), where the Plan gate and `onExecute` apply.
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
  appToolCallsServedForTests,
  registerAppToolSession,
} from "../workers/appToolHost.ts";
import {
  appToolExecutorFor,
  inProcessWorkerServedMethodForTests,
} from "../workers/inProcessWorker.ts";
import {
  jsonSchemaToTypeBox,
  piAppToolBinding,
  toPiToolDefinitions,
  type PiAgentToolAdapterConfig,
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

/**
 * `tools` as an interactive pi session builds them: every one routed through
 * the in-process Worker, with `config`'s binding registered on the server.
 */
function routedDefinitions(
  sessionId: string,
  tools: AgentTool[],
  config: PiAgentToolAdapterConfig,
): { defs: ReturnType<typeof toPiToolDefinitions>; dispose: () => void } {
  return {
    defs: toPiToolDefinitions(tools, {
      ...config,
      appTools: {
        routes: new Set(tools),
        execute: appToolExecutorFor(sessionId),
      },
    }),
    dispose: registerAppToolSession(sessionId, piAppToolBinding(tools, config)),
  };
}

test("a routed app tool crosses the Worker with the same ctx, progress, details and terminate", async () => {
  const sessionId = "sess-adapter-routed";
  const seen: unknown[] = [];
  const used: string[] = [];
  const tool = defineAgentTool<{ value?: string }>({
    name: "probe",
    label: "Probe",
    description: "test tool",
    parameters: { type: "object", properties: { value: { type: "string" } } },
    async execute(params, ctx) {
      seen.push({ toolCallId: ctx.toolCallId, session: ctx.session.sessionId });
      ctx.progress?.({
        content: [{ type: "text", text: "working" }],
        details: { status: "half" },
      });
      ctx.progress?.({ content: [{ type: "text", text: "almost" }] });
      return {
        content: [{ type: "text", text: `ok:${params.value ?? ""}` }],
        details: { echoed: params.value },
        terminate: true,
      };
    },
  });
  const { defs, dispose } = routedDefinitions(sessionId, [tool], {
    session: () => ({ ...SESSION, sessionId }),
    onExecute: (name) => used.push(name),
  });
  try {
    const calls = appToolCallsServedForTests();
    const partials = inProcessWorkerServedMethodForTests("appTools.progress");
    const updates: unknown[] = [];
    const result = await defs[0]!.execute(
      "call-r1",
      { value: "hi" },
      undefined as never,
      (partial) => updates.push(partial),
      undefined as never,
    );
    assert.deepEqual(seen, [{ toolCallId: "call-r1", session: sessionId }]);
    assert.deepEqual(used, ["probe"]);
    assert.deepEqual(result.content, [{ type: "text", text: "ok:hi" }]);
    assert.deepEqual(result.details, { echoed: "hi" });
    assert.equal((result as { terminate?: boolean }).terminate, true);
    assert.deepEqual(updates, [
      {
        content: [{ type: "text", text: "working" }],
        details: { status: "half" },
      },
      { content: [{ type: "text", text: "almost" }], details: undefined },
    ]);
    assert.equal(appToolCallsServedForTests(), calls + 1);
    assert.equal(
      inProcessWorkerServedMethodForTests("appTools.progress"),
      partials + 2,
    );
  } finally {
    dispose();
  }
});

test("the server applies the Plan denial to a routed call before onExecute and execute", async () => {
  const sessionId = "sess-adapter-plan";
  let executed = 0;
  const used: string[] = [];
  let plan = true;
  const tool = defineAgentTool({
    name: "mutating_probe",
    label: "Mutating probe",
    description: "runs only in Build",
    sideEffects: "local",
    parameters: { type: "object", properties: {} },
    async execute() {
      executed += 1;
      return { content: [{ type: "text", text: "ran" }] };
    },
  });
  const { defs, dispose } = routedDefinitions(sessionId, [tool], {
    session: () => ({ ...SESSION, sessionId }),
    unavailableReason: (t) =>
      plan
        ? `Tool ${t.name} is not available in Plan mode because it can make changes.`
        : undefined,
    onExecute: (name) => used.push(name),
  });
  const run = () =>
    defs[0]!.execute(
      "plan-call",
      {},
      undefined as never,
      undefined as never,
      undefined as never,
    );
  try {
    const calls = appToolCallsServedForTests();
    await assert.rejects(
      run(),
      (err: Error) =>
        err.message ===
        "Tool mutating_probe is not available in Plan mode because it can make changes.",
    );
    assert.equal(executed, 0);
    assert.deepEqual(used, []);
    assert.equal(appToolCallsServedForTests(), calls);
    plan = false;
    await run();
    assert.equal(executed, 1);
    assert.deepEqual(used, ["mutating_probe"]);
  } finally {
    dispose();
  }
});

test("a routed tool's thrown message and pi's abort cross unchanged", async () => {
  const sessionId = "sess-adapter-errors";
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const tools = [
    defineAgentTool({
      name: "boom",
      label: "Boom",
      description: "always throws",
      parameters: { type: "object", properties: {} },
      async execute() {
        throw new Error("kapow \uD800");
      },
    }),
    defineAgentTool({
      name: "waits",
      label: "Waits",
      description: "waits for its signal",
      parameters: { type: "object", properties: {} },
      async execute(_params, ctx) {
        started();
        await new Promise<void>((resolve) =>
          ctx.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        throw new Error("probe aborted");
      },
    }),
  ];
  const { defs, dispose } = routedDefinitions(sessionId, tools, {
    session: () => ({ ...SESSION, sessionId }),
  });
  try {
    await assert.rejects(
      defs[0]!.execute(
        "e",
        {},
        undefined as never,
        undefined as never,
        undefined as never,
      ),
      (err: Error) => err.message === "kapow \uD800",
    );
    const controller = new AbortController();
    const call = defs[1]!.execute(
      "a",
      {},
      controller.signal,
      undefined as never,
      undefined as never,
    );
    await running;
    controller.abort();
    await assert.rejects(call, (err: Error) => err.message === "probe aborted");
  } finally {
    dispose();
  }
});

test("an engine-local tool executes in place, gated here, with no app-tool call", async () => {
  let executed = 0;
  const used: string[] = [];
  const routed = defineAgentTool({
    name: "routed",
    label: "Routed",
    description: "an app tool",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "routed" }] };
    },
  });
  const local = defineAgentTool({
    name: "find_tools",
    label: "Find tools",
    description: "engine-local",
    parameters: { type: "object", properties: {} },
    async execute(_params, ctx) {
      executed += 1;
      return { content: [{ type: "text", text: ctx.session.sessionId }] };
    },
  });
  let denied: string | undefined = "denied here";
  const defs = toPiToolDefinitions([routed, local], {
    session: () => SESSION,
    unavailableReason: () => denied,
    onExecute: (name) => used.push(name),
    appTools: {
      routes: new Set([routed]),
      execute: appToolExecutorFor("sess-adapter-local"),
    },
  });
  const calls = appToolCallsServedForTests();
  const runLocal = () =>
    defs[1]!.execute(
      "l",
      {},
      undefined as never,
      undefined as never,
      undefined as never,
    );
  await assert.rejects(runLocal(), /denied here/);
  denied = undefined;
  const result = await runLocal();
  assert.deepEqual(result.content, [{ type: "text", text: "sess-adapter" }]);
  assert.equal(executed, 1);
  assert.deepEqual(used, ["find_tools"]);
  assert.equal(appToolCallsServedForTests(), calls);
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
