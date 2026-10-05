import { describe, expect, it } from "vitest";
import { splitMarkdownFrontmatter } from "./markdownFrontmatter.ts";

describe("splitMarkdownFrontmatter", () => {
  it("returns a document without frontmatter untouched", () => {
    const text = "# Title\n\nBody\n";
    expect(splitMarkdownFrontmatter(text)).toEqual({
      frontmatter: null,
      body: text,
    });
  });

  it("keeps every body line on its original line number", () => {
    const text = "---\ntitle: Plan\nowner: me\n---\n# Plan\nline six\n";
    const { body } = splitMarkdownFrontmatter(text);
    expect(body.split("\n")).toEqual([
      "",
      "",
      "",
      "",
      "# Plan",
      "line six",
      "",
    ]);
    expect(body.split("\n").indexOf("line six")).toBe(
      text.split("\n").indexOf("line six"),
    );
  });

  it("does the same for CRLF files", () => {
    const text = "---\r\ntitle: Plan\r\n---\r\nBody\r\n";
    const { frontmatter, body } = splitMarkdownFrontmatter(text);
    expect(frontmatter?.title).toBe("Plan");
    expect(body).toBe("\n\n\nBody\r\n");
  });

  it("projects title, tags and the remaining fields in order", () => {
    const { frontmatter } = splitMarkdownFrontmatter(
      [
        "---",
        "title: Release notes",
        "tags: [release, docs]",
        "status: draft",
        "reviewers:",
        "  - ana",
        "  - ben",
        "empty: ''",
        "---",
        "Body",
      ].join("\n"),
    );
    expect(frontmatter).toMatchObject({
      parsed: true,
      title: "Release notes",
      tags: ["release", "docs"],
      fields: [
        { key: "status", value: "draft" },
        { key: "reviewers", value: "ana, ben" },
      ],
    });
  });

  it("reads one namespace's fields as the document's own", () => {
    const { frontmatter } = splitMarkdownFrontmatter(
      "---\nkb:\n  title: Entry\n  tags:\n    - a\n  status: active\n---\nBody\n",
    );
    expect(frontmatter).toMatchObject({
      title: "Entry",
      tags: ["a"],
      fields: [{ key: "status", value: "active" }],
    });
  });

  it("accepts comma-separated tags", () => {
    const { frontmatter } = splitMarkdownFrontmatter(
      "---\ntags: one, two\n---\n",
    );
    expect(frontmatter?.tags).toEqual(["one", "two"]);
  });

  it("summarizes nested values instead of dropping them", () => {
    const { frontmatter } = splitMarkdownFrontmatter(
      "---\nstatus: active\nsource:\n  kind: slack\n---\n",
    );
    expect(frontmatter?.fields).toEqual([
      { key: "status", value: "active" },
      { key: "source", value: '{"kind":"slack"}' },
    ]);
  });

  it("keeps YAML outside the shared subset as raw text", () => {
    const text = "---\nsummary: |\n  multi\n  line\n---\nBody\n";
    const { frontmatter, body } = splitMarkdownFrontmatter(text);
    expect(frontmatter).toMatchObject({
      parsed: false,
      raw: "summary: |\n  multi\n  line",
    });
    expect(body).toBe("\n\n\n\n\nBody\n");
  });

  it("treats an unclosed opening fence as Markdown", () => {
    const text = "---\nnot frontmatter\n";
    expect(splitMarkdownFrontmatter(text)).toEqual({
      frontmatter: null,
      body: text,
    });
  });
});
