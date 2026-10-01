import { describe, expect, test } from "vitest";
import { markdownToAdf, type AdfNode } from "./adfFromMarkdown.ts";

function findAll(node: AdfNode, type: string): AdfNode[] {
  const found = node.type === type ? [node] : [];
  return [
    ...found,
    ...(node.content ?? []).flatMap((child) => findAll(child, type)),
  ];
}

describe("markdownToAdf", () => {
  test("converts CommonMark/GFM block and inline formatting to native ADF", () => {
    const doc = markdownToAdf(`# Heading

A **bold**, *italic*, ~~deleted~~, and \`code\` [link](https://example.com "Example").

> Quoted **text**

1. first
2. second

- [x] shipped
- [ ] pending

---

\`\`\`ts
const answer = 42;
\`\`\`

| Name | State |
| --- | --- |
| Jira | **ready** |`);

    expect(doc).toMatchObject({ version: 1, type: "doc" });
    expect(findAll(doc, "heading")[0]).toMatchObject({ attrs: { level: 1 } });
    expect(findAll(doc, "blockquote")).toHaveLength(1);
    expect(findAll(doc, "orderedList")).toHaveLength(1);
    expect(findAll(doc, "bulletList")).toHaveLength(1);
    expect(findAll(doc, "rule")).toHaveLength(1);
    expect(findAll(doc, "codeBlock")[0]).toMatchObject({
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const answer = 42;" }],
    });
    expect(findAll(doc, "table")).toHaveLength(1);
    expect(findAll(doc, "tableHeader")).toHaveLength(2);
    expect(findAll(doc, "tableCell")).toHaveLength(2);

    const texts = findAll(doc, "text");
    expect(texts.find((node) => node.text === "bold")?.marks).toContainEqual({
      type: "strong",
    });
    expect(texts.find((node) => node.text === "italic")?.marks).toContainEqual({
      type: "em",
    });
    expect(texts.find((node) => node.text === "deleted")?.marks).toContainEqual(
      { type: "strike" },
    );
    expect(texts.find((node) => node.text === "code")?.marks).toContainEqual({
      type: "code",
    });
    expect(texts.find((node) => node.text === "link")?.marks).toContainEqual({
      type: "link",
      attrs: { href: "https://example.com", title: "Example" },
    });
    expect(texts.some((node) => node.text === "☑ ")).toBe(true);
    expect(texts.some((node) => node.text === "☐ ")).toBe(true);
  });

  test("flattens nested blockquotes into Jira-valid ADF without dropping their content", () => {
    const doc = markdownToAdf(`> Outer quote
>
>> Nested quote
>>
>>> Deeply nested quote`);

    expect(findAll(doc, "blockquote")).toHaveLength(1);
    expect(findAll(doc, "text").map((node) => node.text)).toEqual([
      "Outer quote",
      "Nested quote",
      "Deeply nested quote",
    ]);
  });

  test("supports reference links, autolinks, images, footnotes, and hard breaks without dropping content", () => {
    const doc =
      markdownToAdf(`See [OPS-1][ticket], <https://example.com>, and ![diagram](https://example.com/diagram.png).
Line one  
Line two with a note.[^n]

[ticket]: https://jira.example/browse/OPS-1

[^n]: Footnote **body**.`);
    const texts = findAll(doc, "text");

    expect(texts.find((node) => node.text === "OPS-1")?.marks).toContainEqual({
      type: "link",
      attrs: { href: "https://jira.example/browse/OPS-1" },
    });
    expect(
      texts.find((node) => node.text === "https://example.com")?.marks,
    ).toContainEqual({ type: "link", attrs: { href: "https://example.com" } });
    expect(
      texts.find((node) => node.text === "[image: diagram]")?.marks,
    ).toContainEqual({
      type: "link",
      attrs: { href: "https://example.com/diagram.png" },
    });
    expect(findAll(doc, "hardBreak")).toHaveLength(1);
    expect(texts.some((node) => node.text === "[^n]")).toBe(true);
    expect(texts.some((node) => node.text === "Footnote ")).toBe(true);
  });

  test("preserves raw HTML visibly and returns a valid empty document", () => {
    const html = markdownToAdf(
      "<details>\n<summary>More</summary>\n</details>",
    );
    expect(findAll(html, "codeBlock")[0]).toMatchObject({
      attrs: { language: "html" },
    });

    expect(markdownToAdf("")).toEqual({
      version: 1,
      type: "doc",
      content: [{ type: "paragraph" }],
    });
  });
});
