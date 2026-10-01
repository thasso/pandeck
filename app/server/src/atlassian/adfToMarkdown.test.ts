import { describe, expect, test } from "vitest";
import { adfToMarkdown, adfToText } from "./adfToMarkdown.ts";
import { markdownToAdf } from "./adfFromMarkdown.ts";

function doc(...content: unknown[]) {
  return { type: "doc", version: 1, content };
}

function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

describe("adfToMarkdown", () => {
  test("renders headings, marks and links", () => {
    const markdown = adfToMarkdown(
      doc(
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "strong" }] },
            { type: "text", text: " and " },
            {
              type: "text",
              text: "link",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
      ),
    );
    expect(markdown).toContain("## Title");
    expect(markdown).toContain("**bold**");
    expect(markdown).toContain("[link](https://example.com)");
  });

  test("renders a table as GFM with a header row", () => {
    const markdown = adfToMarkdown(
      doc({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [paragraph("Env")] },
              { type: "tableHeader", content: [paragraph("Host")] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [paragraph("prod")] },
              { type: "tableCell", content: [paragraph("pa.example.net")] },
            ],
          },
        ],
      }),
    );
    expect(markdown).toBe(
      ["| Env | Host |", "| --- | --- |", "| prod | pa\\.example\\.net |"].join(
        "\n",
      ),
    );
  });

  test("round-trips a Markdown table through ADF", () => {
    const source = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const markdown = adfToMarkdown(markdownToAdf(source));
    expect(markdown).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  test("pads short rows and escapes pipes inside cells", () => {
    const markdown = adfToMarkdown(
      doc({
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [paragraph("a|b")] },
              { type: "tableHeader", content: [paragraph("c")] },
            ],
          },
          {
            type: "tableRow",
            content: [{ type: "tableCell", content: [paragraph("only")] }],
          },
        ],
      }),
    );
    expect(markdown).toContain("| a\\|b | c |");
    expect(markdown).toContain("| only |  |");
  });

  test("labels a panel with its severity", () => {
    const markdown = adfToMarkdown(
      doc({
        type: "panel",
        attrs: { panelType: "warning" },
        content: [paragraph("Do not deploy on Friday")],
      }),
    );
    expect(markdown).toBe("> **Warning**\n>\n> Do not deploy on Friday");
  });

  test("keeps an expand's title and body", () => {
    const markdown = adfToMarkdown(
      doc({
        type: "expand",
        attrs: { title: "Runbook" },
        content: [paragraph("Step one")],
      }),
    );
    expect(markdown).toContain("**Expand: Runbook**");
    expect(markdown).toContain("Step one");
  });

  test("renders task and decision lists as checkable items", () => {
    const markdown = adfToMarkdown(
      doc(
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { state: "DONE" },
              content: [{ type: "text", text: "done" }],
            },
            {
              type: "taskItem",
              attrs: { state: "TODO" },
              content: [{ type: "text", text: "open" }],
            },
          ],
        },
        {
          type: "decisionList",
          content: [
            {
              type: "decisionItem",
              content: [{ type: "text", text: "ship it" }],
            },
          ],
        },
      ),
    );
    expect(markdown).toContain("- [x] done");
    expect(markdown).toContain("- [ ] open");
    expect(markdown).toContain("- ship it");
  });

  test("names a macro instead of dropping it", () => {
    const markdown = adfToMarkdown(
      doc({
        type: "extension",
        attrs: {
          extensionKey: "toc",
          parameters: { macroParams: { maxLevel: { value: "3" } } },
        },
      }),
    );
    expect(markdown).toBe("[macro: toc maxLevel=3]");
  });

  test("keeps a bodied extension's body below its label", () => {
    const markdown = adfToMarkdown(
      doc({
        type: "bodiedExtension",
        attrs: { extensionKey: "note" },
        content: [paragraph("inside the macro")],
      }),
    );
    expect(markdown).toContain("[macro: note]");
    expect(markdown).toContain("inside the macro");
  });

  test("marks an attachment rather than rendering nothing", () => {
    const markdown = adfToMarkdown(
      doc({
        type: "mediaSingle",
        content: [
          {
            type: "media",
            attrs: { id: "abc", type: "file", alt: "diagram.png" },
          },
        ],
      }),
    );
    expect(markdown).toBe("[attachment: diagram.png]");
  });

  test("flattens layout columns into sequential blocks", () => {
    const markdown = adfToMarkdown(
      doc({
        type: "layoutSection",
        content: [
          { type: "layoutColumn", content: [paragraph("left")] },
          { type: "layoutColumn", content: [paragraph("right")] },
        ],
      }),
    );
    expect(markdown).toBe("left\n\nright");
  });

  test("renders status lozenges and dates", () => {
    const markdown = adfToMarkdown(
      doc({
        type: "paragraph",
        content: [
          { type: "status", attrs: { text: "In progress" } },
          { type: "text", text: " since " },
          { type: "date", attrs: { timestamp: "1735689600000" } },
        ],
      }),
    );
    expect(markdown).toBe("`In progress` since 2025-01-01");
  });

  test("an out-of-range date is dropped, not thrown on", () => {
    // `new Date(1e20).toISOString()` throws RangeError; one malformed date
    // node must not fail the whole issue or page being rendered.
    const markdown = adfToMarkdown(
      doc({
        type: "paragraph",
        content: [
          { type: "text", text: "due " },
          { type: "date", attrs: { timestamp: "1e20" } },
        ],
      }),
    );
    expect(markdown).toBe("due");
    expect(adfToMarkdown(doc({ type: "date", attrs: {} }))).toBeNull();
  });

  test("nested lists keep their indentation", () => {
    const markdown = adfToMarkdown(
      doc({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              paragraph("outer"),
              {
                type: "bulletList",
                content: [{ type: "listItem", content: [paragraph("inner")] }],
              },
            ],
          },
        ],
      }),
    );
    expect(markdown).toBe("- outer\n  \n    - inner");
  });

  test("null and empty documents stay null", () => {
    expect(adfToMarkdown(null)).toBeNull();
    expect(adfToMarkdown(undefined)).toBeNull();
    expect(adfToMarkdown(doc())).toBeNull();
  });
});

describe("adfToText", () => {
  test("flattens structure to plain text", () => {
    expect(adfToText(doc(paragraph("first"), paragraph("second")))).toBe(
      "first\nsecond",
    );
  });

  test("passes a plain string through", () => {
    expect(adfToText("already text")).toBe("already text");
  });
});
