/**
 * The harness boundary ratchet (`docs/agent-harnesses.md`).
 *
 * App code reaches the engine folders (`piSdk/`, `claudeSdk/`) only through
 * `harnesses/`, and branches on capabilities rather than on a harness id. The
 * code is migrating towards that, so the two lists below pin every exception
 * that still exists. Both checks are exact: a new exception fails, and so does
 * an entry the code no longer needs, which keeps the lists shrinking with the
 * migration instead of drifting above reality.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

/** Folders that may reach the engines directly. */
const EXEMPT_FOLDER = /^(?:piSdk|claudeSdk|harnesses|test)\//;

const ENGINE_FOLDER = /^(?:piSdk|claudeSdk)\//;

/**
 * Every engine module each app module still imports, as a path under
 * `src/`. Delete an entry in the change that removes the import.
 */
const ENGINE_IMPORT_EXCEPTIONS: Record<string, string[]> = {
  "commitAgent.ts": ["claudeSdk/oneShot.ts", "piSdk/oneShot.ts"],
  "commitWorkflow.ts": ["piSdk/index.ts"],
  "connection.ts": [
    "claudeSdk/ClaudeSdkSession.ts",
    "claudeSdk/claudeSdkStore.ts",
    "claudeSdk/modelSettings.ts",
    "piSdk/PiLiveSession.ts",
    "piSdk/models.ts",
  ],
  "dayScan/synthesisModel.ts": ["claudeSdk/oneShot.ts", "piSdk/oneShot.ts"],
  "hub.ts": [
    "claudeSdk/ClaudeSdkSession.ts",
    "claudeSdk/claudeSdkStore.ts",
    "piSdk/PiLiveSession.ts",
    "piSdk/index.ts",
    "piSdk/piStore.ts",
  ],
  "index.ts": [
    "claudeSdk/modelSettings.ts",
    "piSdk/models.ts",
    "piSdk/openaiUsageQuery.ts",
    "piSdk/toolBinaries.ts",
  ],
  "memory/memoryProcessor.ts": [
    "claudeSdk/oneShot.ts",
    "piSdk/models.ts",
    "piSdk/oneShot.ts",
  ],
  "openaiResetAutoRedeem.ts": ["piSdk/openaiUsageQuery.ts"],
  "pdfClaudeFallback.ts": ["claudeSdk/oneShot.ts"],
  "peerSpawnRuntimes.ts": ["claudeSdk/modelSettings.ts", "piSdk/models.ts"],
  "permanentAssistant.ts": ["piSdk/oneShot.ts"],
  "prAgent.ts": ["claudeSdk/oneShot.ts", "piSdk/oneShot.ts"],
  "promptBudgets.ts": ["piSdk/piPromptMeasure.ts"],
  "promptInventory.ts": [
    "claudeSdk/options.ts",
    "piSdk/backgroundWorkToolDefinitions.ts",
    "piSdk/piPromptMeasure.ts",
  ],
  "promptRefinement.ts": ["claudeSdk/oneShot.ts", "piSdk/oneShot.ts"],
  "session/adapters/claudeSdk.ts": ["claudeSdk/modelSettings.ts"],
  "sessionNaming.ts": ["claudeSdk/oneShot.ts", "piSdk/oneShot.ts"],
  "sessionSpawn.ts": ["piSdk/models.ts"],
  "sessions.ts": ["claudeSdk/modelSettings.ts"],
  "taskIntakeAgent.ts": ["claudeSdk/oneShot.ts", "piSdk/oneShot.ts"],
  "taskOverhead.ts": ["claudeSdk/claudeSdkRecords.ts"],
  "tools/google/meetingMinutesScannerTools.ts": [
    "claudeSdk/oneShot.ts",
    "piSdk/oneShot.ts",
  ],
  "usageCache.ts": ["claudeSdk/usageQuery.ts", "piSdk/openaiUsageQuery.ts"],
  "viewSession.ts": [
    "claudeSdk/modelSettings.ts",
    "piSdk/models.ts",
    "piSdk/toolActivation.ts",
  ],
  "workflow/agentExecutor.ts": ["piSdk/models.ts"],
  "workflow/runStart.ts": ["piSdk/models.ts"],
  "worktrees/worktreeMerge.ts": [
    "claudeSdk/modelSettings.ts",
    "piSdk/models.ts",
  ],
  "worktrees/worktreeNaming.ts": ["claudeSdk/oneShot.ts", "piSdk/oneShot.ts"],
};

/**
 * How many harness-id literal comparisons each app module still makes. Lower
 * the number (or delete the entry) in the change that removes one.
 */
const HARNESS_LITERAL_EXCEPTIONS: Record<string, number> = {
  "connection.ts": 13,
  "hub.ts": 3,
  "index.ts": 1,
  "promptInventory.ts": 4,
  "session/planHint.ts": 1,
  "sessionAudit.ts": 4,
  "sessionAuditSources.ts": 1,
  "sessionSpawn.ts": 1,
  "sessions.ts": 2,
  "taskOverhead.ts": 4,
  "tools/backgroundTasksTools.ts": 1,
  "tools/sessions/sessionInspection.ts": 1,
  "validateClientMessage.ts": 2,
  "viewSession.ts": 2,
};

/** Static, type-only, re-export, dynamic and side-effect import forms. */
const IMPORT_SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
];

/** `x === "pi"`, `"claude-sdk" !== x`, `case "pi":` and their kin. */
const HARNESS_LITERAL_COMPARISON =
  /[!=]==\s*"(?:pi|claude-sdk)"|"(?:pi|claude-sdk)"\s*[!=]==|\bcase\s+"(?:pi|claude-sdk)"\s*:/g;

/** The engine modules `source` (at `file`) imports, as paths under `src/`. */
function engineImports(file: string, source: string): string[] {
  const found = new Set<string>();
  for (const pattern of IMPORT_SPECIFIER_PATTERNS)
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] ?? "";
      if (!specifier.startsWith(".")) continue;
      const target = relative(SRC_ROOT, resolve(dirname(file), specifier));
      if (ENGINE_FOLDER.test(target)) found.add(target);
    }
  return [...found].sort();
}

function appModules(): { rel: string; file: string; source: string }[] {
  return sourceFiles(SRC_ROOT)
    .map((file) => ({ rel: relative(SRC_ROOT, file), file }))
    .filter(({ rel }) => !EXEMPT_FOLDER.test(rel))
    .map((entry) => ({ ...entry, source: readFileSync(entry.file, "utf8") }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

test("app code reaches engine folders only through the pinned exceptions", () => {
  const actual: Record<string, string[]> = {};
  for (const { rel, file, source } of appModules()) {
    const imports = engineImports(file, source);
    if (imports.length) actual[rel] = imports;
  }
  assert.deepEqual(
    actual,
    ENGINE_IMPORT_EXCEPTIONS,
    "Engine imports changed. A new one goes through harnesses/ instead; a removed one deletes its entry in ENGINE_IMPORT_EXCEPTIONS (docs/agent-harnesses.md).",
  );
});

test("app code compares harness ids only where pinned", () => {
  const actual: Record<string, number> = {};
  for (const { rel, source } of appModules()) {
    const count = source.match(HARNESS_LITERAL_COMPARISON)?.length ?? 0;
    if (count) actual[rel] = count;
  }
  assert.deepEqual(
    actual,
    HARNESS_LITERAL_EXCEPTIONS,
    "Harness-id comparisons changed. Branch on a capability instead of adding one; lower or delete the entry in HARNESS_LITERAL_EXCEPTIONS when removing one (docs/agent-harnesses.md).",
  );
});

test("the boundary scan sees every import form and comparison", () => {
  const file = join(SRC_ROOT, "workflow", "probe.ts");
  const source = [
    'import { a } from "../piSdk/models.ts";',
    'import type { B } from "../claudeSdk/oneShot.ts";',
    'export { c } from "../piSdk/oneShot.ts";',
    'const d = await import("../claudeSdk/usageQuery.ts");',
    'import "../piSdk/toolBinaries.ts";',
    'import { e } from "../session/runtimePrompt.ts";',
    'import { f } from "@earendil-works/pi-coding-agent";',
  ].join("\n");
  assert.deepEqual(engineImports(file, source), [
    "claudeSdk/oneShot.ts",
    "claudeSdk/usageQuery.ts",
    "piSdk/models.ts",
    "piSdk/oneShot.ts",
    "piSdk/toolBinaries.ts",
  ]);

  const comparisons = [
    'if (harness === "pi") {}',
    'if ("claude-sdk" !== ref.harness) {}',
    'switch (h) { case "claude-sdk": break; case "pi": break; }',
    'const label = "pi";',
  ].join("\n");
  assert.equal(comparisons.match(HARNESS_LITERAL_COMPARISON)?.length, 4);
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}
