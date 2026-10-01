/**
 * Standalone scripted-seam test for {@link ClaudeSdkSession}.
 *
 * Run through the server Vitest suite:
 *   `pnpm --filter @assistant/server test src/claudeSdk/ClaudeSdkSession.test.ts`.
 *
 * It drives a single turn through a FAKE seam that yields a scripted SDK message
 * sequence (message_start → thinking deltas → text deltas → tool_use assistant
 * message with full input → tool_result user message → result) and asserts:
 *   - the captured broadcast envelopes arrive in the right order, and
 *   - the normalized committed entries project to blocks [thinking, text, tool(done)]
 *     with the right text and no duplicated/empty text.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { UNLABELED_SESSION_TITLE, type ServerMessage } from "@assistant/shared";
import { ClaudeSdkSession } from "./ClaudeSdkSession.ts";
import { claudeSdkModelId } from "./modelSettings.ts";
import {
  claudeConfigDir,
  createCredentialProfile,
  deleteCredentialProfile,
} from "../credentialProfiles.ts";
import { setChildProcessEnvOverlay } from "../subprocessEnv.ts";
import type {
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
} from "./sdkSeam.ts";

const TOOL_ID = "toolu_abc";
const MSG_ID = "msg_123";

/** Scripted SDK message sequence for one turn. */
function scriptedMessages(): ClaudeSdkMessage[] {
  const stream = (event: unknown): ClaudeSdkMessage =>
    ({
      type: "stream_event",
      event,
      parent_tool_use_id: null,
      uuid: `evt-${Math.random()}`,
      session_id: "sess-1",
    }) as unknown as ClaudeSdkMessage;

  return [
    stream({ type: "message_start", message: { id: MSG_ID } }),
    // thinking block
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Let me " },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "think." },
    }),
    stream({ type: "content_block_stop", index: 0 }),
    // text block
    stream({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "Hello " },
    }),
    stream({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "world" },
    }),
    stream({ type: "content_block_stop", index: 1 }),
    // committed assistant message carrying the tool_use with full input
    {
      type: "assistant",
      uuid: "asst-1",
      session_id: "sess-1",
      message: {
        id: MSG_ID,
        model: "claude-sonnet-4-6",
        content: [
          { type: "thinking", thinking: "Let me think." },
          { type: "text", text: "Hello world" },
          {
            type: "tool_use",
            id: TOOL_ID,
            name: "Read",
            input: { file_path: "/x.txt" },
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 200,
        },
      },
    } as unknown as ClaudeSdkMessage,
    // tool_result user message
    {
      type: "user",
      uuid: "user-1",
      session_id: "sess-1",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: TOOL_ID,
            content: "file contents",
            is_error: false,
          },
        ],
      },
    } as unknown as ClaudeSdkMessage,
    // result
    {
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 200,
      },
      total_cost_usd: 0.0123,
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 100,
          outputTokens: 5,
          cacheReadInputTokens: 900,
          cacheCreationInputTokens: 200,
          costUSD: 0.0123,
          contextWindow: 1_000_000,
        },
      },
    } as unknown as ClaudeSdkMessage,
  ];
}

function fakeSeam(messages: ClaudeSdkMessage[]): ClaudeSdkSeam {
  return {
    query(_params: ClaudeQueryParams) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m;
        },
      };
    },
  };
}

async function main(): Promise<void> {
  const seam = fakeSeam(scriptedMessages());
  const session = new ClaudeSdkSession("test-session", {
    seam: () => Promise.resolve(seam),
  });

  const envelopes: ServerMessage[] = [];
  session.addViewer({ send: (m) => envelopes.push(m) });

  await session.createRuntimeAdapter().prompt("read x.txt");

  const types = envelopes.map((e) => e.type);

  // Order: userMessage → assistantStart → thinkingDelta(s) → textDelta(s)
  //        → toolStart → toolEnd → assistantEnd → state
  // (No post-turn `history` envelope: the runtime path covers turn completion
  // via durable entryAppended deltas; the engine no longer broadcasts history.)
  assert.equal(types[0], "userMessage", `first envelope: ${types[0]}`);
  assert.equal(types[1], "assistantStart", `second envelope: ${types[1]}`);

  const firstThinking = types.indexOf("thinkingDelta");
  const firstText = types.indexOf("textDelta");
  const toolStart = types.indexOf("toolStart");
  const toolEnd = types.indexOf("toolEnd");
  const assistantEnd = types.indexOf("assistantEnd");
  const state = types.lastIndexOf("state");

  assert.ok(firstThinking > 1, "thinkingDelta present after assistantStart");
  assert.ok(firstText > firstThinking, "textDelta after thinkingDelta");
  assert.ok(toolStart > firstText, "toolStart after textDelta");
  assert.ok(toolEnd > toolStart, "toolEnd after toolStart");
  assert.ok(assistantEnd > toolEnd, "assistantEnd after toolEnd");
  assert.ok(state > assistantEnd, "state after assistantEnd");

  // Deltas: thinking "Let me " + "think." ; text "Hello " + "world".
  const thinkingDeltas = envelopes
    .filter(
      (e): e is Extract<ServerMessage, { type: "thinkingDelta" }> =>
        e.type === "thinkingDelta",
    )
    .map((e) => e.delta);
  const textDeltas = envelopes
    .filter(
      (e): e is Extract<ServerMessage, { type: "textDelta" }> =>
        e.type === "textDelta",
    )
    .map((e) => e.delta);
  assert.deepEqual(
    thinkingDeltas,
    ["Let me ", "think."],
    `thinking deltas: ${JSON.stringify(thinkingDeltas)}`,
  );
  assert.deepEqual(
    textDeltas,
    ["Hello ", "world"],
    `text deltas: ${JSON.stringify(textDeltas)}`,
  );

  // toolStart carries the FULL args from the committed assistant message.
  const toolStartEnv = envelopes.find(
    (e): e is Extract<ServerMessage, { type: "toolStart" }> =>
      e.type === "toolStart",
  );
  assert.ok(toolStartEnv, "toolStart envelope present");
  assert.equal(toolStartEnv.name, "Read");
  assert.deepEqual(toolStartEnv.args, { file_path: "/x.txt" });

  // Final committed turn: [thinking, text, tool(done, output)] — no dup/empty text.
  const snapshot = session.snapshot();
  const lastAssistant = snapshot[snapshot.length - 1];
  assert.ok(lastAssistant, "snapshot non-empty");
  assert.equal(lastAssistant.role, "assistant");
  const blocks = lastAssistant.blocks;
  assert.equal(
    blocks.length,
    3,
    `expected 3 blocks, got ${blocks.length}: ${JSON.stringify(blocks.map((b) => b.kind))}`,
  );
  const [thinkingBlock, textBlock, toolBlock] = blocks;
  assert.ok(thinkingBlock && textBlock && toolBlock, "three blocks present");
  assert.equal(thinkingBlock.kind, "thinking");
  assert.equal(textBlock.kind, "text");
  assert.equal(toolBlock.kind, "tool");
  if (thinkingBlock.kind === "thinking")
    assert.equal(thinkingBlock.text, "Let me think.");
  if (textBlock.kind === "text") assert.equal(textBlock.text, "Hello world");
  if (toolBlock.kind === "tool") {
    assert.equal(toolBlock.toolId, TOOL_ID);
    assert.equal(toolBlock.name, "Read");
    assert.equal(toolBlock.done, true);
    assert.equal(toolBlock.isError, false);
    assert.equal(toolBlock.output, "file contents");
    assert.deepEqual(toolBlock.args, { file_path: "/x.txt" });
  }

  // No empty/duplicated text block.
  const textBlocks = blocks.filter((b) => b.kind === "text");
  assert.equal(textBlocks.length, 1, "exactly one text block");

  // The user message is committed first.
  assert.equal(snapshot[0]?.role, "user");

  // Context/usage reporting: cumulative tokens + cost from `result`, context
  // SIZE from the request input side (input + cache_read + cache_creation), and
  // the real provider context window (1M here) — not the hardcoded 200k.
  const ctx = session.contextInfo();
  assert.equal(ctx.cost, 0.0123, `cost: ${ctx.cost}`);
  assert.equal(
    ctx.tokenUsage.input,
    100,
    `cumulative input: ${ctx.tokenUsage.input}`,
  );
  assert.equal(
    ctx.tokenUsage.output,
    5,
    `cumulative output: ${ctx.tokenUsage.output}`,
  );
  assert.equal(
    ctx.tokenUsage.cacheRead,
    900,
    `cacheRead: ${ctx.tokenUsage.cacheRead}`,
  );
  assert.equal(
    ctx.tokenUsage.cacheWrite,
    200,
    `cacheWrite: ${ctx.tokenUsage.cacheWrite}`,
  );
  assert.equal(
    ctx.context?.contextWindow,
    1_000_000,
    `contextWindow: ${ctx.context?.contextWindow}`,
  );
  // context size = 100 + 900 + 200 = 1200 (NOT input+output).
  assert.equal(
    ctx.context?.tokens,
    1200,
    `context tokens: ${ctx.context?.tokens}`,
  );
  assert.ok(
    ctx.context?.percent != null && Math.abs(ctx.context.percent - 0.12) < 1e-9,
    `context percent: ${ctx.context?.percent}`,
  );

  // Persistence round-trip: the record carries normalized entries plus cumulative
  // usage so a reload can restore history/cost/context without replaying the
  // provider stream or a DisplayMessage[] snapshot.
  const record = session.toRecord();
  assert.deepEqual(
    record.entries.map((entry) =>
      entry.type === "command.result" ? entry.type : entry.role,
    ),
    ["user", "assistant", "toolResult"],
  );
  assert.equal(record.usage?.cost, 0.0123, "record usage.cost");
  assert.equal(record.usage?.contextTokens, 1200, "record usage.contextTokens");
  assert.equal(
    record.usage?.contextWindow,
    1_000_000,
    "record usage.contextWindow",
  );
  const rehydrated = new ClaudeSdkSession("test-session", {
    seam: () => Promise.resolve(seam),
    entries: record.entries,
    usage: record.usage,
  });
  assert.deepEqual(
    rehydrated.snapshot(),
    session.snapshot(),
    "normalized entries rehydrate the display snapshot",
  );

  console.log("ClaudeSdkSession scripted-seam test: PASS");
}

test("maps scripted Claude SDK turns", async () => {
  await main();
});

test("synthetic provider errors do not replace the selected model", async () => {
  let captured: ClaudeQueryParams | undefined;
  const seam: ClaudeSdkSeam = {
    query(params) {
      captured = params;
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            uuid: "synthetic-rate-limit",
            session_id: "sess-rate-limited",
            message: {
              id: "synthetic-message",
              role: "assistant",
              model: "<synthetic>",
              content: [
                { type: "text", text: "You've hit your session limit" },
              ],
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          } as unknown as ClaudeSdkMessage;
          throw new Error(
            "Claude Code returned an error result: You've hit your session limit",
          );
        },
      };
    },
  };
  const session = new ClaudeSdkSession("rate-limited-session", {
    seam: () => Promise.resolve(seam),
    modelId: "opus",
  });

  const result = await session.createRuntimeAdapter().prompt("continue");

  assert.equal(
    result.stopReason,
    "error",
    "the provider failure is still surfaced",
  );
  assert.equal(
    captured?.options?.model,
    // Resolved through the alias, not a literal: which generation `opus` points
    // at is `options.models.test.ts`'s assertion, not this test's subject.
    claudeSdkModelId("opus"),
    "the failed request was attempted with Opus",
  );
  assert.equal(
    session.toRecord().modelId,
    "opus",
    "the synthetic sentinel cannot persist a Sonnet switch",
  );
});

test("a rejected request ends the turn with the provider's own wording", async () => {
  // What the CLI really does on a 429: a synthetic assistant message carrying the
  // reason (never streamed, so the live-delta path cannot show it), then an
  // ordinary `result` whose `is_error` is the only structural sign of failure.
  const seam: ClaudeSdkSeam = {
    query(_params: ClaudeQueryParams) {
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            uuid: "synthetic-spend-limit",
            session_id: "sess-spend",
            error: "rate_limit",
            message: {
              id: "synthetic-message",
              role: "assistant",
              model: "<synthetic>",
              content: [
                {
                  type: "text",
                  text: "You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit",
                },
              ],
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          } as unknown as ClaudeSdkMessage;
          yield {
            type: "result",
            subtype: "success",
            session_id: "sess-spend",
            is_error: true,
            api_error_status: 429,
            result: "API Error: 429",
            total_cost_usd: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
            modelUsage: {},
          } as unknown as ClaudeSdkMessage;
        },
      };
    },
  };
  const session = new ClaudeSdkSession("spend-limited-session", {
    seam: () => Promise.resolve(seam),
  });
  const envelopes: ServerMessage[] = [];
  session.addViewer({ send: (m) => envelopes.push(m) });

  const result = await session.createRuntimeAdapter().prompt("continue");

  assert.equal(result.stopReason, "error", "the turn is reported as failed");
  const end = envelopes.find((e) => e.type === "assistantEnd");
  assert.ok(end && end.type === "assistantEnd", "an assistantEnd is broadcast");
  assert.match(
    end.error ?? "",
    /monthly spend limit/,
    `the provider's wording reaches the client (${end.error})`,
  );
  assert.equal(
    end.errorInfo?.kind,
    "quota",
    "a spend limit is classified as a quota failure",
  );
  assert.ok(
    Math.abs(session.contextInfo().cost) < 1e-9,
    "a rejected request bills nothing",
  );
});

test("a Claude session uses only its selected profile environment", async () => {
  const profile = createCredentialProfile({
    name: "Session account",
    provider: "claude",
  });
  const previous = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  process.env.ANTHROPIC_API_KEY = "ambient-api-key";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-oauth";
  process.env.CLAUDE_CONFIG_DIR = "/ambient/claude";
  let captured: ClaudeQueryParams | undefined;
  const seam: ClaudeSdkSeam = {
    query(params) {
      captured = params;
      return fakeSeam(scriptedMessages()).query(params);
    },
  };
  try {
    const session = new ClaudeSdkSession("profiled-claude-session", {
      seam: () => Promise.resolve(seam),
      credentialProfileId: profile.id,
    });
    await session.createRuntimeAdapter().prompt("hello");
    assert.equal(captured?.options?.env?.ANTHROPIC_API_KEY, undefined);
    assert.equal(captured?.options?.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(
      captured?.options?.env?.CLAUDE_CONFIG_DIR,
      claudeConfigDir(profile.id),
    );
  } finally {
    deleteCredentialProfile(profile.id);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a Claude session without a profile preserves the child environment", async () => {
  let captured: ClaudeQueryParams | undefined;
  const seam: ClaudeSdkSeam = {
    query(params) {
      captured = params;
      return fakeSeam(scriptedMessages()).query(params);
    },
  };
  const session = new ClaudeSdkSession("unprofiled-claude-session", {
    seam: () => Promise.resolve(seam),
  });
  await session.createRuntimeAdapter().prompt("hello");
  assert.equal(captured?.options?.env?.PATH, process.env.PATH);
  assert.equal(captured?.options?.env?.HOME, process.env.HOME);
  assert.notEqual(captured?.options?.env?.TMPDIR, undefined);
  assert.notEqual(captured?.options?.env?.CLAUDE_CODE_TMPDIR, undefined);
});

test("the Claude CLI gets the package-proxy overlay the server does not hold", async () => {
  const profile = createCredentialProfile({
    name: "Proxied account",
    provider: "claude",
  });
  setChildProcessEnvOverlay({ HTTPS_PROXY: "http://127.0.0.1:9/overlay" });
  try {
    for (const credentialProfileId of [undefined, profile.id]) {
      let captured: ClaudeQueryParams | undefined;
      const seam: ClaudeSdkSeam = {
        query(params) {
          captured = params;
          return fakeSeam(scriptedMessages()).query(params);
        },
      };
      const session = new ClaudeSdkSession(
        `proxied-claude-session-${credentialProfileId ?? "default"}`,
        {
          seam: () => Promise.resolve(seam),
          ...(credentialProfileId ? { credentialProfileId } : {}),
        },
      );
      await session.createRuntimeAdapter().prompt("hello");
      assert.equal(
        captured?.options?.env?.HTTPS_PROXY,
        "http://127.0.0.1:9/overlay",
        `profile ${credentialProfileId ?? "none"}`,
      );
      assert.notEqual(process.env.HTTPS_PROXY, "http://127.0.0.1:9/overlay");
    }
  } finally {
    setChildProcessEnvOverlay(null);
    deleteCredentialProfile(profile.id);
  }
});

test("a restored session keeps its last-activity timestamp", async () => {
  const seam = fakeSeam(scriptedMessages());
  const createdAt = 1_700_000_000_000;
  const updatedAt = createdAt + 90 * 60 * 1000;

  // Restoring from a record must carry updatedAt over: falling back to createdAt
  // back-dates the session on every restart (list ordering, unread check, and
  // the session_index/session_usage_totals rows written from the record).
  const restored = new ClaudeSdkSession("test-session-restored", {
    seam: () => Promise.resolve(seam),
    createdAt,
    updatedAt,
  });
  assert.equal(
    restored.toRecord().updatedAt,
    updatedAt,
    "restored updatedAt survives",
  );
  assert.equal(
    restored.toRecord().createdAt,
    createdAt,
    "restored createdAt survives",
  );

  // A genuinely new session (no persisted activity) still starts at createdAt.
  const fresh = new ClaudeSdkSession("test-session-fresh", {
    seam: () => Promise.resolve(seam),
    createdAt,
  });
  assert.equal(
    fresh.toRecord().updatedAt,
    createdAt,
    "a new session starts at createdAt",
  );
});

test("prompt acceptance persists and announces a Claude session before its first turn ends", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seam: ClaudeSdkSeam = {
    query() {
      return {
        async *[Symbol.asyncIterator]() {
          await held;
          for (const message of [] as ClaudeSdkMessage[]) yield message;
        },
      };
    },
  };
  const session = new ClaudeSdkSession("test-session-first-turn-list", {
    seam: () => Promise.resolve(seam),
  });
  const persisted: ReturnType<ClaudeSdkSession["toRecord"]>[] = [];
  let changes = 0;
  session.onPersist = () => persisted.push(session.toRecord());
  session.onChange = () => {
    changes += 1;
  };

  const running = session.createRuntimeAdapter().prompt("review the changes");
  const namingItem = session.listItem(0);
  assert.equal(
    namingItem.title,
    UNLABELED_SESSION_TITLE,
    "the provider default never becomes the first-prompt title",
  );
  assert.equal(
    namingItem.titleGenerationPending,
    true,
    "the list states that the naming agent is still working",
  );
  assert.equal(persisted[0]?.entries.length, 1, "the user entry is durable");
  assert.equal(changes, 1, "the list is invalidated at prompt acceptance");
  await Promise.resolve();

  const item = session.listItem(0);
  assert.ok(item.messageCount > 0, "the first turn is immediately listable");
  assert.equal(
    item.isStreaming,
    true,
    "the listed first turn is still running",
  );

  release();
  await running;
});

/**
 * Drive `scales.length` turns on separate `query()` epochs (an ordinary turn
 * closes its process), where each epoch's `result` reports `0.0123 * scale` and
 * matching tokens. A resumed epoch "starts fresh", so each report is that run
 * alone. The retained multi-turn epoch lives in the background-work suite, which
 * is where a real retained host exists.
 */
async function scriptedTurns(
  id: string,
  scales: readonly number[],
): Promise<{
  usages: Array<import("@assistant/shared/session").AgentUsage | undefined>;
  session: ClaudeSdkSession;
}> {
  let run = 0;
  const scaled = (scale: number): ClaudeSdkMessage[] =>
    scriptedMessages().map((message) => {
      if (message.type !== "result") return message;
      const m = message as unknown as Record<string, unknown>;
      const model = (m.modelUsage as Record<string, Record<string, number>>)[
        "claude-sonnet-4-6"
      ];
      return {
        ...m,
        total_cost_usd: 0.0123 * scale,
        modelUsage: {
          "claude-sonnet-4-6": {
            ...model,
            inputTokens: 100 * scale,
            outputTokens: 5 * scale,
            cacheReadInputTokens: 900 * scale,
            cacheCreationInputTokens: 200 * scale,
            costUSD: 0.0123 * scale,
          },
        },
      } as unknown as ClaudeSdkMessage;
    });
  const seam: ClaudeSdkSeam = {
    query(_params: ClaudeQueryParams) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of scaled(scales[run++] ?? 1)) yield m;
        },
      };
    },
  };
  const session = new ClaudeSdkSession(id, {
    seam: () => Promise.resolve(seam),
  });
  const adapter = session.createRuntimeAdapter();
  const usages: Array<
    import("@assistant/shared/session").AgentUsage | undefined
  > = [];
  adapter.subscribe((event) => {
    if (event.type === "messageCompleted") usages.push(event.usage);
  });
  for (let i = 0; i < scales.length; i += 1)
    await adapter.prompt(`read x.txt (${i})`);
  return { usages, session };
}

test("a resumed epoch bills only its own run, however large", async () => {
  // "Resumed sessions start fresh": each new query()'s result is that run alone.
  // Turn 2 costing twice turn 1 must ADD, not replace — magnitude says nothing
  // about which reading applies.
  const { usages, session } = await scriptedTurns("usage-fresh-epochs", [1, 2]);
  assert.equal(usages[0]?.inputTokens, 100, "turn 1 bills its own run");
  assert.equal(usages[1]?.inputTokens, 200, "turn 2 bills its own run");
  const ctx = session.contextInfo();
  assert.equal(ctx.tokenUsage.input, 300, "the session spans both runs");
  assert.ok(
    Math.abs(ctx.cost - 0.0369) < 1e-9,
    `the session cost spans both runs (${ctx.cost})`,
  );
});

test("durable per-turn usage is the run's delta, not the session cumulative", async () => {
  const { usages, session } = await scriptedTurns("usage-per-turn", [1, 1]);
  assert.equal(usages.length, 2, "one usage per completed turn");
  for (const [i, usage] of usages.entries()) {
    assert.ok(usage, `turn ${i + 1} carries usage`);
    assert.equal(usage.inputTokens, 100, `turn ${i + 1} input is per-turn`);
    assert.equal(usage.outputTokens, 5, `turn ${i + 1} output is per-turn`);
    assert.equal(usage.cacheReadTokens, 900, `turn ${i + 1} cacheRead`);
    assert.equal(usage.cacheCreationTokens, 200, `turn ${i + 1} cacheWrite`);
    assert.ok(
      usage.costUSD !== undefined && Math.abs(usage.costUSD - 0.0123) < 1e-9,
      `turn ${i + 1} cost is per-turn (${usage.costUSD})`,
    );
    // Real context snapshot (input side of the last request), not the billed sum.
    assert.equal(usage.contextTokens, 1200, `turn ${i + 1} context snapshot`);
    assert.equal(
      usage.contextWindowTokens,
      1_000_000,
      `turn ${i + 1} context window`,
    );
  }
  const ctx = session.contextInfo();
  assert.equal(ctx.tokenUsage.input, 200, "cumulative input spans both turns");
  assert.ok(
    Math.abs(ctx.cost - 0.0246) < 1e-9,
    `cumulative cost spans both turns (${ctx.cost})`,
  );
});

test("a zeroed result neither bills nor erases the epoch", async () => {
  // "Crash/startup-error results may carry zeroed usage" — rebasing onto those
  // zeroes would wipe what the session had already billed.
  const { usages, session } = await scriptedTurns("usage-zeroed", [1, 0]);
  assert.equal(usages[0]?.inputTokens, 100, "turn 1 bills its run");
  assert.equal(usages[1], undefined, "the zeroed turn bills nothing");
  assert.equal(
    session.contextInfo().tokenUsage.input,
    100,
    "the zeroed result did not erase the session total",
  );
});
