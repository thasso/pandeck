import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vitest";
import { markdownCodeSpan } from "./markdownCodeSpan.ts";

/** The one inline node a quoted text parses to, as a CommonMark reader sees it. */
function parsed(text: string) {
  const tree = fromMarkdown(`see ${markdownCodeSpan(text)} here`);
  const paragraph = tree.children[0];
  if (paragraph?.type !== "paragraph") throw new Error("not a paragraph");
  return paragraph.children;
}

describe("markdownCodeSpan", () => {
  it.each([
    "__init__.py",
    "a`__init__`b.bin",
    "`__init__.py",
    "__init__.py`",
    "``x``",
    "a ``` b",
    " padded ",
    "*bold* _em_",
  ])("reads %j back verbatim as one code span", (text) => {
    const children = parsed(text);

    expect(children).toHaveLength(3);
    expect(children[1]).toMatchObject({ type: "inlineCode", value: text });
  });

  it("uses a plain single-backtick span when nothing needs escaping", () => {
    expect(markdownCodeSpan("src/__init__.py")).toBe("`src/__init__.py`");
  });

  it("fences past the longest run and pads a leading or trailing tick", () => {
    expect(markdownCodeSpan("a`b")).toBe("``a`b``");
    expect(markdownCodeSpan("`a")).toBe("`` `a ``");
    expect(markdownCodeSpan("a ``` b")).toBe("````a ``` b````");
  });

  // approvalCardMarkdown.test.tsx renders exactly these through the web card.
  it.each([
    ["__init__.py", "`__init__.py`"],
    ["a`__init__`b.bin", "``a`__init__`b.bin``"],
    ["`__init__.bin`", "`` `__init__.bin` ``"],
  ])("quotes %j as %j", (text, span) => {
    expect(markdownCodeSpan(text)).toBe(span);
  });
});
