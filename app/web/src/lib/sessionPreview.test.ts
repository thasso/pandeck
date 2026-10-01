import { describe, expect, test } from "vitest";
import type { DisplayMessage } from "@assistant/shared";
import {
  appendLiveMessagesAfterPreview,
  isTransientMessageId,
} from "./sessionPreview.ts";

function message(
  id: string,
  role: "user" | "assistant" = "assistant",
): DisplayMessage {
  return { id, role, blocks: [{ kind: "text", text: id }] };
}

describe("appendLiveMessagesAfterPreview", () => {
  test("keeps live rows added after a stale reconnect preview", () => {
    const preview = [message("prompt", "user")];
    const live = [
      message("prompt", "user"),
      message("answer"),
      {
        id: "commit",
        role: "assistant",
        blocks: [
          {
            kind: "commit",
            commit: {
              status: "committed",
              dryRun: false,
              forced: false,
              files: [],
              totals: { files: 0, additions: 0, deletions: 0 },
              blockers: [],
              warnings: [],
            },
          },
        ],
      },
      message("push", "user"),
    ] satisfies DisplayMessage[];

    expect(
      appendLiveMessagesAfterPreview(preview, live).map((item) => item.id),
    ).toEqual(["prompt", "answer", "commit", "push"]);
  });

  test("prefers authoritative live rows when the preview no longer overlaps", () => {
    const live = [message("other", "user")];
    expect(
      appendLiveMessagesAfterPreview([message("stale", "user")], live),
    ).toBe(live);
  });

  test("never anchors on the streaming pseudo-row: a preview saved mid-turn must not hide live rows behind the CURRENT turn's live row", () => {
    // Regression: the in-flight stream always projects as id "live". A preview
    // saved mid-turn ends with it; anchoring there matched a LATER turn's live
    // row (always last), truncating the transcript to the stale preview until
    // the turn ended.
    const preview = [
      message("u1", "user"),
      message("a1"),
      { ...message("live"), streaming: true },
    ];
    const live = [
      message("u1", "user"),
      message("a1"),
      message("u2", "user"),
      message("a2"),
      message("u3", "user"),
      { ...message("live"), streaming: true },
    ];
    expect(
      appendLiveMessagesAfterPreview(preview, live).map((item) => item.id),
    ).toEqual(["u1", "a1", "u2", "a2", "u3", "live"]);
  });

  test("ignores optimistic prompt rows when anchoring the merge", () => {
    const preview = [
      message("u1", "user"),
      message("a1"),
      message("creq-abc", "user"),
    ];
    const live = [
      message("u1", "user"),
      message("a1"),
      message("u2", "user"),
      message("a2"),
    ];
    expect(
      appendLiveMessagesAfterPreview(preview, live).map((item) => item.id),
    ).toEqual(["u1", "a1", "u2", "a2"]);
  });

  test("falls back to live rows for a preview holding only transient rows", () => {
    const live = [message("u1", "user")];
    expect(
      appendLiveMessagesAfterPreview(
        [message("live"), message("creq-x", "user")],
        live,
      ),
    ).toBe(live);
  });
});

describe("isTransientMessageId", () => {
  test("flags the streaming pseudo-row and optimistic prompts only", () => {
    expect(isTransientMessageId("live")).toBe(true);
    expect(isTransientMessageId("creq-123")).toBe(true);
    expect(isTransientMessageId("entry-1")).toBe(false);
    expect(isTransientMessageId("alive")).toBe(false);
  });
});
