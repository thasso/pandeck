/**
 * The `AGENT.md` content rule and renderer (`docs/agent-definitions.md`
 * "The file"): one rule for scanning and authoring, a deterministic rendering
 * that the rule reads back, and the kind's size bound applied by the core.
 *
 * Run with:
 *   pnpm --filter @assistant/server test src/agents/agentLibrary.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
  formatAgentManifest,
  MAX_AGENT_MANIFEST_BYTES,
  parseAgentManifest,
  scanAgentLibrary,
} from "./agentLibrary.ts";

const valid = [
  "---",
  "name: test-reviewer",
  'description: "Checks that new tests fail without the code change."',
  "persona: developer",
  "model: opus",
  "effort: high",
  "tools:",
  "  deny: [worktree_push, bash]",
  "skills: [castlabs-ui]",
  "---",
  "",
  "You are a test reviewer.",
  "",
].join("\n");

function issuesOf(source: string): string[] {
  const parsed = parseAgentManifest(source, "x/AGENT.md");
  return parsed.ok ? [] : parsed.issues.map((issue) => issue.error);
}

describe("the AGENT.md content rule", () => {
  test("peer-turns is bounded and round-trips", () => {
    for (const value of ["0", "17", "2.5", '"4"'])
      assert.match(
        issuesOf(valid.replace("effort: high", `peer-turns: ${value}`)).join(
          " ",
        ),
        /peer-turns/,
      );
    const parsed = parseAgentManifest(
      valid.replace("effort: high", "peer-turns: 10"),
      "x/AGENT.md",
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.manifest.peerTurns, 10);
    const roundTrip = parseAgentManifest(
      formatAgentManifest(parsed.manifest),
      "x/AGENT.md",
    );
    assert.ok(roundTrip.ok);
    assert.equal(roundTrip.manifest.peerTurns, 10);
  });
  test("a complete definition parses into typed fields", () => {
    const parsed = parseAgentManifest(valid, "test-reviewer/AGENT.md");
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.manifest, {
      name: "test-reviewer",
      description: "Checks that new tests fail without the code change.",
      body: "\nYou are a test reviewer.\n",
      persona: "developer",
      models: ["opus"],
      effort: "high",
      denyTools: ["worktree_push", "bash"],
      skills: ["castlabs-ui"],
    });
  });

  test("the optional fields may be left out", () => {
    const parsed = parseAgentManifest(
      "---\nname: helper\ndescription: Helps.\npersona: assistant\nmodel: sonnet\n---\n\nHelp.\n",
      "helper/AGENT.md",
    );
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.manifest.denyTools, []);
    assert.deepEqual(parsed.manifest.skills, []);
    assert.equal("effort" in parsed.manifest, false);
    assert.equal("inheritGrants" in parsed.manifest, false);
  });

  test("inheritGrants is true or false, and nothing else", () => {
    for (const value of [true, false]) {
      const parsed = parseAgentManifest(
        valid.replace("effort: high", `effort: high\ninheritGrants: ${value}`),
        "x/AGENT.md",
      );
      assert.ok(parsed.ok, parsed.ok ? "" : JSON.stringify(parsed.issues));
      assert.equal(parsed.manifest.inheritGrants, value);
    }
    for (const value of ['"no"', "no", "1", '"false"'])
      assert.match(
        issuesOf(
          valid.replace(
            "effort: high",
            `effort: high\ninheritGrants: ${value}`,
          ),
        ).join(),
        /inheritGrants must be true or false/,
      );
  });

  test("every broken field is reported at once, and the name is still recovered", () => {
    const parsed = parseAgentManifest(
      [
        "---",
        "name: broken",
        "description: Broken.",
        "persona: wizard",
        "model: has spaces",
        "effort: ludicrous",
        "tools:",
        "  deny: [Not-A-Tool]",
        "  allow: [bash]",
        "skills: [castlabs-ui]",
        "colour: red",
        "---",
        "",
        "   ",
      ].join("\n"),
      "broken/AGENT.md",
    );
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.name, "broken");
    assert.ok(parsed.issues.every((issue) => issue.code === "invalid-field"));
    const text = parsed.issues.map((issue) => issue.error).join("\n");
    for (const expected of [
      /Unknown frontmatter key "colour"/,
      /persona must be one of developer, assistant/,
      /model must be a model alias or id/,
      /effort must be one of/,
      /tools\.deny must be a list/,
      /Unknown key "tools\.allow"/,
      /skills may be set only for persona developer/,
      /body must hold the agent's role instructions/,
    ])
      assert.match(text, expected);
  });

  test("lists may not repeat a name", () => {
    assert.match(
      issuesOf(valid.replace("[worktree_push, bash]", "[bash, bash]")).join(),
      /tools\.deny lists a name twice/,
    );
  });

  test("model is one model or a list of them, the first being the default", () => {
    const listed = parseAgentManifest(
      valid.replace("model: opus", 'model: [openai-codex/gpt-6.1-sol, "opus"]'),
      "x/AGENT.md",
    );
    assert.ok(listed.ok);
    assert.deepEqual(listed.manifest.models, [
      "openai-codex/gpt-6.1-sol",
      "opus",
    ]);
    for (const [model, error] of [
      ["[]", /model must be a model alias or id, or a list of 1-8/],
      ["[opus, Opus]", /model lists a model twice/],
      ["[opus, has spaces]", /model must be a model alias or id/],
      [
        `[${Array.from({ length: 9 }, (_, at) => `m${at}`).join(", ")}]`,
        /a list of 1-8 of them/,
      ],
    ] as const)
      assert.match(
        issuesOf(valid.replace("model: opus", `model: ${model}`)).join(),
        error,
      );
  });

  test("one model renders as a plain value, several as a list, and both read back", () => {
    const base = {
      name: "reviewer",
      description: "Reviews.",
      persona: "developer" as const,
      body: "Review.",
    };
    const one = formatAgentManifest({ ...base, models: ["opus"] });
    assert.match(one, /^model: "opus"$/m);
    const several = formatAgentManifest({
      ...base,
      models: ["openai-codex/gpt-6.1-sol", "opus"],
    });
    assert.match(several, /^model: \[openai-codex\/gpt-6\.1-sol, opus\]$/m);
    const parsed = parseAgentManifest(several, "reviewer/AGENT.md");
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.manifest.models, [
      "openai-codex/gpt-6.1-sol",
      "opus",
    ]);
  });

  test("names the YAML subset would read as numbers or booleans render as strings", () => {
    const source = formatAgentManifest({
      name: "123",
      description: "Numbers.",
      persona: "developer",
      models: ["opus"],
      denyTools: ["true", "null"],
      skills: ["true", "123", "castlabs-ui"],
      body: "Body.",
    });
    const parsed = parseAgentManifest(source, "123/AGENT.md");
    assert.ok(parsed.ok, parsed.ok ? "" : JSON.stringify(parsed.issues));
    assert.equal(parsed.manifest.name, "123");
    assert.deepEqual(parsed.manifest.denyTools, ["true", "null"]);
    assert.deepEqual(parsed.manifest.skills, ["true", "123", "castlabs-ui"]);
    // Ordinary names stay plain, so ordinary files do not change.
    assert.match(source, /castlabs-ui\]/);
  });

  test("a description or model holding a line separator renders and reads back", () => {
    const source = formatAgentManifest({
      name: "spaced",
      description: "One\u2028two",
      persona: "assistant",
      models: ["opus"],
      body: "Body.",
    });
    const parsed = parseAgentManifest(source, "spaced/AGENT.md");
    assert.ok(parsed.ok);
    assert.equal(parsed.manifest.description, "One\u2028two");
  });

  test("the renderer's output is exactly what the rule reads back", () => {
    const input = {
      name: "test-reviewer",
      description: 'Checks tests: "fail first", # always',
      persona: "developer" as const,
      models: ["gpt-6.1-sol"],
      effort: "xhigh" as const,
      denyTools: ["worktree_commit", "edit"],
      skills: ["castlabs-ui"],
      inheritGrants: false,
      body: "\n\nRole instructions.\n\n",
    };
    const source = formatAgentManifest(input);
    const parsed = parseAgentManifest(source, "test-reviewer/AGENT.md");
    assert.ok(parsed.ok);
    assert.equal(parsed.manifest.description, input.description);
    assert.deepEqual(parsed.manifest.models, input.models);
    assert.equal(parsed.manifest.effort, "xhigh");
    assert.deepEqual(parsed.manifest.denyTools, input.denyTools);
    assert.deepEqual(parsed.manifest.skills, input.skills);
    assert.equal(parsed.manifest.inheritGrants, false);
    assert.equal(parsed.manifest.body.trim(), "Role instructions.");
    assert.equal(formatAgentManifest(input), source, "deterministic");
  });
});

describe("the agents library scan", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-library-test-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("lists valid AGENT.md folders and holds a definition to its size bound", async () => {
    await mkdir(join(root, "test-reviewer"));
    await writeFile(join(root, "test-reviewer", "AGENT.md"), valid);
    await mkdir(join(root, "huge"));
    await writeFile(
      join(root, "huge", "AGENT.md"),
      valid
        .replace("name: test-reviewer", "name: huge")
        .replace(
          "You are a test reviewer.",
          "x".repeat(MAX_AGENT_MANIFEST_BYTES),
        ),
    );
    await mkdir(join(root, "a-skill"));
    await writeFile(
      join(root, "a-skill", "SKILL.md"),
      "---\nname: a-skill\ndescription: Not an agent.\n---\n",
    );

    const scan = await scanAgentLibrary(root);
    assert.deepEqual(
      scan.entries.map((entry) => entry.path),
      ["test-reviewer/AGENT.md"],
    );
    assert.deepEqual(
      scan.diagnostics.map(({ path, code }) => `${path}:${code}`),
      ["a-skill/AGENT.md:missing-manifest", "huge/AGENT.md:manifest-too-large"],
    );
  });
});
