/**
 * Verifies the Claude SDK session threads prompt attachments to the model and
 * records them on the durable user entry.
 *
 * Run through the server Vitest suite:
 *   `pnpm --filter @assistant/server test src/claudeSdk/ClaudeSdkSession.attachments.test.ts`.
 *
 * A fake seam captures the query `prompt` iterable so we can assert the user turn
 * carries a base64 image content block for an image attachment, plus a text block
 * that references a non-image attachment by id. The committed user entry must also
 * carry an attachment content block per file so the transcript renders the chips.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { PromptAttachment } from "@assistant/shared";
import { ClaudeSdkSession } from "./ClaudeSdkSession.ts";
import type {
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
  ClaudeSdkUserMessage,
} from "./sdkSeam.ts";

/** A minimal successful one-block turn. */
function scriptedTurn(): ClaudeSdkMessage[] {
  const stream = (event: unknown): ClaudeSdkMessage =>
    ({
      type: "stream_event",
      event,
      parent_tool_use_id: null,
      uuid: `e${Math.random()}`,
      session_id: "s1",
    }) as unknown as ClaudeSdkMessage;
  return [
    stream({ type: "message_start", message: { id: "m1" } }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    }),
    stream({ type: "content_block_stop", index: 0 }),
    {
      type: "assistant",
      uuid: "a1",
      session_id: "s1",
      message: {
        id: "m1",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1 },
      },
    } as unknown as ClaudeSdkMessage,
    {
      type: "result",
      subtype: "success",
      session_id: "s1",
      usage: { input_tokens: 1 },
      total_cost_usd: 0,
    } as unknown as ClaudeSdkMessage,
  ];
}

test("Claude SDK prompt threads attachments to the model and durable entry", async () => {
  let capturedPrompt: ClaudeQueryParams["prompt"] | undefined;
  const seam: ClaudeSdkSeam = {
    query(params: ClaudeQueryParams) {
      capturedPrompt = params.prompt;
      const messages = scriptedTurn();
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m;
        },
      };
    },
  };

  const session = new ClaudeSdkSession("attach-cs", {
    seam: () => Promise.resolve(seam),
  });
  const image: PromptAttachment = {
    id: "img-1",
    name: "photo.png",
    mimeType: "image/png",
    size: 3,
    data: Buffer.from("PNG").toString("base64"),
  };
  const doc: PromptAttachment = {
    id: "doc-1",
    name: "notes.txt",
    mimeType: "text/plain",
    size: 5,
    data: Buffer.from("hello").toString("base64"),
  };

  await session
    .createRuntimeAdapter()
    .prompt("look at these", { attachments: [image, doc] });

  // The model turn carries an image content block + a text block referencing the
  // non-image file by id (and the original prompt text).
  assert.ok(
    capturedPrompt && typeof capturedPrompt !== "string",
    "prompt is a streaming iterable of user messages",
  );
  const yielded: ClaudeSdkUserMessage[] = [];
  for await (const m of capturedPrompt as AsyncIterable<ClaudeSdkUserMessage>)
    yielded.push(m);
  const content = yielded[0]?.message.content as Array<{
    type: string;
    source?: { type: string; media_type: string; data: string };
    text?: string;
  }>;
  assert.ok(Array.isArray(content), "user message content is a block array");
  const imageBlock = content.find((b) => b.type === "image");
  assert.ok(imageBlock, "image content block present");
  assert.equal(imageBlock.source?.media_type, "image/png");
  assert.equal(imageBlock.source?.data, image.data);
  const textBlock = content.find((b) => b.type === "text");
  assert.ok(
    textBlock?.text?.includes("look at these"),
    "text block keeps the user prompt",
  );
  assert.ok(
    textBlock?.text?.includes("doc-1"),
    "text block references the non-image attachment by id",
  );
  assert.ok(
    !textBlock?.text?.includes("img-1"),
    "image is not duplicated into the text suffix",
  );

  // The committed user entry carries one attachment content block per file.
  const userEntry = session.timelineEntries()[0];
  assert.ok(
    userEntry && userEntry.type === "message" && userEntry.role === "user",
    "first committed entry is the user turn",
  );
  const attachmentBlocks = (
    userEntry.content as Array<{ type: string; ref?: string }>
  ).filter((b) => b.type === "image");
  assert.equal(
    attachmentBlocks.length,
    2,
    "two attachment content blocks recorded on the durable entry",
  );
  assert.deepEqual(
    attachmentBlocks.map((b) => b.ref).sort(),
    ["doc-1", "img-1"],
    "attachment refs are the saved ids",
  );
});
