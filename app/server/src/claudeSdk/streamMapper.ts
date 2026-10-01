/**
 * Maps one Claude `stream_event` (a `SDKPartialAssistantMessage`) to the small
 * delta union the session consumes.
 *
 * Stream identity is intentionally NOT derived here: an SDK stream_event's wrapper
 * `uuid` changes from event to event and differs from the final `assistant`
 * message's uuid, so it can't identify the turn. The session owns stream identity
 * and keys deltas on the stable provider message id instead. `input_json_delta`
 * events lack a tool id (it's `""` here); the session attributes them to the right
 * tool block via its own per-block index map.
 */
import { type ClaudeUsage, mapUsage } from "./messageMapper.ts";
import type { ClaudeSdkMessage } from "./sdkSeam.ts";

export type ClaudePartialMessage = Extract<
  ClaudeSdkMessage,
  { type: "stream_event" }
>;

export type StreamDelta =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolInputDelta"; toolCallId: string; inputDelta: string }
  | { type: "toolEnd"; toolCallId: string };

export function mapStreamEvent(message: ClaudePartialMessage): StreamDelta[] {
  const event = message.event as unknown as Record<string, unknown>;
  switch (event.type) {
    case "content_block_start":
      return mapContentBlockStart(event.content_block);
    case "content_block_delta":
      return mapContentBlockDelta(event.delta);
    case "content_block_stop":
      return mapContentBlockStop(event);
    default:
      return [];
  }
}

function mapContentBlockStart(contentBlock: unknown): StreamDelta[] {
  if (!contentBlock || typeof contentBlock !== "object") return [];
  const block = contentBlock as Record<string, unknown>;
  if (block.type === "text" && typeof block.text === "string" && block.text) {
    return [{ type: "text", text: block.text }];
  }
  if (
    block.type === "thinking" &&
    typeof block.thinking === "string" &&
    block.thinking
  ) {
    return [{ type: "thinking", text: block.thinking }];
  }
  if (block.type === "tool_use") {
    return block.input === undefined
      ? []
      : [
          {
            type: "toolInputDelta",
            toolCallId: String(block.id ?? ""),
            inputDelta: JSON.stringify(block.input),
          },
        ];
  }
  return [];
}

function mapContentBlockDelta(delta: unknown): StreamDelta[] {
  if (!delta || typeof delta !== "object") return [];
  const d = delta as Record<string, unknown>;
  switch (d.type) {
    case "text_delta":
      return [{ type: "text", text: String(d.text ?? "") }];
    case "thinking_delta":
      return [{ type: "thinking", text: String(d.thinking ?? "") }];
    case "input_json_delta":
      // No tool id on the delta; the session resolves it from the block index.
      return [
        {
          type: "toolInputDelta",
          toolCallId: "",
          inputDelta: String(d.partial_json ?? ""),
        },
      ];
    default:
      return [];
  }
}

function mapContentBlockStop(event: Record<string, unknown>): StreamDelta[] {
  const contentBlock = event.content_block as
    Record<string, unknown> | undefined;
  const toolCallId =
    typeof contentBlock?.id === "string" ? contentBlock.id : "";
  return [{ type: "toolEnd", toolCallId }];
}

/** Whether a stream_event is a `message_start`, and its inner message id if so. */
export function streamMessageStartId(
  message: ClaudePartialMessage,
): string | undefined {
  const event = message.event as unknown as Record<string, unknown>;
  if (event.type !== "message_start") return undefined;
  const inner = event.message as Record<string, unknown> | undefined;
  return typeof inner?.id === "string" && inner.id ? inner.id : undefined;
}

/**
 * Usage carried by a `message_start` stream_event, if any. The Anthropic
 * streaming API reports the request's input-side token counts (input +
 * cache_read + cache_creation) up front in `message_start`, so this gives a live
 * context-size reading at the very start of an assistant turn — before the
 * committed `assistant` message arrives.
 */
export function streamMessageStartUsage(
  message: ClaudePartialMessage,
): ClaudeUsage | undefined {
  const event = message.event as unknown as Record<string, unknown>;
  if (event.type !== "message_start") return undefined;
  const inner = event.message as Record<string, unknown> | undefined;
  if (!inner || typeof inner.usage !== "object" || inner.usage === null)
    return undefined;
  return mapUsage(inner.usage);
}

/** The block index on a stream_event (for tool-id attribution), as a string. */
export function streamBlockIndex(message: ClaudePartialMessage): string {
  const event = message.event as unknown as Record<string, unknown>;
  return String(event.index ?? "");
}

/** If a stream_event is a `content_block_start` opening a tool_use, its tool id. */
export function streamToolBlockId(
  message: ClaudePartialMessage,
): string | undefined {
  const event = message.event as unknown as Record<string, unknown>;
  if (event.type !== "content_block_start") return undefined;
  const block = event.content_block as Record<string, unknown> | undefined;
  return block?.type === "tool_use" && typeof block.id === "string"
    ? block.id
    : undefined;
}
