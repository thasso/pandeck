import { describe, expect, it } from "vitest";
import type { DisplayMessage } from "@assistant/shared";
import { mentionedPaUris, mentionedSessionIds } from "./transcriptMentions.ts";

/**
 * The scan the transcript's link references are narrowed against. Its failure
 * mode is a link that renders without its title, which nothing else catches —
 * so every Markdown-bearing field a row can render is asserted here by name.
 */

const SESSION_A = "11111111-2222-3333-4444-555555555555";
const SESSION_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function message(blocks: DisplayMessage["blocks"]): DisplayMessage {
  return {
    id: "m1",
    role: "assistant",
    blocks,
    createdAt: new Date(1_700_000_000_000).toISOString(),
  } as DisplayMessage;
}

function textBlock(text: string) {
  return { kind: "text", text } as DisplayMessage["blocks"][number];
}

function compactionBlock(summary: string) {
  return {
    kind: "compaction",
    compaction: { tokensBefore: 100, summary },
  } as unknown as DisplayMessage["blocks"][number];
}

describe("mentionedSessionIds", () => {
  it("reads a text block", () => {
    expect([
      ...mentionedSessionIds([message([textBlock(`see ${SESSION_A}`)])]),
    ]).toEqual([SESSION_A]);
  });

  it("reads a compaction summary, which renders Markdown with the same references", () => {
    expect([
      ...mentionedSessionIds([
        message([compactionBlock(`carried over from ${SESSION_B}`)]),
      ]),
    ]).toEqual([SESSION_B]);
  });

  it("matches case-insensitively, as the autolink's lookup does", () => {
    expect([
      ...mentionedSessionIds([
        message([textBlock(`see ${SESSION_A.toUpperCase()}`)]),
      ]),
    ]).toEqual([SESSION_A]);
  });

  it("is empty for a message that names none", () => {
    expect(
      mentionedSessionIds([message([textBlock("no ids here")])]).size,
    ).toBe(0);
  });
});

describe("mentionedPaUris", () => {
  it("reads both a text block and a compaction summary", () => {
    expect(
      mentionedPaUris([
        message([
          textBlock("see [](pa://task/42)"),
          compactionBlock("kept pa://project/pa"),
        ]),
      ]).sort(),
    ).toEqual(["pa://project/pa", "pa://task/42"]);
  });

  it("de-duplicates across blocks", () => {
    expect(
      mentionedPaUris([
        message([
          textBlock("pa://task/42"),
          compactionBlock("still pa://task/42"),
        ]),
      ]),
    ).toEqual(["pa://task/42"]);
  });
});
