/**
 * The engine-binding ratchet (`docs/session-runtime-switching.md` "Engine
 * bindings"). A session's engine is its ACTIVE BINDING; these pins keep new
 * code from growing around it before the cross-harness switch lands:
 *
 * - only the three `sessionStore` binding writers write `session_index`'s six
 *   projection columns, and only `db/sessionEngineBinding.ts` writes the
 *   binding table, so the row always equals the active binding;
 * - the pi transcript is derived from the app id (`canonicalPiSessionPath`)
 *   only where no binding can exist yet; everything else resolves it through
 *   the binding;
 * - app code reads a session's `.harness` only where pinned: capability
 *   readers go through `activeEngine(...)`.
 *
 * Every pin is exact, so a new site fails and so does a stale entry: the lists
 * only shrink. The scans parse a syntax tree (oxc), so comments never count.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { test } from "vitest";

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * SQL strings writing a projection column of `session_index`: the upsert's
 * INSERT, the failover CAS's two account updates and the harness switch's
 * projection of its new binding.
 */
const PROJECTION_WRITERS: Record<string, number> = { "db/sessionStore.ts": 4 };

/**
 * SQL strings writing `session_engine_binding`, its own module only: the
 * write-through's update and insert, the failover account update, and the
 * harness switch's end, insert and first-run stamp.
 */
const BINDING_WRITERS: Record<string, number> = {
  "db/sessionEngineBinding.ts": 6,
};

/**
 * Where the pi transcript path is derived from the app id instead of the
 * binding: the derivation itself and its binding-checked wrapper
 * (`sessionStorage.ts`), the rowless probe (`harnesses/registry.ts`), rowless
 * recovery (`sessions.ts`) and canonicalization while a fresh session has no
 * row (`piSdk/piEngineHost.ts`).
 */
const CANONICAL_PI_PATH_SITES: Record<string, number> = {
  "harnesses/registry.ts": 1,
  "piSdk/piEngineHost.ts": 1,
  "sessions.ts": 1,
  "sessionStorage.ts": 1,
};

/**
 * Folders that own the engine or the binding, and so name a harness freely:
 * the engines, the harness seam, persistence and the worker protocol.
 */
const HARNESS_READ_EXEMPT =
  /^(?:piSdk|claudeSdk|harnesses|db|workerProtocol|test)\//;

/**
 * Remaining `.harness` reads (outside `activeEngine(...).harness`) per app
 * module. Most read a wire ref, an agent definition or a resident driver; the
 * measurement modules measure per engine. Lower or delete the entry in the
 * change that removes one; a new capability read goes through `activeEngine`.
 */
const HARNESS_READS: Record<string, number> = {
  "backgroundWork/policy.ts": 3,
  "checkPromptBudgets.ts": 1,
  "connection.ts": 12,
  "measurePrompts.ts": 3,
  "measureSession.ts": 1,
  "measureTaskOverhead.ts": 1,
  "piSessionFile.ts": 1,
  "promptBudgets.ts": 8,
  "promptQueue.ts": 1,
  "sessionAudit.ts": 5,
  "sessionAuditSources.ts": 4,
  "sessionState.ts": 2,
  "sessions.ts": 2,
  "taskOverhead.ts": 2,
  "tools/backgroundTasksTools.ts": 2,
  "tools/knowledge/knowledgeBaseTools.ts": 1,
  "tools/library/libraryTools.ts": 1,
  "tools/sessions/sessionAuditTool.ts": 1,
  "validateClientMessage.ts": 4,
  "viewSession.ts": 3,
};

const PROJECTION_COLUMNS =
  /\b(?:harness|provider|provider_session_id|model|thinking_level|credential_profile_id)\s*=/;

type AstNode = { type: string; [key: string]: unknown };

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walk(item, visit);
    } else if (isNode(value)) walk(value, visit);
  }
}

/** The text of a string or template literal; `${…}` reads as `?`. */
function literalText(node: AstNode): string | undefined {
  if (node.type === "Literal" && typeof node.value === "string")
    return node.value;
  if (node.type !== "TemplateLiteral") return undefined;
  const quasis = node.quasis as { value: { raw: string } }[];
  return quasis.map((quasi) => quasi.value.raw).join("?");
}

function isProjectionWrite(sql: string): boolean {
  if (/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+session_index\b/i.test(sql))
    return true;
  const update =
    /\bUPDATE\s+session_index\b[\s\S]*?\bSET\b([\s\S]*?)(?:\bWHERE\b|$)/i.exec(
      sql,
    );
  return update !== null && PROJECTION_COLUMNS.test(update[1] ?? "");
}

function isBindingWrite(sql: string): boolean {
  return /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+session_engine_binding\b/i.test(
    sql,
  );
}

function scan(
  file: string,
  source: string,
): {
  projectionWrites: number;
  bindingWrites: number;
  canonicalPiPaths: number;
  harnessReads: number;
} {
  const parsed = parseSync(file, source, { lang: "ts", sourceType: "module" });
  assert.deepEqual(
    parsed.errors.map((error) => error.message),
    [],
    `${file} must parse for the engine-binding scan`,
  );
  const counts = {
    projectionWrites: 0,
    bindingWrites: 0,
    canonicalPiPaths: 0,
    harnessReads: 0,
  };
  walk(parsed.program as unknown as AstNode, (node) => {
    const sql = literalText(node);
    if (sql !== undefined) {
      if (isProjectionWrite(sql)) counts.projectionWrites++;
      if (isBindingWrite(sql)) counts.bindingWrites++;
      return;
    }
    if (
      node.type === "CallExpression" &&
      isNode(node.callee) &&
      node.callee.type === "Identifier" &&
      node.callee.name === "canonicalPiSessionPath"
    ) {
      counts.canonicalPiPaths++;
      return;
    }
    if (
      node.type === "MemberExpression" &&
      node.computed === false &&
      isNode(node.property) &&
      node.property.name === "harness" &&
      !isActiveEngineCall(node.object)
    )
      counts.harnessReads++;
  });
  return counts;
}

function isActiveEngineCall(value: unknown): boolean {
  return (
    isNode(value) &&
    value.type === "CallExpression" &&
    isNode(value.callee) &&
    value.callee.type === "Identifier" &&
    value.callee.name === "activeEngine"
  );
}

/** Every non-test `.ts` module under `src/`, relative to it. */
function modules(dir = SRC_ROOT): { rel: string; source: string }[] {
  const out: { rel: string; source: string }[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...modules(path));
    else if (name.endsWith(".ts") && !name.includes(".test."))
      out.push({
        rel: relative(SRC_ROOT, path),
        source: readFileSync(path, "utf8"),
      });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function measure(
  pick: (counts: ReturnType<typeof scan>) => number,
  include: (rel: string) => boolean = () => true,
): Record<string, number> {
  const actual: Record<string, number> = {};
  for (const { rel, source } of modules()) {
    if (!include(rel)) continue;
    const count = pick(scan(join(SRC_ROOT, rel), source));
    if (count) actual[rel] = count;
  }
  return actual;
}

test("only the three sessionStore binding writers write session_index's projection columns", () => {
  assert.deepEqual(
    measure((counts) => counts.projectionWrites),
    PROJECTION_WRITERS,
    "harness, provider, provider_session_id, model, thinking_level and credential_profile_id are the active binding's projection: write them through sessionStore.upsert, switchCredentialProfile or switchEngineBinding, which write the binding in the same transaction",
  );
});

test("only db/sessionEngineBinding.ts writes the binding table", () => {
  assert.deepEqual(
    measure((counts) => counts.bindingWrites),
    BINDING_WRITERS,
  );
});

test("the pi transcript is derived from the app id only at the pinned rowless sites", () => {
  assert.deepEqual(
    measure((counts) => counts.canonicalPiPaths),
    CANONICAL_PI_PATH_SITES,
    "Resolve a stored session's pi transcript with piSessionFile (its active binding); canonicalPiSessionPath is for a session that has no row yet",
  );
});

test("app code reads a session's harness only where pinned", () => {
  assert.deepEqual(
    measure(
      (counts) => counts.harnessReads,
      (rel) => !HARNESS_READ_EXEMPT.test(rel),
    ),
    HARNESS_READS,
    "Ask activeEngine(...) what engine a session runs on; lower or delete the HARNESS_READS entry when removing a read",
  );
});

test("the engine-binding scan sees every form it pins and ignores comments", () => {
  const file = join(SRC_ROOT, "probe.ts");
  const counted = scan(
    file,
    [
      'db.prepare("INSERT INTO session_index (id) VALUES (?)");',
      // A probe source holding a template literal with a placeholder.
      `db.prepare(\`INSERT OR REPLACE INTO session_index (\${cols}) VALUES (?)\`);`,
      'db.prepare("UPDATE session_index SET model = ? WHERE id = ?");',
      "db.prepare(`UPDATE session_index\n SET read_at_ms = 1, credential_profile_id = ?\n WHERE id = ?`);",
      'db.prepare("DELETE FROM session_engine_binding WHERE session_id = ?");',
      'db.prepare("UPDATE session_engine_binding SET model = ?");',
      "canonicalPiSessionPath(id);",
      "const h = row.harness;",
      "const e = activeEngine(row).harness;",
    ].join("\n"),
  );
  assert.deepEqual(counted, {
    projectionWrites: 4,
    bindingWrites: 2,
    canonicalPiPaths: 1,
    harnessReads: 1,
  });
  const ignored = scan(
    file,
    [
      '// db.prepare("UPDATE session_index SET model = ?");',
      'db.prepare("UPDATE session_index SET read_at_ms = ? WHERE model = ?");',
      'db.prepare("SELECT harness FROM session_engine_binding");',
      "const path = sessionStorage.canonicalPiSessionPathless;",
      "const h = row[harness];",
    ].join("\n"),
  );
  assert.deepEqual(ignored, {
    projectionWrites: 0,
    bindingWrites: 0,
    canonicalPiPaths: 0,
    harnessReads: 0,
  });
});
