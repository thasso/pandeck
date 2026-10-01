import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import {
  skillInvocationTrail,
  type SkillInvocationToolCall,
} from "./skillInvocations.ts";
import {
  skillRuntimePluginName,
  skillSetHash,
} from "./skillRuntimeMaterializer.ts";

const runtimeDir = "/data/skills-runtime";
const frozen = ["alpha", "beta"];
const hash = skillSetHash(frozen);
const plugin = skillRuntimePluginName(hash);
const skillFile = (name: string) =>
  join(runtimeDir, hash, "skills", name, "SKILL.md");

/** Every call succeeded unless the test says otherwise. */
function transcript(
  calls: Omit<SkillInvocationToolCall, "toolCallId">[],
  failed: number[] = [],
  pending: number[] = [],
) {
  const withIds = calls.map((call, i) => ({ ...call, toolCallId: `c${i}` }));
  const succeeded = new Set(
    withIds
      .filter((_, i) => !failed.includes(i) && !pending.includes(i))
      .map((call) => call.toolCallId),
  );
  return { calls: withIds, succeeded };
}

test("a plugin-qualified Skill call of a frozen name is a load", () => {
  assert.deepEqual(
    skillInvocationTrail(
      frozen,
      transcript([
        { toolName: "Skill", input: { skill: `${plugin}:beta` }, at: 1 },
        // Unqualified or foreign qualifiers name some other skill.
        { toolName: "Skill", input: { skill: "beta" }, at: 2 },
        { toolName: "Skill", input: { skill: `other-plugin:beta` }, at: 3 },
        // Not frozen: cannot be mounted under this plugin.
        { toolName: "Skill", input: { skill: `${plugin}:gamma` }, at: 4 },
        { toolName: "Skill", input: { args: "x" }, at: 5 },
        // A namespaced tool is not the CLI's native Skill.
        {
          toolName: "mcp__x__Skill",
          input: { skill: `${plugin}:alpha` },
          at: 6,
        },
      ]),
      runtimeDir,
    ),
    [{ at: 1, name: "beta", via: "skill_tool" }],
  );
});

test("a read of the materialized SKILL.md is a load on either harness", () => {
  assert.deepEqual(
    skillInvocationTrail(
      frozen,
      transcript([
        { toolName: "read", input: { path: skillFile("alpha") }, at: 1 },
        { toolName: "Read", input: { file_path: skillFile("beta") }, at: 2 },
        // A supporting file, the folder, a relative path, another layout, or
        // the library source folder are not the body entering context.
        {
          toolName: "read",
          input: { path: join(runtimeDir, hash, "skills", "alpha", "ref.md") },
          at: 3,
        },
        {
          toolName: "read",
          input: { path: join(runtimeDir, hash, "skills", "alpha") },
          at: 4,
        },
        { toolName: "read", input: { path: "skills/alpha/SKILL.md" }, at: 5 },
        {
          toolName: "read",
          input: {
            path: join(
              runtimeDir,
              "0".repeat(64),
              "skills",
              "alpha",
              "SKILL.md",
            ),
          },
          at: 6,
        },
        {
          toolName: "read",
          input: { path: "/data/skills/alpha/SKILL.md" },
          at: 7,
        },
        {
          toolName: "Bash",
          input: { command: `cat ${skillFile("alpha")}` },
          at: 8,
        },
      ]),
      runtimeDir,
    ),
    [
      { at: 1, name: "alpha", via: "read" },
      { at: 2, name: "beta", via: "read" },
    ],
  );
});

test("a failed or still-running call put nothing in context", () => {
  assert.deepEqual(
    skillInvocationTrail(
      frozen,
      transcript(
        [
          { toolName: "Skill", input: { skill: `${plugin}:alpha` }, at: 1 },
          { toolName: "read", input: { path: skillFile("beta") }, at: 2 },
          { toolName: "Skill", input: { skill: `${plugin}:beta` }, at: 3 },
        ],
        [0],
        [1],
      ),
      runtimeDir,
    ),
    [{ at: 3, name: "beta", via: "skill_tool" }],
  );
});

test("an empty freeze has no loads and the trail is bounded newest-last", () => {
  assert.deepEqual(
    skillInvocationTrail(
      [],
      transcript([
        { toolName: "Skill", input: { skill: "pa-skills-x:alpha" }, at: 1 },
      ]),
      runtimeDir,
    ),
    [],
  );
  const calls = Array.from({ length: 60 }, (_, i) => ({
    toolName: "Skill",
    input: { skill: `${plugin}:alpha` },
    at: i,
  }));
  const trail = skillInvocationTrail(frozen, transcript(calls), runtimeDir);
  assert.equal(trail.length, 50);
  assert.equal(trail[0]?.at, 10);
  assert.equal(trail.at(-1)?.at, 59);
});
