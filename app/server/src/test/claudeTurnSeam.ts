/**
 * A fake Claude SDK seam whose every query is one short, successful turn: a
 * streamed text reply and a `result` with usage. Enough for tests that need a
 * real committed turn through `ClaudeSdkSession` without caring about its
 * content.
 */
import type { ClaudeSdkMessage, ClaudeSdkSeam } from "../claudeSdk/sdkSeam.ts";

/** One scripted turn: a streamed text reply and a successful result. */
function turn(text: string): ClaudeSdkMessage[] {
  const stream = (event: unknown) =>
    ({
      type: "stream_event",
      event,
      parent_tool_use_id: null,
      uuid: `evt-${Math.random()}`,
      session_id: "provider-store",
    }) as unknown as ClaudeSdkMessage;
  const messageId = `msg-${Math.random()}`;
  return [
    stream({ type: "message_start", message: { id: messageId } }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    stream({ type: "content_block_stop", index: 0 }),
    {
      type: "assistant",
      uuid: `asst-${Math.random()}`,
      session_id: "provider-store",
      message: {
        id: messageId,
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text }],
      },
    } as unknown as ClaudeSdkMessage,
    {
      type: "result",
      subtype: "success",
      session_id: "provider-store",
      total_cost_usd: 0.01,
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.01,
          contextWindow: 200_000,
        },
      },
    } as unknown as ClaudeSdkMessage,
  ];
}

export const claudeTurnSeam: ClaudeSdkSeam = {
  query() {
    const messages = turn("a reply");
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
      },
    };
  },
  deleteSession: async () => {},
};
