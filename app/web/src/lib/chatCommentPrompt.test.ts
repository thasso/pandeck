import { describe, expect, it } from "vitest";
import {
  serializeChatCommentPrompt,
  truncateChatCommentQuote,
  type PendingDocumentComment,
  type PendingTranscriptComment,
} from "./chatCommentPrompt.ts";

function comment(
  id: string,
  entryId: string,
  rowSecond: number,
  blockIndex: number,
  start: number,
  quote: string,
  body: string,
  entryCreatedAt = "2026-08-20T14:32:00.000Z",
): PendingTranscriptComment {
  return {
    id,
    anchor: { kind: "session", sessionId: "s1", entryId, blockIndex },
    selectors: {
      quote: { exact: quote, prefix: "", suffix: "" },
      position: { start, end: start + quote.length },
    },
    quote,
    body,
    transcriptPosition: {
      rowCreatedAt: new Date(
        Date.UTC(2026, 7, 20, 14, 0, rowSecond),
      ).toISOString(),
      rowId: `row-${rowSecond}`,
      blockIndex,
    },
    entryCreatedAt,
  };
}

describe("serializeChatCommentPrompt", () => {
  it("keeps the overall message and orders comments by transcript position", () => {
    const later = comment("later", "e2", 20, 0, 0, "later quote", "Second");
    const secondInFirst = comment(
      "second",
      "e1",
      10,
      1,
      2,
      "second quote",
      "Middle",
    );
    const first = comment("first", "e1", 10, 0, 8, "first quote", "First");

    expect(
      serializeChatCommentPrompt(
        "Please address these.",
        [later, secondInFirst, first],
        {
          formatTime: (value) => (value.includes("14:32") ? "14:32" : "14:33"),
        },
      ),
    ).toBe(`Please address these.

Comments on your previous response:

1. On your message at 14:32, “first quote”:
   First

2. On your message at 14:32, “second quote”:
   Middle

3. On your message at 14:32, “later quote”:
   Second`);
  });

  it("orders mixed text/tool/text comments by rendered block, not target entry", () => {
    const firstText = comment(
      "first-text",
      "assistant-entry",
      1,
      0,
      0,
      "opening text",
      "First",
    );
    const toolBody = {
      ...comment(
        "tool-body",
        "tool-result-entry",
        99,
        0,
        0,
        "tool output",
        "Second",
      ),
      transcriptPosition: {
        ...firstText.transcriptPosition,
        blockIndex: 1,
      },
    };
    const finalText = {
      ...comment(
        "final-text",
        "assistant-entry",
        1,
        2,
        0,
        "final text",
        "Third",
      ),
      transcriptPosition: {
        ...firstText.transcriptPosition,
        blockIndex: 2,
      },
    };

    const serialized = serializeChatCommentPrompt("", [
      finalText,
      toolBody,
      firstText,
    ]);
    expect(serialized.indexOf("opening text")).toBeLessThan(
      serialized.indexOf("tool output"),
    );
    expect(serialized.indexOf("tool output")).toBeLessThan(
      serialized.indexOf("final text"),
    );
  });

  it("keeps preview and hydrated comments on the same row-time coordinate", () => {
    const preview = comment(
      "preview",
      "preview-entry",
      1,
      0,
      0,
      "captured before hydration",
      "First",
    );
    preview.transcriptPosition = {
      rowCreatedAt: "2026-08-20T14:31:00.000Z",
      rowId: "preview-entry",
      blockIndex: 0,
    };
    const hydrated = comment(
      "hydrated",
      "hydrated-entry",
      999,
      0,
      0,
      "captured after hydration",
      "Second",
    );
    hydrated.transcriptPosition = {
      rowCreatedAt: "2026-08-20T14:32:00.000Z",
      rowId: "hydrated-entry",
      blockIndex: 0,
    };

    const serialized = serializeChatCommentPrompt("", [hydrated, preview]);
    expect(serialized.indexOf("before hydration")).toBeLessThan(
      serialized.indexOf("after hydration"),
    );
  });

  it("allows an empty overall message and omits entry references for one entry", () => {
    expect(
      serializeChatCommentPrompt("", [
        comment("one", "e1", 1, 0, 0, "a passage", "React to this"),
      ]),
    ).toBe(`Comments on your previous response:

1. On “a passage”:
   React to this`);
  });

  it("indents every line in a multiline comment", () => {
    expect(
      serializeChatCommentPrompt("", [
        comment("one", "e1", 1, 0, 0, "quote", "First line\nSecond line"),
      ]),
    ).toContain("\n   First line\n   Second line");
  });
});

function documentComment(
  id: string,
  document: PendingDocumentComment["anchor"]["document"],
  body: string,
  passage?: { quote: string; lines?: { start: number; end: number } },
): PendingDocumentComment {
  return {
    id,
    anchor: { kind: "document", document },
    body,
    createdAt: `2026-08-20T14:00:0${id.length}.000Z`,
    ...(passage?.quote !== undefined ? { quote: passage.quote } : {}),
    ...(passage?.lines ? { lines: passage.lines } : {}),
  };
}

describe("serializeChatCommentPrompt with documents", () => {
  const plan = { kind: "hostFile" as const, path: "/tmp/example/plan.md" };
  const notes = { kind: "hostFile" as const, path: "/tmp/example/deploy.md" };

  it("groups comments per document, whole-document first, numbered across sections", () => {
    const serialized = serializeChatCommentPrompt("Please revise.", [
      documentComment("p2", plan, "Too vague", {
        quote: "ship it soon",
        lines: { start: 9, end: 9 },
      }),
      comment("t1", "e1", 1, 0, 0, "a reply", "Transcript note"),
      documentComment("k1", notes, "Split this file"),
      documentComment("p1", plan, "Name the owner", {
        quote: "someone will",
        lines: { start: 3, end: 5 },
      }),
    ]);
    expect(serialized).toBe(`Please revise.

Comments on your previous response:

1. On “a reply”:
   Transcript note

Comments on \`/tmp/example/plan.md\`:

2. Lines 3–5, “someone will”:
   Name the owner

3. Line 9, “ship it soon”:
   Too vague

Comments on \`/tmp/example/deploy.md\`:

4. On the whole document:
   Split this file`);
  });

  it("quotes a passage without lines when the renderer could not name them", () => {
    expect(
      serializeChatCommentPrompt("", [
        documentComment("p", plan, "Why?", { quote: "because" }),
      ]),
    ).toContain("1. On “because”:\n   Why?");
  });
});

describe("truncateChatCommentQuote", () => {
  it("truncates in the middle and keeps the requested bound", () => {
    const quote = `${"a".repeat(220)}${"z".repeat(220)}`;
    const truncated = truncateChatCommentQuote(quote);
    expect(truncated).toHaveLength(300);
    expect(truncated.startsWith("a".repeat(100))).toBe(true);
    expect(truncated.endsWith("z".repeat(100))).toBe(true);
    expect(truncated).toContain("…");
  });
});
