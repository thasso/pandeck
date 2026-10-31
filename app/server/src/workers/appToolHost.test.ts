/**
 * App tools across the worker protocol (`docs/workers.md`): an engine's call
 * leaves from the in-process Worker as `appTools.call`, the server resolves
 * the session's binding and runs the tool, partials come back as
 * `appTools.progress`, and the caller's abort is the protocol's `cancel`.
 * Everything runs over the real codec; the placement refusal uses a second,
 * real Worker admitted under another id.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { startWorker } from "../worker/worker.ts";
import {
  defineAgentTool,
  type AgentTool,
  type ToolResult,
} from "../mcp/tool.ts";
import { WorkerRequestError } from "../workerProtocol/connection.ts";
import { createInProcessTransport } from "../workerProtocol/inProcessTransport.ts";
import {
  appToolCallsServedForTests,
  appToolHandlers,
  registerAppToolSession,
  type AppToolBinding,
} from "./appToolHost.ts";
import {
  appToolExecutorFor,
  inProcessWorkerServedMethodForTests,
} from "./inProcessWorker.ts";
import { WorkerRegistry } from "./workerRegistry.ts";

const LONE = "a\uD800b";

function bindingOf(
  sessionId: string,
  tools: AgentTool[],
  onExecute?: (name: string) => void,
): AppToolBinding {
  return {
    resolve: (name) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return tool;
    },
    session: () => ({ sessionId, harness: "pi", agentType: "developer" }),
    ...(onExecute ? { onExecute } : {}),
  };
}

const text = (value: string): ToolResult => ({
  content: [{ type: "text", text: value }],
});

test("a call runs the bound tool with the engine's id, args and the session's identity", async () => {
  const sessionId = "app-tools-call";
  const events: string[] = [];
  const seen: unknown[] = [];
  const tool = defineAgentTool({
    name: "probe",
    label: "Probe",
    description: "echoes",
    parameters: { type: "object" },
    async execute(params, ctx) {
      events.push("execute");
      seen.push({
        params,
        toolCallId: ctx.toolCallId,
        session: ctx.session.sessionId,
        progress: ctx.progress === undefined ? "none" : "some",
      });
      return {
        content: [{ type: "text", text: `ok ${LONE}` }],
        details: { echoed: params, nested: [LONE] },
        terminate: true,
      };
    },
  });
  const dispose = registerAppToolSession(
    sessionId,
    bindingOf(sessionId, [tool], (name) => events.push(`onExecute:${name}`)),
  );
  try {
    const before = appToolCallsServedForTests();
    const result = await appToolExecutorFor(sessionId)(
      "probe",
      { value: LONE, list: [1, { deep: LONE }] },
      { toolCallId: "call-1" },
    );
    assert.deepEqual(result, {
      content: [{ type: "text", text: `ok ${LONE}` }],
      details: {
        echoed: { value: LONE, list: [1, { deep: LONE }] },
        nested: [LONE],
      },
      terminate: true,
    });
    assert.deepEqual(seen, [
      {
        params: { value: LONE, list: [1, { deep: LONE }] },
        toolCallId: "call-1",
        session: sessionId,
        progress: "none",
      },
    ]);
    assert.deepEqual(events, ["onExecute:probe", "execute"]);
    assert.equal(appToolCallsServedForTests(), before + 1);
  } finally {
    dispose();
  }
});

test("progress partials reach the engine in order, before the result", async () => {
  const sessionId = "app-tools-progress";
  const tool = defineAgentTool({
    name: "stream",
    label: "Stream",
    description: "streams",
    parameters: { type: "object" },
    async execute(_params, ctx) {
      ctx.progress?.(text("one"));
      ctx.progress?.({ ...text(`two ${LONE}`), details: { at: 2 } });
      await new Promise((resolve) => setTimeout(resolve, 5));
      ctx.progress?.(text("three"));
      return text("done");
    },
  });
  const dispose = registerAppToolSession(
    sessionId,
    bindingOf(sessionId, [tool]),
  );
  try {
    const before = inProcessWorkerServedMethodForTests("appTools.progress");
    const partials: unknown[] = [];
    const result = await appToolExecutorFor(sessionId)(
      "stream",
      {},
      { toolCallId: "call-p", progress: (partial) => partials.push(partial) },
    );
    // Recorded synchronously by the time the call settles.
    assert.deepEqual(partials, [
      text("one"),
      { ...text(`two ${LONE}`), details: { at: 2 } },
      text("three"),
    ]);
    assert.deepEqual(result, text("done"));
    assert.equal(
      inProcessWorkerServedMethodForTests("appTools.progress"),
      before + 3,
    );
  } finally {
    dispose();
  }
});

test("aborting the engine's signal aborts the tool's, and the tool's outcome settles the call", async () => {
  const sessionId = "app-tools-cancel";
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const tool = defineAgentTool({
    name: "waits",
    label: "Waits",
    description: "waits for its signal",
    parameters: { type: "object" },
    async execute(_params, ctx) {
      started();
      await new Promise<void>((resolve) =>
        ctx.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new Error("probe aborted");
    },
  });
  const dispose = registerAppToolSession(
    sessionId,
    bindingOf(sessionId, [tool]),
  );
  try {
    const controller = new AbortController();
    const call = appToolExecutorFor(sessionId)(
      "waits",
      {},
      { toolCallId: "call-c", signal: controller.signal },
    );
    await running;
    controller.abort();
    await assert.rejects(call, (err: Error) => err.message === "probe aborted");
  } finally {
    dispose();
  }
});

test("a tool's failure and a binding's refusal keep their exact message", async () => {
  const sessionId = "app-tools-errors";
  const tool = defineAgentTool({
    name: "boom",
    label: "Boom",
    description: "throws",
    parameters: { type: "object" },
    async execute() {
      throw new Error(`kapow ${LONE}`);
    },
  });
  const dispose = registerAppToolSession(
    sessionId,
    bindingOf(sessionId, [tool]),
  );
  try {
    const run = appToolExecutorFor(sessionId);
    await assert.rejects(
      run("boom", {}, { toolCallId: "e1" }),
      (err: Error) => err.message === `kapow ${LONE}`,
    );
    await assert.rejects(
      run("missing", {}, { toolCallId: "e2" }),
      (err: Error) => err.message === "Unknown tool: missing",
    );
  } finally {
    dispose();
  }
});

test("a result over a frame's cap arrives whole", async () => {
  const sessionId = "app-tools-large";
  const big = `${LONE}${"x".repeat(1024 * 1024 + 17)}${LONE}`;
  const tool = defineAgentTool({
    name: "big",
    label: "Big",
    description: "large",
    parameters: { type: "object" },
    async execute() {
      return text(big);
    },
  });
  const dispose = registerAppToolSession(
    sessionId,
    bindingOf(sessionId, [tool]),
  );
  try {
    const result = await appToolExecutorFor(sessionId)(
      "big",
      {},
      { toolCallId: "big" },
    );
    assert.equal(
      result.content[0]?.type === "text" && result.content[0].text,
      big,
    );
  } finally {
    dispose();
  }
});

test("the newest binding serves; a disposer removes only its own", async () => {
  const sessionId = "app-tools-bindings";
  const named = (answer: string): AgentTool =>
    defineAgentTool({
      name: "who",
      label: "Who",
      description: "names its binding",
      parameters: { type: "object" },
      async execute() {
        return text(answer);
      },
    });
  const run = () =>
    appToolExecutorFor(sessionId)("who", {}, { toolCallId: "w" });
  await assert.rejects(
    run(),
    (err: Error) =>
      err instanceof WorkerRequestError &&
      err.code === "no_tool_session" &&
      err.message === `Session ${sessionId} has no live tool session.`,
  );
  const disposeHolder = registerAppToolSession(
    sessionId,
    bindingOf(sessionId, [named("holder")]),
  );
  const disposeRefused = registerAppToolSession(
    sessionId,
    bindingOf(sessionId, [named("refused")]),
  );
  assert.deepEqual(await run(), text("refused"));
  // An engine built for an id another holds, then discarded.
  disposeRefused();
  assert.deepEqual(await run(), text("holder"));
  disposeRefused();
  assert.deepEqual(await run(), text("holder"));
  disposeHolder();
  await assert.rejects(run(), /has no live tool session/);
});

test("a Worker the session is not placed on is refused before any lookup", async () => {
  const sessionId = "app-tools-elsewhere";
  let resolved = 0;
  let executed = 0;
  const dispose = registerAppToolSession(sessionId, {
    resolve: () => {
      resolved += 1;
      return defineAgentTool({
        name: "probe",
        label: "Probe",
        description: "must not run",
        parameters: { type: "object" },
        async execute() {
          executed += 1;
          return text("ran");
        },
      });
    },
    session: () => ({ sessionId, harness: "pi", agentType: "developer" }),
  });
  const registry = new WorkerRegistry();
  const [serverEnd, workerEnd] = createInProcessTransport();
  const connection = registry.accept(serverEnd, {
    quiescence: () => Promise.resolve(),
    handlers: appToolHandlers(() => {
      const workerId = registry.admittedAs(connection);
      return workerId === undefined ? undefined : { connection, workerId };
    }),
  });
  // A real Worker, admitted as one no session is placed on.
  const worker = startWorker({ workerId: "elsewhere", transport: workerEnd });
  try {
    const before = appToolCallsServedForTests();
    await assert.rejects(
      worker.callAppTool(
        { sessionId, tool: "probe", toolCallId: "x", args: {} },
        {},
      ),
      (err: Error) =>
        err instanceof WorkerRequestError &&
        err.code === "not_placed" &&
        err.message === `Session ${sessionId} is not placed on this Worker.`,
    );
    assert.equal(registry.admittedAs(connection), "elsewhere");
    assert.equal(resolved, 0);
    assert.equal(executed, 0);
    assert.equal(appToolCallsServedForTests(), before);
  } finally {
    connection.end("test done");
    dispose();
  }
});
