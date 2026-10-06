import assert from "node:assert/strict";
import { test } from "vitest";
import { createPiOutputPolicyExtension } from "./outputPolicyExtension.ts";
import { buildAgentOptions } from "./options.ts";
import { deleteToolGroupSessionData } from "../mcp/toolGroups/registry.ts";
import { listSessionArtifacts } from "../mcp/toolGroups/packRuntime.ts";

test("pi output policy is loaded even for personas that disable discovered extensions", async () => {
  for (const agentType of ["assistant", "developer"] as const) {
    const options = await buildAgentOptions(
      agentType,
      process.cwd(),
      "cp_test",
    );
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
  const handlers = new Map<
    string,
    (event: never, ctx: never) => Promise<unknown>
  >();
  const factory = createPiOutputPolicyExtension();
  await factory({
    on(name: string, handler: (event: never, ctx: never) => Promise<unknown>) {
      handlers.set(name, handler);
    },
  } as never);

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
