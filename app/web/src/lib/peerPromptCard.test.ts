import { describe, expect, it } from "vitest";
import { isPeerPromptState, parsePeerPromptCard } from "./peerPromptCard.ts";

describe("parsePeerPromptCard", () => {
  it("accepts a well-formed card unchanged", () => {
    const card = {
      direction: "sent",
      messageKey: "k1",
      senderTitle: "Impl",
      recipientTitle: "Reviewer",
      peerSessionId: "11111111-2222-3333-4444-555555555555",
      message: "please review",
      responseRequested: true,
      taskTitle: "Fix bug",
      failureReason: "boom",
      state: "retrying",
    };
    expect(parsePeerPromptCard(card)).toEqual(card);
  });

  // The three fields that DECIDE the card: without them there is nothing
  // honest to render, so the caller falls back to the raw tool output.
  it("rejects a card missing a direction, a string message, or a known state", () => {
    expect(parsePeerPromptCard({ message: "hi", state: "queued" })).toBeNull();
    expect(
      parsePeerPromptCard({
        direction: "sideways",
        message: "hi",
        state: "queued",
      }),
    ).toBeNull();
    expect(
      parsePeerPromptCard({ direction: "sent", message: {}, state: "queued" }),
    ).toBeNull();
    expect(
      parsePeerPromptCard({ direction: "sent", message: "hi" }),
    ).toBeNull();
    expect(
      parsePeerPromptCard({
        direction: "sent",
        message: "hi",
        state: "hasOwnProperty",
      }),
    ).toBeNull();
  });

  it("rejects anything that is not a plain object", () => {
    for (const value of [null, undefined, 7, "card", [], [{}]])
      expect(parsePeerPromptCard(value)).toBeNull();
  });

  it("coerces or drops every remaining field rather than trusting it", () => {
    expect(
      parsePeerPromptCard({
        direction: "received",
        message: "hi",
        state: "delivered",
        messageKey: 7,
        senderTitle: "",
        recipientTitle: {},
        peerSessionId: 12,
        responseRequested: "yes",
        taskTitle: 5,
        failureReason: { why: "object" },
      }),
    ).toEqual({
      direction: "received",
      messageKey: "",
      senderTitle: "another session",
      message: "hi",
      responseRequested: false,
      state: "delivered",
    });
  });
});

describe("isPeerPromptState", () => {
  it("answers only for the protocol's own states", () => {
    expect(isPeerPromptState("awaiting_response")).toBe(true);
    expect(isPeerPromptState("cancelled")).toBe(true);
    expect(isPeerPromptState("constructor")).toBe(false);
    expect(isPeerPromptState(undefined)).toBe(false);
  });
});
