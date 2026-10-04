/**
 * The harness boundary ratchet (`docs/agent-harnesses.md`).
 *
 * App code reaches the engine folders (`piSdk/`, `claudeSdk/`) only through
 * `harnesses/`, and branches on capabilities rather than on a harness id. The
 * only exceptions are the measurement modules, which measure what each engine
 * actually sends or spends; the two lists below pin exactly what each of them
 * still reaches, and nothing else may appear in either. Both checks are exact:
 * a new exception fails, and so does an entry the code no longer needs, so the
 * lists can only shrink.
 *
 * Scope: every non-test `.ts` module under `app/server/src` outside the exempt
 * folders, parsed into a syntax tree (oxc) so comments and unrelated strings
 * never count. A comparison is `==`, `===`, `!=` or `!==` with a
 * harness-id literal on either side, a `case` with one, or `.includes()` on an
 * array literal holding one.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { test } from "vitest";

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

/** Folders that may reach the engines directly. */
const EXEMPT_FOLDER = /^(?:piSdk|claudeSdk|harnesses|test)\//;

const ENGINE_FOLDER = /^(?:piSdk|claudeSdk)\//;

const HARNESS_IDS = new Set(["pi", "claude-sdk"]);

/**
 * The measurement modules: prompt budgets and inventory, task overhead and the
 * session audit measure what each engine actually sends or spends, so naming
 * the engine is their job. They are the only modules the lists below may name.
 */
const MEASUREMENT_MODULES = new Set([
  "promptBudgets.ts",
  "promptInventory.ts",
  "sessionAudit.ts",
  "sessionAuditSources.ts",
  "taskOverhead.ts",
]);

/**
 * Every engine module each measurement module still imports, as a path under
 * `src/`. Delete an entry in the change that removes the import.
 */
const ENGINE_IMPORT_EXCEPTIONS: Record<string, string[]> = {
  "promptBudgets.ts": ["piSdk/piPromptMeasure.ts"],
  "promptInventory.ts": [
    "claudeSdk/options.ts",
    "piSdk/backgroundWorkToolDefinitions.ts",
    "piSdk/piPromptMeasure.ts",
  ],
  "taskOverhead.ts": ["claudeSdk/claudeSdkRecords.ts"],
};

/**
 * How many harness-id comparisons each measurement module still makes. Lower
 * the number (or delete the entry) in the change that removes one.
 */
const HARNESS_LITERAL_EXCEPTIONS: Record<string, number> = {
  "promptInventory.ts": 4,
  "sessionAudit.ts": 4,
  "sessionAuditSources.ts": 1,
  "taskOverhead.ts": 4,
};

/**
 * Modules that load something by a computed path, which the scan cannot read:
 * `parcelWatcher.ts` requires the packaged native watcher by its absolute
 * install path, and builds the development package name so the bundler leaves
 * it alone. Neither can name an engine module.
 */
const COMPUTED_IMPORT_EXCEPTIONS: Record<string, number> = {
  "parcelWatcher.ts": 3,
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
): {
  engineImports: string[];
  harnessComparisons: number;
  computedImports: number;
} {
  const parsed = parseSync(file, source, { lang: "ts", sourceType: "module" });
  assert.deepEqual(
    parsed.errors.map((error) => error.message),
    [],
    `${relative(SRC_ROOT, file)} must parse for the boundary scan`,
  );
  const imports = new Set<string>();
  let harnessComparisons = 0;
  // A path the scan cannot read could name an engine module unseen.
  let computedImports = 0;

  const addSpecifier = (value: unknown) => {
    const specifier = constantString(value);
    if (specifier === undefined) {
      if (value != null) computedImports++;
      return;
    }
    // Relative, absolute and file: paths all name a module on disk; a bare
    // package name never names one of ours.
    let path: string;
    if (specifier.startsWith("file:")) path = fileURLToPath(specifier);
    else if (isAbsolute(specifier)) path = specifier;
    else if (specifier.startsWith("."))
      path = resolve(dirname(file), specifier);
    else return;
    const target = relative(SRC_ROOT, path);
    if (ENGINE_FOLDER.test(target)) imports.add(target);
  };

  // What loads a module when called: every name bound to `createRequire(...)`,
  // and Node's `require` unless the module declares a `require` of its own
  // that is not a loader, which is then read as never calling Node's.
  const isCreateRequire = (value: unknown): boolean => {
    const call = unwrap(value);
    if (!isNode(call) || call.type !== "CallExpression") return false;
    const callee = unwrap(call.callee);
    return (
      isNode(callee) &&
      callee.type === "Identifier" &&
      callee.name === "createRequire"
    );
  };
  const loaders = new Set<string>();
  let requireShadowed = false;
  const declare = (name: unknown, loader: boolean) => {
    if (typeof name !== "string") return;
    if (loader) loaders.add(name);
    else if (name === "require") requireShadowed = true;
  };
  const collectLoaders = (node: AstNode): void => {
    if (node.type === "VariableDeclarator" && isNode(node.id))
      declare(node.id.name, isCreateRequire(node.init));
    else if (
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression") &&
      isNode(node.id)
    )
      declare(node.id.name, false);
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") &&
      Array.isArray(node.params)
    )
      for (const param of node.params as unknown[])
        if (isNode(param)) declare(param.name, false);
    for (const value of Object.values(node))
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) collectLoaders(item);
      } else if (isNode(value)) collectLoaders(value);
  };
  collectLoaders(parsed.program as unknown as AstNode);
  if (!requireShadowed) loaders.add("require");

  /** Whether calling `callee` loads the module its first argument names. */
  const isLoader = (value: unknown): boolean => {
    const callee = unwrap(value);
    if (!isNode(callee)) return false;
    if (callee.type === "Identifier") return loaders.has(callee.name as string);
    if (isCreateRequire(callee)) return true;
    if (
      callee.type === "MemberExpression" &&
      isNode(callee.property) &&
      callee.property.name === "require"
    ) {
      const object = unwrap(callee.object);
      return (
        isNode(object) &&
        ((object.type === "Identifier" && object.name === "module") ||
          object.type === "MetaProperty")
      );
    }
    return false;
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
        if (isLoader(callee)) addSpecifier(args[0]);
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

  return {
    engineImports: [...imports].sort(),
    harnessComparisons,
    computedImports,
  };
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

test("only the measurement modules may reach an engine, and each still does", () => {
  const listed = new Set([
    ...Object.keys(ENGINE_IMPORT_EXCEPTIONS),
    ...Object.keys(HARNESS_LITERAL_EXCEPTIONS),
  ]);
  assert.deepEqual(
    [...listed].sort(),
    [...MEASUREMENT_MODULES].sort(),
    "Only a measurement module may import an engine or compare a harness id; everything else goes through harnesses/. A measurement module that no longer needs either leaves MEASUREMENT_MODULES (docs/agent-harnesses.md).",
  );
});

test("app code imports by literal paths only, so the scan sees every engine reach", () => {
  const actual: Record<string, number> = {};
  for (const { rel, file, source } of appModules()) {
    const { computedImports } = scanModule(file, source);
    if (computedImports) actual[rel] = computedImports;
  }
  assert.deepEqual(
    actual,
    COMPUTED_IMPORT_EXCEPTIONS,
    "An import or require with a computed path hides what it loads from this scan; name the module with a string literal (docs/agent-harnesses.md).",
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

test("the boundary scan sees every loader and every path form", () => {
  const file = join(SRC_ROOT, "workflow", "probe.ts");
  const source = [
    'import { createRequire } from "node:module";',
    'const a = createRequire(import.meta.url)("../piSdk/models.ts");',
    "const load = createRequire(import.meta.url);",
    'const b = load("../piSdk/oneShot.ts");',
    'const c = module.require("../claudeSdk/options.ts");',
    'const d = import.meta.require("../claudeSdk/oneShot.ts");',
    'const e = (require as NodeRequire)("../piSdk/piStore.ts");',
    `import { f } from "${join(SRC_ROOT, "piSdk", "index.ts")}";`,
    `const g = await import("file://${join(SRC_ROOT, "claudeSdk", "usageQuery.ts")}");`,
    `type H = typeof import("${join(SRC_ROOT, "piSdk", "options.ts")}");`,
  ].join("\n");
  assert.deepEqual(scanModule(file, source).engineImports, [
    "claudeSdk/oneShot.ts",
    "claudeSdk/options.ts",
    "claudeSdk/usageQuery.ts",
    "piSdk/index.ts",
    "piSdk/models.ts",
    "piSdk/oneShot.ts",
    "piSdk/options.ts",
    "piSdk/piStore.ts",
  ]);
});

test("a module's own require that loads nothing is not read as a loader", () => {
  const file = join(SRC_ROOT, "probe.ts");
  const source = [
    "function require(value: string) { return value; }",
    'const name = "label";',
    "require(name);",
  ].join("\n");
  assert.equal(scanModule(file, source).computedImports, 0);
});

test("the boundary scan counts every import whose path it cannot read", () => {
  const file = join(SRC_ROOT, "workflow", "probe.ts");
  const computed = [
    'const engine = "../piSdk/oneShot.ts"; const a = await import(engine);',
    'const b = await import(new URL("../piSdk/oneShot.ts", import.meta.url).href);',
    'const c = await import("../" + "piSdk/models.ts");',
    // An interpolated template, split so this file holds no placeholder.
    "const d = await import(`../piSdk/$" + "{name}.ts`);",
    "const e = require(packageName);",
    "const f = createRequire(import.meta.url)(packageName);",
    "const g = module.require(packageName);",
  ].join("\n");
  assert.equal(scanModule(file, computed).computedImports, 7);
  const literal = [
    'import { f } from "../session/runtimePrompt.ts";',
    "export function g() {}",
    'const h = await import("../piSdk/models.ts");',
    "const i = await import(`../piSdk/options.ts`);",
  ].join("\n");
  assert.equal(scanModule(file, literal).computedImports, 0);
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
