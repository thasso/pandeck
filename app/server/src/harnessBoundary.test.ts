/**
 * The harness boundary ratchet (`docs/agent-harnesses.md`).
 *
 * App code reaches the engine folders (`piSdk/`, `claudeSdk/`) only through
 * `harnesses/`, and branches on capabilities rather than on a harness id. The
 * code is migrating towards that, so the two lists below pin every exception
 * that still exists. Both checks are exact: a new exception fails, and so does
 * an entry the code no longer needs, which keeps the lists shrinking with the
 * migration instead of drifting above reality.
 *
 * Scope: every non-test `.ts` module under `app/server/src` outside the exempt
 * folders, parsed into a syntax tree (oxc) so comments and unrelated strings
 * never count. A comparison is `==`, `===`, `!=` or `!==` with a
 * harness-id literal on either side, a `case` with one, or `.includes()` on an
 * array literal holding one.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { test } from "vitest";

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

/** Folders that may reach the engines directly. */
const EXEMPT_FOLDER = /^(?:piSdk|claudeSdk|harnesses|test)\//;

const ENGINE_FOLDER = /^(?:piSdk|claudeSdk)\//;

const HARNESS_IDS = new Set(["pi", "claude-sdk"]);

/**
 * Every engine module each app module still imports, as a path under
 * `src/`. Delete an entry in the change that removes the import.
 */
const ENGINE_IMPORT_EXCEPTIONS: Record<string, string[]> = {
  "commitWorkflow.ts": ["piSdk/index.ts"],
  "connection.ts": [
    "claudeSdk/ClaudeSdkSession.ts",
    "claudeSdk/claudeSdkStore.ts",
    "piSdk/models.ts",
  ],
  "hub.ts": [
    "claudeSdk/ClaudeSdkSession.ts",
    "claudeSdk/claudeSdkStore.ts",
    "piSdk/PiLiveSession.ts",
    "piSdk/index.ts",
    "piSdk/piStore.ts",
  ],
  "index.ts": ["piSdk/models.ts", "piSdk/toolBinaries.ts"],
  "permanentAssistant.ts": ["piSdk/oneShot.ts"],
  "promptBudgets.ts": ["piSdk/piPromptMeasure.ts"],
  "promptInventory.ts": [
    "claudeSdk/options.ts",
    "piSdk/backgroundWorkToolDefinitions.ts",
    "piSdk/piPromptMeasure.ts",
  ],
  "session/adapters/claudeSdk.ts": ["claudeSdk/modelSettings.ts"],
  "sessionSpawn.ts": ["piSdk/models.ts"],
  "taskOverhead.ts": ["claudeSdk/claudeSdkRecords.ts"],
  "viewSession.ts": ["piSdk/toolActivation.ts"],
  "workflow/agentExecutor.ts": ["piSdk/models.ts"],
  "worktrees/worktreeMerge.ts": [
    "claudeSdk/modelSettings.ts",
    "piSdk/models.ts",
  ],
};

/**
 * How many harness-id comparisons each app module still makes. Lower the
 * number (or delete the entry) in the change that removes one.
 */
const HARNESS_LITERAL_EXCEPTIONS: Record<string, number> = {
  "connection.ts": 13,
  "hub.ts": 3,
  "promptInventory.ts": 4,
  "session/planHint.ts": 1,
  "sessionAudit.ts": 4,
  "sessionAuditSources.ts": 1,
  "sessions.ts": 1,
  "taskOverhead.ts": 4,
  "tools/sessions/sessionInspection.ts": 1,
  "validateClientMessage.ts": 2,
  "viewSession.ts": 1,
};

const EQUALITY_OPERATORS = new Set(["==", "===", "!=", "!=="]);

/** An ESTree node as oxc-parser produces it; only `type` is relied on. */
type AstNode = { type: string; [key: string]: unknown };

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** Wrappers that change an expression's type or grouping, never its value. */
const TRANSPARENT_WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

function unwrap(value: unknown): unknown {
  let node = value;
  while (isNode(node) && TRANSPARENT_WRAPPERS.has(node.type))
    node = node.expression;
  return node;
}

/** The text of a constant string literal, through any transparent wrapper. */
function constantString(value: unknown): string | undefined {
  let node = unwrap(value);
  if (isNode(node) && node.type === "TSLiteralType") node = node.literal;
  if (!isNode(node)) return undefined;
  if (node.type === "Literal")
    return typeof node.value === "string" ? node.value : undefined;
  if (
    node.type === "TemplateLiteral" &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0 &&
    Array.isArray(node.quasis)
  ) {
    const cooked = (node.quasis[0] as { value?: { cooked?: unknown } })?.value
      ?.cooked;
    return typeof cooked === "string" ? cooked : undefined;
  }
  return undefined;
}

function isHarnessId(value: unknown): boolean {
  const text = constantString(value);
  return text !== undefined && HARNESS_IDS.has(text);
}

/**
 * What one module does across the boundary: the engine modules it imports
 * (as paths under `src/`) and how many harness-id comparisons it makes.
 */
function scanModule(
  file: string,
  source: string,
): { engineImports: string[]; harnessComparisons: number } {
  const parsed = parseSync(file, source, { lang: "ts", sourceType: "module" });
  assert.deepEqual(
    parsed.errors.map((error) => error.message),
    [],
    `${relative(SRC_ROOT, file)} must parse for the boundary scan`,
  );
  const imports = new Set<string>();
  let harnessComparisons = 0;

  const addSpecifier = (value: unknown) => {
    const specifier = constantString(value);
    if (!specifier?.startsWith(".")) return;
    const target = relative(SRC_ROOT, resolve(dirname(file), specifier));
    if (ENGINE_FOLDER.test(target)) imports.add(target);
  };

  const visit = (node: AstNode): void => {
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
      case "ImportExpression":
      case "TSImportType":
        addSpecifier(node.source);
        break;
      case "TSExternalModuleReference":
        addSpecifier(node.expression);
        break;
      case "CallExpression": {
        const callee = node.callee;
        const receiver = isNode(callee) ? unwrap(callee.object) : undefined;
        const args = node.arguments as unknown[];
        if (
          isNode(callee) &&
          callee.type === "Identifier" &&
          callee.name === "require"
        )
          addSpecifier(args[0]);
        if (
          isNode(callee) &&
          callee.type === "MemberExpression" &&
          isNode(callee.property) &&
          callee.property.name === "includes" &&
          isNode(receiver) &&
          receiver.type === "ArrayExpression" &&
          (receiver.elements as unknown[]).some(isHarnessId)
        )
          harnessComparisons++;
        break;
      }
      case "BinaryExpression":
        if (
          EQUALITY_OPERATORS.has(node.operator as string) &&
          (isHarnessId(node.left) || isHarnessId(node.right))
        )
          harnessComparisons++;
        break;
      case "SwitchCase":
        if (isHarnessId(node.test)) harnessComparisons++;
        break;
    }
    for (const value of Object.values(node))
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item);
      } else if (isNode(value)) visit(value);
  };
  visit(parsed.program as unknown as AstNode);

  return { engineImports: [...imports].sort(), harnessComparisons };
}

function appModules(): { rel: string; file: string; source: string }[] {
  return sourceFiles(SRC_ROOT)
    .map((file) => ({ rel: relative(SRC_ROOT, file), file }))
    .filter(({ rel }) => !EXEMPT_FOLDER.test(rel) && extname(rel) === ".ts")
    .map((entry) => ({ ...entry, source: readFileSync(entry.file, "utf8") }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

test("app code reaches engine folders only through the pinned exceptions", () => {
  const actual: Record<string, string[]> = {};
  for (const { rel, file, source } of appModules()) {
    const { engineImports } = scanModule(file, source);
    if (engineImports.length) actual[rel] = engineImports;
  }
  assert.deepEqual(
    actual,
    ENGINE_IMPORT_EXCEPTIONS,
    "Engine imports changed. A new one goes through harnesses/ instead; a removed one deletes its entry in ENGINE_IMPORT_EXCEPTIONS (docs/agent-harnesses.md).",
  );
});

test("app code compares harness ids only where pinned", () => {
  const actual: Record<string, number> = {};
  for (const { rel, file, source } of appModules()) {
    const { harnessComparisons } = scanModule(file, source);
    if (harnessComparisons) actual[rel] = harnessComparisons;
  }
  assert.deepEqual(
    actual,
    HARNESS_LITERAL_EXCEPTIONS,
    "Harness-id comparisons changed. Branch on a capability instead of adding one; lower or delete the entry in HARNESS_LITERAL_EXCEPTIONS when removing one (docs/agent-harnesses.md).",
  );
});

test("server sources are all .ts, so the scan sees every module", () => {
  const other = sourceFiles(SRC_ROOT)
    .map((file) => relative(SRC_ROOT, file))
    .filter((rel) => extname(rel) !== ".ts");
  assert.deepEqual(
    other,
    [],
    "harnessBoundary.test.ts scans only .ts modules; extend it before adding another source extension.",
  );
});

test("the boundary scan sees every import form and ignores comments and strings", () => {
  const file = join(SRC_ROOT, "workflow", "probe.ts");
  const source = [
    'import { a } from "../piSdk/models.ts";',
    'import type { B } from "../claudeSdk/oneShot.ts";',
    'export { c } from "../piSdk/oneShot.ts";',
    'const d = await import("../claudeSdk/usageQuery.ts");',
    "const e = await import(`../piSdk/options.ts`);",
    'const f = await import(/* engine */ "../piSdk/index.ts");',
    'import "../piSdk/toolBinaries.ts";',
    'import G = require("../claudeSdk/options.ts");',
    'type H = typeof import("../piSdk/piStore.ts");',
    'const i = require("../claudeSdk/claudeSdkStore.ts");',
    'import { j } from "../session/runtimePrompt.ts";',
    'import { k } from "@earendil-works/pi-coding-agent";',
    '// import { l } from "../piSdk/PiLiveSession.ts";',
    '/* export { m } from "../claudeSdk/ClaudeSdkSession.ts"; */',
    "const example = 'import { n } from \"../piSdk/models.ts\"';",
  ].join("\n");
  assert.deepEqual(scanModule(file, source).engineImports, [
    "claudeSdk/claudeSdkStore.ts",
    "claudeSdk/oneShot.ts",
    "claudeSdk/options.ts",
    "claudeSdk/usageQuery.ts",
    "piSdk/index.ts",
    "piSdk/models.ts",
    "piSdk/oneShot.ts",
    "piSdk/options.ts",
    "piSdk/piStore.ts",
    "piSdk/toolBinaries.ts",
  ]);
});

test("the boundary scan counts every comparison form and ignores comments and strings", () => {
  const file = join(SRC_ROOT, "probe.ts");
  const counted = [
    'if (harness === "pi") {}',
    'if ("claude-sdk" !== ref.harness) {}',
    "if (harness !== 'pi') {}",
    "if (harness === `claude-sdk`) {}",
    'if (harness == "pi") {}',
    'if (harness === /* engine */ "pi") {}',
    'if (harness === ("claude-sdk" as const)) {}',
    'if (["pi", "other"].includes(harness)) {}',
    'if ((["pi", "claude-sdk"] as const).includes(harness)) {}',
    'if ((["pi"] satisfies readonly string[]).includes(harness)) {}',
    'if (harness === ("pi"!)) {}',
    'if (harness === <string>"claude-sdk") {}',
    'switch (h) { case "claude-sdk": break; case "pi": break; }',
  ].join("\n");
  assert.equal(scanModule(file, counted).harnessComparisons, 14);

  const ignored = [
    '// if (harness === "pi") {}',
    '/* case "claude-sdk": */',
    'const label = "pi";',
    "const text = 'harness === \"pi\"';",
    'const harness: Harness = "claude-sdk";',
    'if (harness === "pip") {}',
    'if (names.includes("pi")) {}',
  ].join("\n");
  assert.equal(scanModule(file, ignored).harnessComparisons, 0);
});

/** Every non-test script under `dir`, whatever its extension. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(name) && !/\.test\./.test(name))
      out.push(path);
  }
  return out;
}
