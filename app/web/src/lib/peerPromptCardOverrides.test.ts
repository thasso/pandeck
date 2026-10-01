import { describe, expect, it } from "vitest";
import type {
  DisplayMessage,
  PeerPromptCard,
  PeerPromptThreadsProjection,
} from "@assistant/shared";
import {
  applyPeerPromptCardOverride,
  applyPeerPromptCardOverridesToMessages,
  seedPeerPromptCardOverridesFromHistory,
} from "./peerPromptCardOverrides.ts";

function card(over: Partial<PeerPromptCard> = {}): PeerPromptCard {
  return {
    direction: "sent",
    messageKey: "k1",
    senderTitle: "Me",
    message: "hi",
    responseRequested: false,
    state: "queued",
    ...over,
  };
}

describe("applyPeerPromptCardOverride", () => {
  it("returns the same object reference when there is no matching override", () => {
    const c = card();
    expect(applyPeerPromptCardOverride(c, {})).toBe(c);
    expect(
      applyPeerPromptCardOverride(c, { other: { state: "completed" } }),
    ).toBe(c);
  });

  it("patches state and failureReason when a matching override exists", () => {
    const c = card({ state: "queued" });
    const patched = applyPeerPromptCardOverride(c, {
      k1: { state: "interrupted", failureReason: "boom" },
    });
    expect(patched.state).toBe("interrupted");
    expect(patched.failureReason).toBe("boom");
    expect(patched.message).toBe("hi"); // other fields preserved
  });
});

describe("applyPeerPromptCardOverridesToMessages", () => {
  it("is a no-op with no overrides", () => {
    const messages: DisplayMessage[] = [
      {
        id: "m1",
        role: "user",
        blocks: [{ kind: "peerPrompt", peerPrompt: card() }],
      },
    ];
    expect(applyPeerPromptCardOverridesToMessages(messages, {})).toBe(messages);
  });

  it("patches a recipient peerPrompt transcript block in place", () => {
    const messages: DisplayMessage[] = [
      {
        id: "m1",
        role: "user",
        blocks: [
          {
            kind: "peerPrompt",
            peerPrompt: card({
              direction: "received",
              messageKey: "k2",
              state: "queued",
            }),
          },
        ],
      },
    ];
    const next = applyPeerPromptCardOverridesToMessages(messages, {
      k2: { state: "completed" },
    });
    const block = next[0]!.blocks[0]!;
    expect(block.kind).toBe("peerPrompt");
    expect(
      block.kind === "peerPrompt" ? block.peerPrompt.state : undefined,
    ).toBe("completed");
  });

  it("patches a sender sessionPeerPrompt tool-card JSON output in place", () => {
    const payload = {
      renderKind: "sessionPeerPrompt",
      version: 1,
      card: card({ messageKey: "k3", state: "queued" }),
    };
    const messages: DisplayMessage[] = [
      {
        id: "m2",
        role: "assistant",
        blocks: [
          {
            kind: "tool",
            toolId: "t1",
            name: "session_send_prompt",
            args: {},
            output: JSON.stringify(payload, null, 2),
            isError: false,
            done: true,
          },
        ],
      },
    ];
    const next = applyPeerPromptCardOverridesToMessages(messages, {
      k3: { state: "replied" },
    });
    const block = next[0]!.blocks[0]!;
    expect(block.kind).toBe("tool");
    const parsed = block.kind === "tool" ? JSON.parse(block.output) : null;
    expect(parsed?.card?.state).toBe("replied");
  });

  it("degrades gracefully for malformed tool output and non-matching tool payloads", () => {
    const messages: DisplayMessage[] = [
      {
        id: "m3",
        role: "assistant",
        blocks: [
          {
            kind: "tool",
            toolId: "t2",
            name: "x",
            args: {},
            output: "{ not json",
            isError: false,
            done: true,
          },
        ],
      },
      {
        id: "m4",
        role: "assistant",
        blocks: [
          {
            kind: "tool",
            toolId: "t3",
            name: "y",
            args: {},
            output: JSON.stringify({ renderKind: "other" }),
            isError: false,
            done: true,
          },
        ],
      },
    ];
    const next = applyPeerPromptCardOverridesToMessages(messages, {
      k1: { state: "completed" },
    });
    expect(next).toBe(messages); // unchanged, no matching blocks
  });

  it("does not patch an in-progress (not done) or errored tool block", () => {
    const payload = {
      renderKind: "sessionPeerPrompt",
      card: card({ messageKey: "k4", state: "queued" }),
    };
    const messages: DisplayMessage[] = [
      {
        id: "m5",
        role: "assistant",
        blocks: [
          {
            kind: "tool",
            toolId: "t4",
            name: "session_send_prompt",
            args: {},
            output: JSON.stringify(payload),
            isError: false,
            done: false,
          },
        ],
      },
    ];
    const next = applyPeerPromptCardOverridesToMessages(messages, {
      k4: { state: "completed" },
    });
    expect(next).toBe(messages);
  });
});

describe("seedPeerPromptCardOverridesFromHistory", () => {
  it("returns an empty map when there is no history projection", () => {
    expect(seedPeerPromptCardOverridesFromHistory(undefined)).toEqual({});
  });

  it("seeds one override per message across all threads, keyed by the message id", () => {
    const projection: PeerPromptThreadsProjection = {
      truncated: false,
      threads: [
        {
          conversationId: "c1",
          otherPartyTitle: "Other",
          peerSessionId: "peer-1",
          messages: [
            {
              id: "m1",
              direction: "sent",
              message: "hi",
              state: "completed",
              responseRequested: false,
              createdAt: 1,
            },
            {
              id: "m2",
              direction: "received",
              message: "boom",
              state: "failed",
              responseRequested: false,
              failureReason: "provider error",
              createdAt: 2,
            },
          ],
        },
        {
          conversationId: "c2",
          otherPartyTitle: "Third",
          peerSessionId: "peer-1",
          messages: [
            {
              id: "m3",
              direction: "sent",
              message: "yo",
              state: "queued",
              responseRequested: false,
              createdAt: 3,
            },
          ],
        },
      ],
    };
    const overrides = seedPeerPromptCardOverridesFromHistory(projection);
    expect(overrides).toEqual({
      m1: { state: "completed", failureReason: undefined },
      m2: { state: "failed", failureReason: "provider error" },
      m3: { state: "queued", failureReason: undefined },
    });
  });
});
