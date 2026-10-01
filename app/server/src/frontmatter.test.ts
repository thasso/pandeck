import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { parseYamlSubset, splitYamlFrontmatter } from "./frontmatter.ts";

describe("YAML frontmatter", () => {
  test("splits LF and CRLF frontmatter without changing the body", () => {
    assert.deepEqual(
      splitYamlFrontmatter("---\ntitle: LF\n---\n# Body\n", "lf.md"),
      { yaml: "title: LF", body: "# Body\n" },
    );
    assert.deepEqual(
      splitYamlFrontmatter(
        "---\r\ntitle: CRLF\r\n---\r\n# Body\r\n",
        "crlf.md",
      ),
      { yaml: "title: CRLF", body: "# Body\r\n" },
    );
  });

  test("uses the first valid closing fence and preserves the remaining bytes", () => {
    assert.deepEqual(
      splitYamlFrontmatter(
        "---\ntitle: first\n---\nbody\n---\nnot frontmatter\n",
        "nested.md",
      ),
      { yaml: "title: first", body: "body\n---\nnot frontmatter\n" },
    );
  });

  test("rejects missing and unterminated fences with an actionable error", () => {
    assert.throws(
      () => splitYamlFrontmatter("\n---\ntitle: late\n---\n", "late.md"),
      /Invalid frontmatter in late\.md: document must start with YAML frontmatter delimited by --- lines/,
    );
    assert.throws(
      () => splitYamlFrontmatter("---\ntitle: open\n", "open.md"),
      /Invalid frontmatter in open\.md: document must start with YAML frontmatter delimited by --- lines/,
    );
  });

  test("parses nested maps, sequences, inline arrays, and scalar values", () => {
    assert.deepEqual(
      parseYamlSubset(
        `name: "Example skill"
enabled: true
count: 2
empty: null
tags: [one, "two, three", 'it''s']
steps:
  - name: first
    values:
      - alpha
      - beta
metadata:
  note: plain text # a comment
`,
        "SKILL.md frontmatter",
      ),
      {
        name: "Example skill",
        enabled: true,
        count: 2,
        empty: null,
        tags: ["one", "two, three", "it's"],
        steps: [{ name: "first", values: ["alpha", "beta"] }],
        metadata: { note: "plain text" },
      },
    );
  });

  test("reports duplicate keys, tabs, and malformed indentation with path and line", () => {
    assert.throws(
      () => parseYamlSubset("name: one\nname: two\n", "duplicate.yml"),
      /Invalid YAML in duplicate\.yml line 2: duplicate key "name"/,
    );
    assert.throws(
      () => parseYamlSubset("name:\n\tvalue: no\n", "tabs.yml"),
      /Invalid YAML in tabs\.yml line 2: tabs are not supported; use spaces/,
    );
    assert.throws(
      () => parseYamlSubset("name:\n   value: no\n", "indent.yml"),
      /Invalid YAML in indent\.yml line 2: expected 2 spaces of indentation/,
    );
  });
});
