import { describe, expect, test } from "vitest";
import { parseYamlSubset, splitYamlFrontmatter } from "./frontmatter.ts";

describe("YAML frontmatter", () => {
  test("splits LF and CRLF frontmatter without changing the body", () => {
    expect(
      splitYamlFrontmatter("---\ntitle: LF\n---\n# Body\n", "lf.md"),
    ).toEqual({ yaml: "title: LF", body: "# Body\n" });
    expect(
      splitYamlFrontmatter(
        "---\r\ntitle: CRLF\r\n---\r\n# Body\r\n",
        "crlf.md",
      ),
    ).toEqual({ yaml: "title: CRLF", body: "# Body\r\n" });
  });

  test("uses the first valid closing fence and preserves the remaining bytes", () => {
    expect(
      splitYamlFrontmatter(
        "---\ntitle: first\n---\nbody\n---\nnot frontmatter\n",
        "nested.md",
      ),
    ).toEqual({ yaml: "title: first", body: "body\n---\nnot frontmatter\n" });
  });

  test("rejects missing and unterminated fences with an actionable error", () => {
    expect(() =>
      splitYamlFrontmatter("\n---\ntitle: late\n---\n", "late.md"),
    ).toThrow(
      /Invalid frontmatter in late\.md: document must start with YAML frontmatter delimited by --- lines/,
    );
    expect(() => splitYamlFrontmatter("---\ntitle: open\n", "open.md")).toThrow(
      /Invalid frontmatter in open\.md: document must start with YAML frontmatter delimited by --- lines/,
    );
  });

  test("parses nested maps, sequences, inline arrays, and scalar values", () => {
    expect(
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
    ).toEqual({
      name: "Example skill",
      enabled: true,
      count: 2,
      empty: null,
      tags: ["one", "two, three", "it's"],
      steps: [{ name: "first", values: ["alpha", "beta"] }],
      metadata: { note: "plain text" },
    });
  });

  test("reports duplicate keys, tabs, and malformed indentation with path and line", () => {
    expect(() =>
      parseYamlSubset("name: one\nname: two\n", "duplicate.yml"),
    ).toThrow(/Invalid YAML in duplicate\.yml line 2: duplicate key "name"/);
    expect(() => parseYamlSubset("name:\n\tvalue: no\n", "tabs.yml")).toThrow(
      /Invalid YAML in tabs\.yml line 2: tabs are not supported; use spaces/,
    );
    expect(() =>
      parseYamlSubset("name:\n   value: no\n", "indent.yml"),
    ).toThrow(
      /Invalid YAML in indent\.yml line 2: expected 2 spaces of indentation/,
    );
  });
});
