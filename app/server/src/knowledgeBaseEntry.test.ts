import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
  KnowledgeBaseError,
  KnowledgeBaseStore,
} from "./knowledgeBaseStore.ts";
import {
  commitValidatedKnowledgeChanges,
  formatKbEntryMarkdown,
  formatKnowledgeTextFile,
  validateKbEntryMarkdown,
} from "./knowledgeBaseEntry.ts";
import { knowledgeEntryFrontmatterHelp } from "./knowledgeBaseContract.ts";

const VALID_ENTRY = `---
kb:
  schema: 1
  id: kb-globex-brief
  type: brief
  title: Globex customer brief
  status: active
  summary: Compact summary for discovery.
  tags: [customer, nebula]
  aliases:
    - Globex
  links:
    - pa://project/globex
    - pa://task/256
  createdAt: "2026-07-07T10:00:00.000Z"
  updatedAt: "2026-07-07T10:05:00.000Z"
  source:
    kind: manual
    refs:
      - https://example.test/source
      - pa://session/sess-1
  assets:
    - path: assets/source.pdf
      title: Source PDF
      mimeType: application/pdf
      kind: source
      extractPath: .kb/generated/extracts/kb-globex.txt
---
# Globex

This is a short body.
`;

const AGENT = { kind: "agent", id: "workshop", name: "Workshop" } as const;
let root: string;
let store: KnowledgeBaseStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kb-entry-test-"));
  store = new KnowledgeBaseStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("KB entry frontmatter validation", () => {
  test("accepts a complete v1 entry frontmatter document", () => {
    const result = validateKbEntryMarkdown(
      VALID_ENTRY,
      "customers/globex/index.md",
    );
    assert.equal(result.metadata.id, "kb-globex-brief");
    assert.equal(result.metadata.type, "brief");
    assert.deepEqual(result.metadata.tags, ["customer", "nebula"]);
    assert.deepEqual(result.metadata.links, [
      "pa://project/globex",
      "pa://task/256",
    ]);
    assert.equal(
      result.metadata.assets?.[0]?.extractPath,
      ".kb/generated/extracts/kb-globex.txt",
    );
  });

  test("rejects missing frontmatter with an actionable delimiter message", () => {
    assert.throws(
      () => validateKbEntryMarkdown("# Missing\n", "missing/index.md"),
      /must start with YAML frontmatter delimited by --- lines/,
    );
  });

  test("rejects common agent mistakes with exact field paths", () => {
    assert.throws(
      () =>
        validateKbEntryMarkdown(VALID_ENTRY.replace("schema: 1", "schema: 2")),
      /kb\.schema: expected the literal 1, received 2/,
    );
    // The exact mistakes from session 019f5bd9: schema "v1", an invented type, and a source.url field.
    assert.throws(
      () =>
        validateKbEntryMarkdown(VALID_ENTRY.replace("schema: 1", "schema: v1")),
      /kb\.schema: expected the literal 1, received "v1"/,
    );
    assert.throws(
      () =>
        validateKbEntryMarkdown(
          VALID_ENTRY.replace("type: brief", "type: memo"),
        ),
      /kb\.type: expected one of.*received "memo"/,
    );
    assert.throws(
      () =>
        validateKbEntryMarkdown(
          VALID_ENTRY.replace("type: brief", "type: document"),
        ),
      /kb\.type: expected one of.*received "document"/,
    );
    assert.throws(
      () =>
        validateKbEntryMarkdown(
          VALID_ENTRY.replace(
            "    kind: manual",
            "    kind: manual\n    url: https://example.test/source",
          ),
        ),
      /kb\.source\.url: unknown field; expected one of: kind, refs/,
    );
    assert.throws(
      () =>
        validateKbEntryMarkdown(
          VALID_ENTRY.replace(
            "  links:\n    - pa://project/globex\n    - pa://task/256",
            "  links: pa://project/globex",
          ),
        ),
      /kb\.links: expected an array/,
    );
    assert.throws(
      () =>
        validateKbEntryMarkdown(
          VALID_ENTRY.replace("pa://task/256", "https://example.test/not-pa"),
        ),
      /kb\.links: invalid link/,
    );
    // An approval card is a decision inside a session, not a relation: the
    // inspector has nowhere to show one, so it would vanish once saved.
    assert.throws(
      () =>
        validateKbEntryMarkdown(
          VALID_ENTRY.replace("pa://task/256", "pa://approval/appr_1"),
        ),
      /kb\.links: invalid link/,
    );
    assert.throws(
      () =>
        validateKbEntryMarkdown(
          VALID_ENTRY.replace("pa://session/sess-1", "pa://approval/appr_1"),
        ),
      /kb\.source\.refs: invalid source reference/,
    );
    assert.throws(
      () =>
        validateKbEntryMarkdown(
          VALID_ENTRY.replace("title: Globex customer brief", 'title: ""'),
        ),
      /kb\.title: expected a non-empty string/,
    );
    assert.throws(
      () =>
        validateKbEntryMarkdown(
          VALID_ENTRY.replace(
            'createdAt: "2026-07-07T10:00:00.000Z"',
            "createdAt: yesterday",
          ),
        ),
      /kb\.createdAt: expected a valid ISO-8601 UTC timestamp/,
    );
    assert.throws(
      () =>
        validateKbEntryMarkdown(
          VALID_ENTRY.replace(
            'createdAt: "2026-07-07T10:00:00.000Z"',
            'createdAt: "2026-02-31T00:00:00.000Z"',
          ),
        ),
      /kb\.createdAt: expected a valid ISO-8601 UTC timestamp/,
    );
    assert.throws(
      () =>
        validateKbEntryMarkdown(
          VALID_ENTRY.replace(
            ".kb/generated/extracts/kb-globex.txt",
            ".kb/generated/index/kb-index.json",
          ),
        ),
      /kb\.assets\[0\]\.extractPath: expected a relative path under \.kb\/generated\/extracts\//,
    );
  });

  test("canonical frontmatter help example validates so guidance cannot drift from the schema", () => {
    const help = knowledgeEntryFrontmatterHelp();
    const bodyMarker = "# Body Markdown here";
    const start = help.indexOf("---");
    const end = help.indexOf(bodyMarker);
    assert.ok(
      start >= 0 && end > start,
      "help must contain a frontmatter block and body marker",
    );
    const example = `${help.slice(start, end)}${bodyMarker}\n`;
    assert.doesNotThrow(() => validateKbEntryMarkdown(example));
  });

  test("rejects unknown fields instead of silently preserving stale metadata", () => {
    const withUnknown = VALID_ENTRY.replace(
      "  status: active\n",
      "  status: active\n  priority: high\n",
    );
    assert.throws(
      () => validateKbEntryMarkdown(withUnknown),
      /kb\.priority: unknown field/,
    );
  });
});

describe("KB entry formatting", () => {
  test("formats YAML frontmatter deterministically and wraps Markdown prose softly", () => {
    const longBody =
      "This paragraph is intentionally long so that the local Markdown formatter wraps normal prose near the preferred eighty character line length without touching the YAML schema fields or breaking any URL like https://example.test/really/long/path/that/must/stay/intact.";
    const input = VALID_ENTRY.replace(
      "# Globex\n\nThis is a short body.\n",
      `# Globex\n\n${longBody}\n\n| A | B |\n| - | - |\n| C | D |\n`,
    );
    const formatted = formatKbEntryMarkdown(input, "customers/globex/index.md");
    assert.match(
      formatted,
      /^---\nkb:\n {2}schema: 1\n {2}id: kb-globex-brief\n/m,
    );
    assert.match(
      formatted,
      / {2}links:\n {4}- "pa:\/\/project\/globex"\n {4}- "pa:\/\/task\/256"/,
    );
    assert.match(
      formatted,
      /\nThis paragraph is intentionally long so that the local Markdown formatter wraps\nnormal prose near the preferred eighty character line length/,
    );
    assert.match(
      formatted,
      /https:\/\/example\.test\/really\/long\/path\/that\/must\/stay\/intact/,
    );
    assert.match(formatted, /\| A \| B \|\n\| - \| - \|\n\| C \| D \|/);
  });

  test("keeps empty arrays parseable when formatting nested frontmatter", () => {
    const withoutAssets = VALID_ENTRY.replace(
      / {2}assets:\n {4}- path: assets\/source\.pdf\n {6}title: Source PDF\n {6}mimeType: application\/pdf\n {6}kind: source\n {6}extractPath: \.kb\/generated\/extracts\/kb-globex\.txt\n/,
      "  assets: []\n",
    );
    const formatted = formatKbEntryMarkdown(
      withoutAssets,
      "customers/globex/index.md",
    );
    assert.match(formatted, / {2}assets: \[\]/);
    assert.equal(
      validateKbEntryMarkdown(formatted, "customers/globex/index.md").metadata
        .assets?.length,
      0,
    );
  });

  test("formats JSON and JSONL text files used by KB tools", () => {
    assert.equal(
      formatKnowledgeTextFile("meta.json", '{"b":2,"a":1}'),
      '{\n  "b": 2,\n  "a": 1\n}\n',
    );
    assert.equal(
      formatKnowledgeTextFile(
        ".kb/comments/kb-x.jsonl",
        '{"b":2}\n\n{"a":1}\n',
      ),
      '{"b":2}\n{"a":1}\n',
    );
  });
});

describe("validated KB writes", () => {
  test("formats valid entry writes before committing", async () => {
    const result = await commitValidatedKnowledgeChanges(
      store,
      [
        {
          op: "write",
          path: "customers/globex/index.md",
          content: VALID_ENTRY,
        },
      ],
      {
        actor: AGENT,
        reason: "Add Globex",
        taskId: "259",
        entryIds: ["kb-globex-brief"],
      },
    );
    assert.equal(result.changedPaths[0], "customers/globex/index.md");
    const saved = await readFile(
      join(root, "customers/globex/index.md"),
      "utf8",
    );
    assert.match(saved, / {2}links:\n {4}- "pa:\/\/project\/globex"/);
  });

  test("rejects invalid frontmatter before touching the filesystem", async () => {
    await assert.rejects(
      () =>
        commitValidatedKnowledgeChanges(
          store,
          [
            {
              op: "write",
              path: "bad/index.md",
              content: VALID_ENTRY.replace("id: kb-globex-brief", "id: Bad ID"),
            },
          ],
          { actor: AGENT, reason: "Bad write" },
        ),
      KnowledgeBaseError,
    );
    assert.equal(
      existsSync(join(root, "bad/index.md")),
      false,
      "invalid write was not persisted",
    );
  });

  test("rejects duplicate kb.id values within one change set", async () => {
    await assert.rejects(
      () =>
        commitValidatedKnowledgeChanges(
          store,
          [
            { op: "write", path: "one/index.md", content: VALID_ENTRY },
            {
              op: "write",
              path: "two/index.md",
              content: VALID_ENTRY.replace(
                "Globex customer brief",
                "Second title",
              ),
            },
          ],
          { actor: AGENT, reason: "Duplicate ids" },
        ),
      /Duplicate KB entry id "kb-globex-brief" in change set/,
    );
    assert.equal(
      existsSync(join(root, "one/index.md")),
      false,
      "duplicate batch was not persisted",
    );
  });

  test("rejects kb.id collisions with existing entries but allows same-path overwrites", async () => {
    await commitValidatedKnowledgeChanges(
      store,
      [
        {
          op: "write",
          path: "customers/globex/index.md",
          content: VALID_ENTRY,
        },
      ],
      { actor: AGENT, reason: "Seed Globex" },
    );

    await commitValidatedKnowledgeChanges(
      store,
      [
        {
          op: "write",
          path: "customers/globex/index.md",
          content: VALID_ENTRY.replace(
            "Globex customer brief",
            "Globex updated brief",
          ),
        },
      ],
      { actor: AGENT, reason: "Overwrite same entry" },
    );

    await assert.rejects(
      () =>
        commitValidatedKnowledgeChanges(
          store,
          [
            {
              op: "write",
              path: "customers/duplicate/index.md",
              content: VALID_ENTRY.replace(
                "Globex customer brief",
                "Duplicate title",
              ),
            },
          ],
          { actor: AGENT, reason: "Colliding entry" },
        ),
      /collides with existing entry "customers\/globex\/index\.md"/,
    );
    assert.equal(
      existsSync(join(root, "customers/duplicate/index.md")),
      false,
      "collision was not persisted",
    );
  });
});
