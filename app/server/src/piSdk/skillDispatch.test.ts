import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, test } from "vitest";
import { skillSetHash } from "../skills/skillRuntimeMaterializer.ts";
import { piSkillDispatch } from "./skillDispatch.ts";

let runtimeDir: string;
const frozen = ["alpha", "beta"];

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "pi-skill-dispatch-"));
});

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

const runtimeFile = (name: string) =>
  join(runtimeDir, skillSetHash(frozen), "skills", name, "SKILL.md");

function loader(skills: Array<{ name: string; filePath: string }>) {
  return {
    getSkills: () => ({ skills, diagnostics: [] }),
  } as unknown as Parameters<typeof piSkillDispatch>[0];
}

test("dispatches a frozen skill loaded from this session's runtime", () => {
  assert.deepEqual(
    piSkillDispatch(
      loader([{ name: "alpha", filePath: runtimeFile("alpha") }]),
      frozen,
      "alpha",
      runtimeDir,
    ),
    { command: "/skill:alpha" },
  );
});

test("refuses a name the session did not freeze or pi did not load", () => {
  const loaded = loader([
    { name: "alpha", filePath: runtimeFile("alpha") },
    { name: "gamma", filePath: "/repo/.pi/skills/gamma/SKILL.md" },
  ]);
  assert.deepEqual(piSkillDispatch(loaded, frozen, "gamma", runtimeDir), {
    refused: "/gamma is not loaded in this session.",
  });
  assert.deepEqual(piSkillDispatch(loaded, frozen, "beta", runtimeDir), {
    refused: "/beta is not loaded in this session.",
  });
});

test("refuses a repository skill that shadows the frozen one", () => {
  // pi keeps the FIRST skill of a name, so a checkout's `.pi/skills/alpha`
  // would be the one `/skill:alpha` expands.
  const shadowed = loader([
    { name: "alpha", filePath: "/repo/.pi/skills/alpha/SKILL.md" },
  ]);
  assert.deepEqual(piSkillDispatch(shadowed, frozen, "alpha", runtimeDir), {
    refused:
      "/alpha clashes with a repository skill of the same name in this checkout. Rename one of them, or ask the agent to load it.",
  });
  // Another skill set's runtime copy is not this session's file either.
  const otherSet = loader([
    {
      name: "alpha",
      filePath: join(runtimeDir, "other", "skills", "alpha", "SKILL.md"),
    },
  ]);
  assert.equal(
    "refused" in piSkillDispatch(otherSet, frozen, "alpha", runtimeDir),
    true,
  );
});

/**
 * Boundary pin on the installed pi (`_expandSkillCommand`): the name ends at
 * the first SPACE, so the adapter's `"/skill:alpha \n\nctx"` expands with the
 * context after the block, while the same text without that space would be
 * one unknown name and pass through unexpanded.
 */
test("pi expands a name-only command with inline context only after a space", () => {
  const filePath = runtimeFile("alpha");
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, "---\nname: alpha\ndescription: A\n---\nDo alpha.\n");
  const self = {
    resourceLoader: loader([
      { name: "alpha", filePath, baseDir: join(filePath, "..") } as never,
    ]),
    _extensionRunner: { emitError: () => {} },
  };
  const expand = (
    AgentSession.prototype as unknown as {
      _expandSkillCommand(this: unknown, text: string): string;
    }
  )._expandSkillCommand;
  const expanded = expand.call(self, "/skill:alpha \n\nctx");
  assert.match(
    expanded,
    new RegExp(
      `^<skill name="alpha" location="${filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">\\n`,
    ),
  );
  assert.ok(expanded.endsWith("Do alpha.\n</skill>\n\nctx"));
  assert.equal(
    expand.call(self, "/skill:alpha the parser\n\nctx").split("</skill>")[1],
    "\n\nthe parser\n\nctx",
  );
  assert.equal(expand.call(self, "/skill:alpha\n\nctx"), "/skill:alpha\n\nctx");
});
