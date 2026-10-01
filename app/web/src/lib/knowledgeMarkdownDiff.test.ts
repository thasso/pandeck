import { describe, expect, it } from "vitest";
import {
  buildRenderedDiffMarkdown,
  diffMarkdownLines,
  diffMarkdownWords,
  stripFrontmatter,
} from "./knowledgeMarkdownDiff.ts";

describe("stripFrontmatter", () => {
  it("removes a leading YAML frontmatter block", () => {
    const text = "---\ntitle: X\nid: y\n---\n\n# Body\n\ntext";
    expect(stripFrontmatter(text)).toBe("# Body\n\ntext");
  });

  it("leaves content without frontmatter unchanged", () => {
    expect(stripFrontmatter("# Body\n\ntext")).toBe("# Body\n\ntext");
    expect(stripFrontmatter("--- not a fence")).toBe("--- not a fence");
  });
});

describe("diffMarkdownLines", () => {
  it("marks added and removed lines while keeping shared context equal", () => {
    const runs = diffMarkdownLines("a\nb\nc", "a\nB\nc");
    expect(runs).toEqual([
      { type: "equal", lines: ["a"] },
      { type: "del", lines: ["b"] },
      { type: "add", lines: ["B"] },
      { type: "equal", lines: ["c"] },
    ]);
  });

  it("treats a pure addition as one add run", () => {
    const runs = diffMarkdownLines("a\nb", "a\nx\ny\nb");
    expect(runs).toEqual([
      { type: "equal", lines: ["a"] },
      { type: "add", lines: ["x", "y"] },
      { type: "equal", lines: ["b"] },
    ]);
  });

  it("handles creation from empty text", () => {
    expect(diffMarkdownLines("", "hello\nworld")).toEqual([
      { type: "add", lines: ["hello", "world"] },
    ]);
  });

  it("handles deletion to empty text", () => {
    expect(diffMarkdownLines("hello\nworld", "")).toEqual([
      { type: "del", lines: ["hello", "world"] },
    ]);
  });

  it("returns only equal runs when nothing changed", () => {
    expect(diffMarkdownLines("same\ntext", "same\ntext")).toEqual([
      { type: "equal", lines: ["same", "text"] },
    ]);
  });

  it("normalizes CRLF line endings", () => {
    const runs = diffMarkdownLines("a\r\nb", "a\r\nc");
    expect(runs).toEqual([
      { type: "equal", lines: ["a"] },
      { type: "del", lines: ["b"] },
      { type: "add", lines: ["c"] },
    ]);
  });

  it("hides whitespace-only line changes when ignoreWhitespace is set", () => {
    const oldText = "keep\n  indented";
    const newText = "keep\nindented";
    expect(
      diffMarkdownLines(oldText, newText, { ignoreWhitespace: true }),
    ).toEqual([{ type: "equal", lines: ["keep", "  indented"] }]);
    // Without the option, the reindented line is a real change.
    expect(
      diffMarkdownLines(oldText, newText, { ignoreWhitespace: false }),
    ).toEqual([
      { type: "equal", lines: ["keep"] },
      { type: "del", lines: ["  indented"] },
      { type: "add", lines: ["indented"] },
    ]);
  });
});

describe("diffMarkdownWords", () => {
  it("produces inline word-level segments preserving spacing", () => {
    const segments = diffMarkdownWords("the quick fox", "the slow fox");
    expect(segments).toEqual([
      { type: "equal", text: "the " },
      { type: "del", text: "quick" },
      { type: "add", text: "slow" },
      { type: "equal", text: " fox" },
    ]);
  });

  it("treats whitespace-only differences as equal when ignoreWhitespace is set", () => {
    const segments = diffMarkdownWords("a  b", "a b", {
      ignoreWhitespace: true,
    });
    expect(segments.every((segment) => segment.type === "equal")).toBe(true);
  });
});

describe("buildRenderedDiffMarkdown", () => {
  it("marks intra-paragraph word changes inline while keeping surrounding text", () => {
    const { markdown, changed } = buildRenderedDiffMarkdown(
      "The quick brown fox",
      "The quick red fox",
    );
    expect(changed).toBe(true);
    expect(markdown).toBe("The quick <del>brown</del><ins>red</ins> fox");
  });

  it("keeps a heading's block marker outside the change mark", () => {
    const { markdown } = buildRenderedDiffMarkdown(
      "## Introduction",
      "## Overview",
    );
    expect(markdown).toBe("## <del>Introduction</del><ins>Overview</ins>");
  });

  it("hoists the list marker outside the mark for a wholly added line", () => {
    const { markdown } = buildRenderedDiffMarkdown(
      "- one\n- two",
      "- one\n- two\n- three",
    );
    expect(markdown).toBe("- one\n- two\n- <ins>three</ins>");
  });

  it("wraps a removed paragraph in <del> and preserves blank-line structure", () => {
    const { markdown } = buildRenderedDiffMarkdown("Keep\n\nGone", "Keep");
    expect(markdown).toBe("Keep\n\n<del>Gone</del>");
  });

  it("reports no change for identical content", () => {
    expect(buildRenderedDiffMarkdown("same\ntext", "same\ntext").changed).toBe(
      false,
    );
  });
});
