/**
 * Standalone test for the headless one-shot Claude SDK runner.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/claudeSdk/oneShot.test.ts
 *
 * Drives a single no-tool run through a FAKE seam and asserts:
 *   1. Assistant text blocks are concatenated into `text` (thinking is ignored).
 *   2. Usage is mapped from the `result` message.
 *   3. The query options carry the custom system prompt, no tools, and no
 *      inherited setting sources.
 *   4. A non-success result with no text throws.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentTool } from "../mcp/tool.ts";
import type {
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
} from "./sdkSeam.ts";
import { CLAUDE_SDK_HARNESS_SETTINGS } from "./modelSettings.ts";
import { runClaudeSdkOneShot, setClaudeSdkOneShotSeam } from "./oneShot.ts";

function fakeSeam(
  messages: ClaudeSdkMessage[],
  onParams?: (p: ClaudeQueryParams) => void,
): ClaudeSdkSeam {
  return {
    query(params: ClaudeQueryParams) {
      onParams?.(params);
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m;
        },
      };
    },
  };
}

function successScript(): ClaudeSdkMessage[] {
  return [
    {
      type: "assistant",
      uuid: "a1",
      session_id: "s1",
      message: {
        id: "m1",
        model: "claude-sonnet-4-6",
        content: [
          { type: "thinking", thinking: "thinking should be ignored" },
          { type: "text", text: "Refined " },
          { type: "text", text: "prompt." },
        ],
        usage: {
          input_tokens: 50,
          output_tokens: 3,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 0,
        },
      },
    } as unknown as ClaudeSdkMessage,
    {
      type: "result",
      subtype: "success",
      session_id: "s1",
      usage: {
        input_tokens: 50,
        output_tokens: 3,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 0,
      },
      total_cost_usd: 0.001,
    } as unknown as ClaudeSdkMessage,
  ];
}

async function main(): Promise<void> {
  // 1 + 2 + 3: success path, options carry our constraints.
  let captured: ClaudeQueryParams | undefined;
  setClaudeSdkOneShotSeam(() =>
    Promise.resolve(fakeSeam(successScript(), (p) => (captured = p))),
  );
  const out = await runClaudeSdkOneShot({
    modelId: "sonnet",
    thinkingLevel: "off",
    systemPrompt: "SYS PROMPT",
    prompt: "Refine this",
  });
  assert.equal(
    out.text,
    "Refined prompt.",
    "concatenates assistant text, ignores thinking",
  );
  assert.equal(out.usage.inputTokens, 50, "maps input tokens from result");
  assert.equal(out.usage.outputTokens, 3, "maps output tokens from result");
  const opts = captured?.options as Record<string, unknown> | undefined;
  assert.ok(opts, "query received options");
  assert.equal(
    opts!.systemPrompt,
    "SYS PROMPT",
    "custom system prompt passed through",
  );
  assert.deepEqual(opts!.allowedTools, [], "no tools allowed");
  assert.deepEqual(opts!.settingSources, [], "no inherited setting sources");
  assert.deepEqual(
    opts!.settings,
    CLAUDE_SDK_HARNESS_SETTINGS,
    "one-shot runs carry the harness settings layer: native auto-memory off (our in-app Memory is authoritative) and PA-owned transcript retention",
  );
  assert.equal(opts!.maxTurns, 1, "single turn");
  assert.equal(
    captured?.prompt,
    "Refine this",
    "prompt passed as plain string",
  );

  // Explicit app tools mount over MCP while native Claude tools stay disabled.
  const readTool = {
    name: "research_read",
    label: "Research",
    description: "Read context",
    parameters: { type: "object", properties: {} },
    execute: async () => ({
      content: [{ type: "text" as const, text: "context" }],
    }),
  } satisfies AgentTool;
  const toolCapture: { current?: ClaudeQueryParams } = {};
  setClaudeSdkOneShotSeam(() =>
    Promise.resolve(
      fakeSeam(successScript(), (p) => {
        toolCapture.current = p;
      }),
    ),
  );
  await runClaudeSdkOneShot({
    modelId: "sonnet",
    thinkingLevel: "off",
    systemPrompt: "SYS",
    prompt: "Research",
    tools: [readTool],
    maxTurns: 6,
  });
  const toolOpts = toolCapture.current?.options as
    Record<string, unknown> | undefined;
  assert.ok(toolOpts?.mcpServers, "app-tool MCP server mounted");
  assert.deepEqual(toolOpts?.tools, [], "native tools remain disabled");
  assert.equal(toolOpts?.maxTurns, 6, "tool loop is explicitly bounded");
  assert.equal(
    typeof toolOpts?.canUseTool,
    "function",
    "MCP namespace permission is explicit",
  );

  // documents: the prompt becomes a streaming user turn carrying a document block.
  const docCapture: { current?: ClaudeQueryParams } = {};
  setClaudeSdkOneShotSeam(() =>
    Promise.resolve(
      fakeSeam(successScript(), (p) => {
        docCapture.current = p;
      }),
    ),
  );
  await runClaudeSdkOneShot({
    modelId: "sonnet",
    thinkingLevel: "off",
    systemPrompt: "SYS",
    prompt: "Transcribe",
    documents: [{ mimeType: "application/pdf", dataBase64: "QkFTRTY0" }],
  });
  const docPrompt = docCapture.current?.prompt;
  assert.notEqual(
    typeof docPrompt,
    "string",
    "documents switch the prompt to a streaming iterable",
  );
  const streamed: Array<Record<string, any>> = [];
  for await (const m of docPrompt as AsyncIterable<Record<string, any>>)
    streamed.push(m);
  assert.equal(streamed.length, 1, "one user message is streamed");
  assert.equal(streamed[0]!.type, "user");
  const content = streamed[0]!.message.content;
  assert.equal(content[0].type, "document", "first block is the document");
  assert.equal(content[0].source.media_type, "application/pdf");
  assert.equal(content[0].source.data, "QkFTRTY0");
  assert.equal(content[1].type, "text", "text prompt follows the document");
  assert.equal(content[1].text, "Transcribe");

  // 4: a non-success result is reported, not thrown.
  setClaudeSdkOneShotSeam(() =>
    Promise.resolve(
      fakeSeam([
        {
          type: "result",
          subtype: "error_during_execution",
          session_id: "s2",
        } as unknown as ClaudeSdkMessage,
      ]),
    ),
  );
  const failed = await runClaudeSdkOneShot({
    modelId: "sonnet",
    thinkingLevel: "off",
    systemPrompt: "x",
    prompt: "y",
  });
  assert.equal(failed.text, "");
  assert.match(
    failed.failure ?? "",
    /error_during_execution/,
    "non-success result is reported as a failure",
  );

  console.log("Claude SDK one-shot test: PASS");
}

test("runs Claude SDK one-shot prompts through a fake seam", async () => {
  await main();
});

test("an API failure is reported as the failure, never as model text", async () => {
  const run = (messages: ClaudeSdkMessage[]) => {
    setClaudeSdkOneShotSeam(() => Promise.resolve(fakeSeam(messages)));
    return runClaudeSdkOneShot({
      modelId: "sonnet",
      thinkingLevel: "off",
      systemPrompt: "x",
      prompt: "y",
    });
  };

  // The CLI's synthetic assistant message carries the provider's wording.
  const spendLimit = await run([
    {
      type: "assistant",
      uuid: "a1",
      session_id: "s1",
      error: "billing_error",
      message: {
        id: "m1",
        model: "<synthetic>",
        content: [
          { type: "text", text: "You've hit your org's monthly spend limit" },
        ],
      },
    } as unknown as ClaudeSdkMessage,
    {
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 402,
      session_id: "s1",
      result: "You've hit your org's monthly spend limit",
    } as unknown as ClaudeSdkMessage,
  ]);
  assert.equal(spendLimit.text, "");
  assert.equal(spendLimit.failure, "You've hit your org's monthly spend limit");

  // A result-only API failure still fails, named by its status.
  const rateLimited = await run([
    {
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      session_id: "s2",
    } as unknown as ClaudeSdkMessage,
  ]);
  assert.equal(rateLimited.text, "");
  assert.equal(rateLimited.failure, "Claude SDK run ended with: HTTP 429");
});
