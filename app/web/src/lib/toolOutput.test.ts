import { describe, expect, test } from "vitest";
import { diffMarkdownWords } from "./knowledgeMarkdownDiff.ts";
import {
  bashCommand,
  diffRowsFromRuns,
  markIntralineChanges,
  parseNumberedDiff,
  parseNumberedFileOutput,
  tokenizeCode,
  type ToolDiffRow,
} from "./toolOutput.ts";

describe("parseNumberedFileOutput", () => {
  test("lifts a cat -n gutter and keeps the file's real first line", () => {
    const parsed = parseNumberedFileOutput(
      "1655\tconst a = 1;\n1656\tconst b = 2;\n",
    );
    expect(parsed).toEqual({
      startLine: 1655,
      code: "const a = 1;\nconst b = 2;",
    });
  });

  test("splits a trailing tool notice off the excerpt", () => {
    const parsed = parseNumberedFileOutput(
      "1\tone\n2\ttwo\n\n[Showing lines 1-2 of 900. Use offset=3 to continue.]",
    );
    expect(parsed?.code).toBe("one\ntwo");
    expect(parsed?.notice).toBe(
      "[Showing lines 1-2 of 900. Use offset=3 to continue.]",
    );
  });

  test("declines un-numbered output (pi read) rather than mangling it", () => {
    expect(parseNumberedFileOutput("# Heading\n\nSome prose.\n")).toBeNull();
  });

  test("declines numbers that are not a consecutive gutter", () => {
    // Real file content that happens to start with digits must not be stripped.
    expect(parseNumberedFileOutput("1\tone\n7\tseven\n")).toBeNull();
  });
});

describe("parseNumberedDiff", () => {
  const diff = [
    "      ...",
    "  600   atlassianTokenConfigured: boolean;",
    "  601 }",
    "+ 604 export interface JiraLinkedIssue {",
    "- 605 removed line",
  ].join("\n");

  test("keeps the provider's real line numbers and row kinds", () => {
    expect(parseNumberedDiff(diff)).toEqual([
      { kind: "gap", text: "…" },
      {
        kind: "context",
        line: 600,
        text: "  atlassianTokenConfigured: boolean;",
      },
      { kind: "context", line: 601, text: "}" },
      { kind: "add", line: 604, text: "export interface JiraLinkedIssue {" },
      { kind: "del", line: 605, text: "removed line" },
    ]);
  });

  test("returns null for a diff that is not line-numbered", () => {
    expect(parseNumberedDiff("+added\n-removed\n")).toBeNull();
    expect(parseNumberedDiff("")).toBeNull();
  });
});

test("diffRowsFromRuns flattens runs without inventing line numbers", () => {
  const rows = diffRowsFromRuns([
    { type: "equal", lines: ["keep"] },
    { type: "del", lines: ["old"] },
    { type: "add", lines: ["new"] },
  ]);
  expect(rows).toEqual([
    { kind: "context", text: "keep" },
    { kind: "del", text: "old" },
    { kind: "add", text: "new" },
  ]);
  expect(rows.every((row) => row.line === undefined)).toBe(true);
});

test("bashCommand reads the executed command from the call args", () => {
  expect(bashCommand({ command: "ls -la" })).toBe("ls -la");
  expect(bashCommand({ cmd: "pnpm test" })).toBe("pnpm test");
  expect(bashCommand({ command: "   " })).toBeNull();
  expect(bashCommand(null)).toBeNull();
});

describe("markIntralineChanges", () => {
  const mark = (rows: ToolDiffRow[]) =>
    markIntralineChanges(rows, (oldText, newText) =>
      diffMarkdownWords(oldText, newText, { tokenize: tokenizeCode }),
    );

  test("marks what changed inside a replaced line, on both sides", () => {
    const rows = mark([
      { kind: "del", line: 10, text: "const value = oldName(1);" },
      { kind: "add", line: 10, text: "const value = newName(1);" },
    ]);
    expect(rows[0]?.segments).toEqual([
      { text: "const value = ", changed: false },
      { text: "oldName", changed: true },
      { text: "(1);", changed: false },
    ]);
    expect(rows[1]?.segments).toEqual([
      { text: "const value = ", changed: false },
      { text: "newName", changed: true },
      { text: "(1);", changed: false },
    ]);
  });

  test("pairs removed and added lines positionally within one run couple", () => {
    const rows = mark([
      { kind: "context", text: "keep" },
      { kind: "del", text: "alpha one" },
      { kind: "del", text: "beta one" },
      { kind: "add", text: "alpha two" },
      { kind: "add", text: "beta two" },
      { kind: "context", text: "keep" },
    ]);
    expect(rows[1]?.segments?.some((s) => s.changed && s.text === "one")).toBe(
      true,
    );
    expect(rows[4]?.segments?.some((s) => s.changed && s.text === "two")).toBe(
      true,
    );
    expect(rows[0]?.segments).toBeUndefined();
  });

  test("leaves pure insertions and wholly different lines whole-line coloured", () => {
    const inserted = mark([{ kind: "add", line: 4, text: "brand new line" }]);
    expect(inserted[0]?.segments).toBeUndefined();

    const unrelated = mark([
      { kind: "del", text: "aaaa bbbb cccc" },
      { kind: "add", text: "wwww xxxx yyyy" },
    ]);
    expect(unrelated[0]?.segments).toBeUndefined();
    expect(unrelated[1]?.segments).toBeUndefined();
  });
});
