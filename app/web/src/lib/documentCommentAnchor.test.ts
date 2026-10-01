// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  rangeForPendingQuote,
  sourceLinesForRange,
} from "./documentCommentAnchor.ts";

function codeWindow(firstLine: number, text: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `<div data-code-first-line="${firstLine}"><pre><code></code></pre></div>`;
  root.querySelector("code")!.textContent = text;
  document.body.append(root);
  return root;
}

function select(root: HTMLElement, start: number, end: number): Range {
  const text = root.querySelector("code")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  return range;
}

describe("sourceLinesForRange", () => {
  it("counts code lines from the window's first file line", () => {
    const root = codeWindow(40, "alpha\nbeta\ngamma\n");
    // "beta\ngam"
    expect(sourceLinesForRange(select(root, 6, 14), root, "code")).toEqual({
      start: 41,
      end: 42,
    });
    root.remove();
  });

  it("does not count the next line when a selection ends at its start", () => {
    const root = codeWindow(1, "alpha\nbeta\ngamma");
    // "alpha\n" — a triple-click on line 1
    expect(sourceLinesForRange(select(root, 0, 6), root, "code")).toEqual({
      start: 1,
      end: 1,
    });
    root.remove();
  });

  it("ends on the blank line a selection stops after", () => {
    const root = codeWindow(1, "alpha\n\ngamma");
    // "alpha\n\n" — from line 1 to column 0 of line 3
    expect(sourceLinesForRange(select(root, 0, 7), root, "code")).toEqual({
      start: 1,
      end: 2,
    });
    root.remove();
  });

  it("counts lines across a highlighted window's line spans", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div data-code-first-line="10"><pre><code>' +
      '<span class="line"><span>one</span></span>\n' +
      '<span class="line"><span>two</span></span>\n' +
      '<span class="line"><span>three</span></span>' +
      "</code></pre></div>";
    document.body.append(root);
    const lines = root.querySelectorAll(".line span");
    const range = document.createRange();
    range.setStart(lines[1]!.firstChild!, 1);
    range.setEnd(lines[2]!.firstChild!, 2);
    expect(sourceLinesForRange(range, root, "code")).toEqual({
      start: 11,
      end: 12,
    });
    root.remove();
  });

  it("spans the Markdown blocks a selection touches", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<p data-source-line-start="3" data-source-line-end="4">one</p>' +
      '<p data-source-line-start="6" data-source-line-end="6">two</p>';
    const range = document.createRange();
    range.setStart(root.querySelector("p")!.firstChild!, 1);
    range.setEnd(root.querySelectorAll("p")[1]!.firstChild!, 2);
    expect(sourceLinesForRange(range, root, "markdown")).toEqual({
      start: 3,
      end: 6,
    });
  });
});

describe("rangeForPendingQuote", () => {
  it("falls back to the quote when the stored offsets no longer match", () => {
    const root = document.createElement("div");
    root.textContent = "inserted text; the passage";
    const range = rangeForPendingQuote(root, "the passage", {
      quote: { exact: "the passage", prefix: "", suffix: "" },
      position: { start: 0, end: 11 },
    });
    expect(range?.toString()).toBe("the passage");
  });
});
