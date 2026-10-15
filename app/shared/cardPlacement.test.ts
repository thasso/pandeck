/**
 * Card placement: a store-backed card renders right after the tool call that
 * created it. One assistant entry holds a whole turn, so that position is
 * usually inside the entry — these pin the split, the entry coordinates the
 * continuation row keeps, and the identity the transcript's memoized rows need.
 */
import { describe, expect, it } from "vitest";
import {
  displayBlockOffset,
  displayEntryId,
  placeCardRows,
} from "./cardPlacement.ts";
import type {
  ApprovalCard,
  DisplayBlock,
  DisplayMessage,
  PullRequestCard,
} from "./protocol.ts";

const T0 = Date.parse("2026-10-14T21:44:00.000Z");

function tool(toolId: string): DisplayBlock {
  return {
    kind: "tool",
    toolId,
    name: "mcp__pa__worktree_create_pull_request",
    args: {},
    output: "",
    isError: false,
    done: true,
  };
}

function text(value: string): DisplayBlock {
  return { kind: "text", text: value };
}

function prompt(id: string, at: number): DisplayMessage {
  return {
    id,
    role: "user",
    blocks: [text("ship it")],
    createdAt: new Date(at).toISOString(),
  };
}

function turn(
  id: string,
  blocks: DisplayBlock[],
  patch: Partial<DisplayMessage> = {},
): DisplayMessage {
  return { id, role: "assistant", blocks, ...patch };
}

function prCard(
  id: string,
  createdAt: number,
  sourceToolCallId?: string,
): DisplayMessage {
  const card = {
    renderKind: "pullRequest",
    id,
    createdAt,
    ...(sourceToolCallId ? { sourceToolCallId } : {}),
  } as PullRequestCard;
  return {
    id: `pull-request-card-${id}`,
    role: "assistant",
    blocks: [{ kind: "pullRequest", pullRequest: card }],
    createdAt: new Date(createdAt).toISOString(),
  };
}

function approvalCard(
  id: string,
  createdAt: number,
  sourceToolCallId: string,
): DisplayMessage {
  const approval = {
    renderKind: "approval",
    id,
    createdAt,
    sourceToolCallId,
  } as ApprovalCard;
  return {
    id: `approval-${id}`,
    role: "assistant",
    blocks: [{ kind: "approval", approval }],
    createdAt: new Date(createdAt).toISOString(),
  };
}

const ids = (messages: readonly DisplayMessage[]) => messages.map((m) => m.id);

describe("placeCardRows", () => {
  it("splits a turn at the card's tool call and keeps the turn's end below it", () => {
    const entry = turn(
      "a1",
      [text("pushing"), tool("toolu_push"), tool("toolu_pr"), text("done")],
      {
        createdAt: new Date(T0 + 60_000).toISOString(),
        forkAtEntryId: "a1",
        stopReason: "error",
        error: "boom",
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "claude-opus-5-5",
        startedAt: new Date(T0).toISOString(),
        completedAt: new Date(T0 + 60_000).toISOString(),
        promptOrigin: { kind: "agent", agentId: "reviewer" },
      },
    );
    const placed = placeCardRows(
      [prompt("u1", T0), entry],
      [prCard("p1", T0 + 30_000, "toolu_pr")],
    );

    expect(ids(placed)).toEqual([
      "u1",
      "a1",
      "pull-request-card-p1",
      "a1~toolu_pr",
    ]);
    const [, head, , tail] = placed as [
      DisplayMessage,
      DisplayMessage,
      DisplayMessage,
      DisplayMessage,
    ];
    expect(head.blocks).toEqual(entry.blocks.slice(0, 3));
    expect(head.promptOrigin).toEqual(entry.promptOrigin);
    expect(head.fragment).toBeUndefined();
    for (const key of [
      "forkAtEntryId",
      "stopReason",
      "error",
      "usage",
      "model",
      "startedAt",
      "completedAt",
    ] as const) {
      expect(head[key]).toBeUndefined();
      expect(tail[key]).toEqual(entry[key]);
    }
    expect(tail.blocks).toEqual([text("done")]);
    expect(tail.createdAt).toBe(entry.createdAt);
    expect(tail.promptOrigin).toBeUndefined();
    expect(displayEntryId(tail)).toBe("a1");
    expect(displayBlockOffset(tail)).toBe(3);
  });

  it("follows the live turn: after its last block, then between the halves once text streams on", () => {
    const card = prCard("p1", T0 + 1_000, "toolu_pr");
    const live = turn("live", [text("opening"), tool("toolu_pr")], {
      streaming: true,
    });
    expect(ids(placeCardRows([prompt("u1", T0), live], [card]))).toEqual([
      "u1",
      "live",
      "pull-request-card-p1",
    ]);

    const streamed = turn("live", [...live.blocks, text("PR is up")], {
      streaming: true,
    });
    const placed = placeCardRows([prompt("u1", T0), streamed], [card]);
    expect(ids(placed)).toEqual([
      "u1",
      "live",
      "pull-request-card-p1",
      "live~toolu_pr",
    ]);
    // The streaming flag (progress line, streamingMessageId) moves to the end.
    expect(placed[1]!.streaming).toBeUndefined();
    expect(placed[3]!.streaming).toBe(true);
    expect(displayEntryId(placed[3]!)).toBe("live");
  });

  it("puts every card of one call between the same halves, oldest first", () => {
    const entry = turn("a1", [tool("toolu_x"), text("after")], {
      createdAt: new Date(T0 + 60_000).toISOString(),
    });
    const placed = placeCardRows(
      [entry],
      [
        prCard("p1", T0 + 20_000, "toolu_x"),
        approvalCard("ap1", T0 + 10_000, "toolu_x"),
      ],
    );
    expect(ids(placed)).toEqual([
      "a1",
      "approval-ap1",
      "pull-request-card-p1",
      "a1~toolu_x",
    ]);
  });

  it("splits a continuation again, keeping entry coordinates", () => {
    const entry = turn("a1", [
      tool("toolu_1"),
      text("between"),
      tool("toolu_2"),
      text("end"),
    ]);
    const placed = placeCardRows(
      [entry],
      [prCard("p1", T0, "toolu_1"), prCard("p2", T0 + 1, "toolu_2")],
    );
    expect(ids(placed)).toEqual([
      "a1",
      "pull-request-card-p1",
      "a1~toolu_1",
      "pull-request-card-p2",
      "a1~toolu_2",
    ]);
    expect(placed[2]!.blocks).toEqual([text("between"), tool("toolu_2")]);
    expect(displayBlockOffset(placed[2]!)).toBe(1);
    expect(placed[4]!.blocks).toEqual([text("end")]);
    expect(displayEntryId(placed[4]!)).toBe("a1");
    expect(displayBlockOffset(placed[4]!)).toBe(3);
  });

  it("hands back the same halves for an unchanged entry", () => {
    const entry = turn("a1", [tool("toolu_pr"), text("done")]);
    const cards = [prCard("p1", T0, "toolu_pr")];
    const first = placeCardRows([entry], cards);
    const second = placeCardRows([entry], cards);
    expect(second[0]).toBe(first[0]);
    expect(second[2]).toBe(first[2]);
  });

  it("falls back to creation time when no row holds the call", () => {
    const later = turn("a2", [text("later")], {
      createdAt: new Date(T0 + 5_000).toISOString(),
    });
    const placed = placeCardRows(
      [prompt("u1", T0), later, turn("live", [text("…")], { streaming: true })],
      [prCard("p1", T0 + 1_000, "toolu_elsewhere"), prCard("p2", T0 + 9_000)],
    );
    expect(ids(placed)).toEqual([
      "u1",
      "pull-request-card-p1",
      "a2",
      "pull-request-card-p2",
      "live",
    ]);
  });

  it("leaves a card older than the window to the history not loaded", () => {
    const placed = placeCardRows(
      [prompt("u1", T0)],
      [prCard("p1", T0 - 1_000), prCard("p2", T0 - 1_000, "toolu_x")],
      T0,
    );
    expect(ids(placed)).toEqual(["u1"]);
  });
});
