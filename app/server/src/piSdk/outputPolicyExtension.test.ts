import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { createPiOutputPolicyExtension } from "./outputPolicyExtension.ts";
import { buildAgentOptions } from "./piEngineStart.ts";
import { deleteToolGroupSessionData } from "../mcp/toolGroups/registry.ts";
import { listSessionArtifacts } from "../mcp/toolGroups/packRuntime.ts";
import { SESSION_HOOK_METHODS } from "../workerProtocol/sessionHookMethods.ts";
import { persistSessionOutput } from "../workers/inProcessWorker.ts";
import { sessionHookCallsServedForTests } from "../workers/sessionHookHost.ts";

type Handler = (event: never, ctx: never) => Promise<unknown>;

/** The extension's handlers, persisting through the session's Worker. */
async function extensionHandlers(): Promise<Map<string, Handler>> {
  const handlers = new Map<string, Handler>();
  const factory = createPiOutputPolicyExtension({
    persistOutput: persistSessionOutput,
  });
  await factory({
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  } as never);
  return handlers;
}

test("pi output policy is loaded even for personas that disable discovered extensions", async () => {
  for (const agentType of ["assistant", "developer"] as const) {
    const options = await buildAgentOptions(agentType, process.cwd());
    const loaded = options.resourceLoader.getExtensions();
    assert.ok(
      loaded.extensions.some((extension) =>
        extension.path.includes("inline:bounded-output"),
      ),
      `${agentType} loads the hidden bounded-output extension`,
    );
    assert.deepEqual(loaded.errors, []);
  }
});

test("pi inline extension annotates bounded Read without duplicate persistence", async () => {
  const sessionId = `pi-output-policy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const handlers = await extensionHandlers();

  const context = {
    cwd: "/tmp",
    sessionManager: { getSessionId: () => sessionId },
  } as never;
  const call: {
    toolName: string;
    toolCallId: string;
    input: { path: string; limit?: number };
  } = {
    toolName: "read",
    toolCallId: "read-1",
    input: { path: "events.jsonl" },
  };
  await handlers.get("tool_call")!(call as never, context);
  assert.equal(call.input.limit, 120);

  try {
    const readText = `${"event one\n".repeat(120).trimEnd()}\n\n[500 more lines in file. Use offset=121 to continue.]`;
    const result = await handlers.get("tool_result")!(
      {
        toolName: "read",
        toolCallId: "read-1",
        input: call.input,
        content: [{ type: "text", text: readText }],
        details: undefined,
        isError: false,
      } as never,
      context,
    );
    const content = (
      result as { content: Array<{ type: string; text?: string }> }
    ).content[0]?.text;
    assert.match(content ?? "", /Bounded default window/);
    assert.match(content ?? "", /next offset=121/);
    assert.doesNotMatch(content ?? "", /Full raw output:/);
    assert.deepEqual(
      listSessionArtifacts(sessionId),
      [],
      "navigation-only reads do not register duplicate window artifacts",
    );
  } finally {
    deleteToolGroupSessionData(sessionId);
  }
});

test("pi persists an elided bash result through the server, once", async () => {
  const sessionId = `pi-output-artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const handlers = await extensionHandlers();
  const context = {
    cwd: "/tmp",
    sessionManager: { getSessionId: () => sessionId },
  } as never;
  const raw = Array.from(
    { length: 2_000 },
    (_, line) => `build line ${line}`,
  ).join("\n");
  const served = sessionHookCallsServedForTests(
    SESSION_HOOK_METHODS.persistOutput,
  );
  try {
    const result = await handlers.get("tool_result")!(
      {
        toolName: "bash",
        toolCallId: "bash-1",
        input: { command: "make" },
        content: [{ type: "text", text: raw }],
        details: undefined,
        isError: false,
      } as never,
      context,
    );
    const text = (result as { content: Array<{ text?: string }> }).content[0]
      ?.text;
    assert.match(text ?? "", /Full raw output:/);
    assert.equal(
      sessionHookCallsServedForTests(SESSION_HOOK_METHODS.persistOutput),
      served + 1,
    );
    const artifacts = listSessionArtifacts(sessionId);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.sourceTool, "bash");
    const path = /Full raw output: (\S+\.log)/.exec(text ?? "")?.[1];
    assert.ok(path, "the notice names the artifact file");
    assert.equal(await readFile(path, "utf8"), raw);
  } finally {
    deleteToolGroupSessionData(sessionId);
  }
});
