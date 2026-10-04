/**
 * Task 282: `AgentTool` has exactly two model-visible guidance surfaces —
 * `description` and the `parameters` prose — and BOTH harnesses render both,
 * for eager and deferred tools alike.
 *
 *   pnpm --filter @assistant/server test src/tools/toolGuidanceSurface.test.ts
 *
 * `promptSnippet`/`promptGuidelines` are deleted as concepts. The type system
 * already rejects them, so what this file adds is the guard against bringing
 * the CHANNEL back: a cast at a call site, a new pi-only field, or a
 * hand-folded "Guidelines:" block glued onto a description (which is how the pi
 * adapter used to smuggle deferred guidance past the prompt-cache prefix).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { AGENT_TYPES } from "../agentTypes.ts";
import type { AgentType } from "@assistant/shared";
import type { AgentTool } from "../mcp/tool.ts";
import { agentToolsFor, toolGroupsFor } from "./catalog.ts";

const AGENT_TYPE_LIST = Object.keys(AGENT_TYPES) as AgentType[];
const SERVER_SRC = fileURLToPath(new URL("..", import.meta.url));

const DELETED_FIELDS = ["promptSnippet", "promptGuidelines"] as const;

/**
 * Files that legitimately still NAME the deleted fields: pi's own builtins keep
 * prompt extras and the inventory measures them, and a few call sites say in
 * prose that the fields are gone. Every entry is verified to still need its
 * exemption below, so an allowlist cannot outlive the mention it covers —
 * a stale entry is exactly where the deleted channel could quietly come back.
 */
const ALLOWED_MENTIONS = new Set([
  // Says the fields are deleted, and why there is no prompt-extras channel.
  join(SERVER_SRC, "mcp", "tool.ts"),
  // The pi seam: pi's builtins and its buildSystemPrompt signature keep both.
  join(SERVER_SRC, "piSdk", "piPromptMeasure.ts"),
  join(SERVER_SRC, "piSdk", "agentToolAdapter.ts"),
  join(SERVER_SRC, "piSdk", "agentToolAdapter.test.ts"),
  join(SERVER_SRC, "piSdk", "toolActivation.test.ts"),
  join(SERVER_SRC, "promptInventory.ts"),
  join(SERVER_SRC, "promptInventory.test.ts"),
  // This file.
  join(SERVER_SRC, "tools", "toolGuidanceSurface.test.ts"),
]);

function typescriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...typescriptFiles(path));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(path);
  }
  return out;
}

function allTools(): AgentTool[] {
  const byName = new Map<string, AgentTool>();
  for (const agentType of AGENT_TYPE_LIST)
    for (const tool of agentToolsFor(agentType)) byName.set(tool.name, tool);
  return [...byName.values()];
}

describe("tool guidance surface", () => {
  test("no tool carries a deleted prompt-extras field at runtime", () => {
    for (const tool of allTools())
      for (const field of DELETED_FIELDS)
        assert.ok(
          !(field in tool),
          `${tool.name} reintroduced ${field}: tool rules belong in description or parameters prose, which both harnesses render`,
        );
  });

  test("no exemption outlives the mention it covers", () => {
    // Without this, deleting the last mention in an allowlisted file silently
    // leaves a hole the fold could come back through.
    const stale = [...ALLOWED_MENTIONS].filter((path) => {
      const source = readFileSync(path, "utf8");
      return !DELETED_FIELDS.some((field) => source.includes(field));
    });
    assert.deepEqual(
      stale,
      [],
      "these files no longer name a deleted field — drop them from ALLOWED_MENTIONS",
    );
  });

  test("the server source does not reintroduce the fields", () => {
    const offenders: string[] = [];
    for (const path of typescriptFiles(SERVER_SRC)) {
      if (ALLOWED_MENTIONS.has(path)) continue;
      const source = readFileSync(path, "utf8");
      for (const field of DELETED_FIELDS)
        if (source.includes(field)) offenders.push(`${path} (${field})`);
    }
    assert.deepEqual(
      offenders,
      [],
      "promptSnippet/promptGuidelines are deleted concepts — author the rule in the tool's description or schema instead",
    );
  });

  test("no description carries a folded guidelines block", () => {
    for (const tool of allTools())
      assert.doesNotMatch(
        tool.description,
        /\n\s*Guidelines:\s*\n\s*-/,
        `${tool.name}: guidance belongs in the description's prose, not a bullet block folded onto it`,
      );
  });

  // The floor is deliberately low: the proxied browser_* tools are one-liners
  // ("Press a keyboard key in the browser."), and that IS their whole contract.
  // This only catches a tool left with nothing after its guidance was deleted.
  test("every tool states something in its description", () => {
    for (const agentType of AGENT_TYPE_LIST)
      for (const group of toolGroupsFor(agentType))
        for (const tool of group.tools)
          assert.ok(
            tool.description.trim().length >= 30,
            `${tool.name}: too little description to be the only guidance surface`,
          );
  });
});
