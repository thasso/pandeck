/**
 * CODEMOD 2 of 3 — guards an object-literal property whose value may be
 * `undefined`, so the key is OMITTED instead of set to undefined.
 *
 *   before:  { title, dueDate: normalize(x) }
 *   after:   { ...(title !== undefined ? { title } : {}) }
 *
 * Four shapes, in the order they are preferred (see docs/linting.md):
 *
 *   cheap       `k: a.b`            -> `...(a.b !== undefined ? { k: a.b } : {})`
 *   shorthand   `k`                 -> `...(k !== undefined ? { k } : {})`
 *   ternary     `k: c ? v : undefined` -> `...(c ? { k: v } : {})`
 *   nullish     `k: a ?? undefined` -> `...(a !== undefined ? { k: a } : {})`
 *               `k: a || undefined` -> `...(a ? { k: a } : {})`
 *
 * A value that is not safe to evaluate twice (a call, an await, a non-trivial
 * operator) is HOISTED to a const first so it is evaluated exactly once. Hoists
 * are listed in the report because they move a computation earlier in the
 * statement, which is only invisible if the expression is pure.
 *
 * WHAT IT REFUSES TO DO, and why that matters: if the literal has a SPREAD
 * before the property, then `{ ...base, k: undefined }` explicitly OVERWRITES
 * `base.k`, while omitting the key lets `base.k` show through. Guarding such a
 * site is a real behaviour change, so it is reported and left alone for a human
 * to decide one at a time. Never let a codemod make that call.
 *
 * ts6 is used only to PARSE. Which sites are wrong comes from v7 tsc, and the
 * result is re-checked with v7 tsc — see eopt-diagnostics.mjs.
 *
 * KNOWN LIMIT, and why re-running tsc is not optional: tsc names the offending
 * property but not which nesting level it lives at, so when the same name
 * appears twice (once at the top level, once inside a `.map()` callback) this
 * can guard the wrong one. If that one is REQUIRED in the target, the guard
 * turns "got undefined" into "missing property" — which tsc then reports, so
 * the mistake is always caught rather than shipped. Check the output.
 *
 * Re-run:  node scripts/codemods/eopt-guard-object-props.mjs [pkg] [--dry]
 *          node scripts/codemods/eopt-guard-object-props.mjs --hazards
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { PACKAGES, collect } from "./eopt-diagnostics.mjs";
import { resetSourceCache, shapeOf, sourceFileFor } from "./eopt-classify.mjs";
import {
  isCheap,
  literalFor,
  propertyFor,
  spreadHazard,
  undefinedTernary,
} from "./eopt-analyze-props.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const hazardsOnly = args.includes("--hazards");
const pkgArg = args.find((a) => !a.startsWith("--"));

const SHAPES = [
  "object-literal",
  "return",
  "variable-decl",
  "object-literal-prop",
  "call-arg",
];

/** `a ?? undefined` / `a || undefined` — the redundant normalizer. */
function undefinedFallback(expr) {
  if (!ts.isBinaryExpression(expr)) return null;
  const op = expr.operatorToken.kind;
  if (
    op !== ts.SyntaxKind.QuestionQuestionToken &&
    op !== ts.SyntaxKind.BarBarToken
  ) {
    return null;
  }
  const right = expr.right;
  if (!(ts.isIdentifier(right) && right.text === "undefined")) return null;
  return { value: expr.left, truthy: op === ts.SyntaxKind.BarBarToken };
}

/**
 * Is this property ALREADY inside a guard testing the very same value?
 *
 * Without this the codemod re-wraps its own output: `propertyFor` descends into
 * `...(x !== undefined ? { k: x } : {})` to find `k`, guards it again, and every
 * pass adds another layer. Terminating on "this exact test already encloses me"
 * keeps the descent — which legitimately finds a still-optional value inside a
 * guard — without the regress.
 */
function alreadyGuarded(prop, sf) {
  const valueText = ts.isPropertyAssignment(prop)
    ? prop.initializer.getText(sf)
    : prop.name.getText(sf);
  const test = `${valueText} !== undefined`;
  for (let n = prop.parent; n; n = n.parent) {
    if (
      ts.isConditionalExpression(n) &&
      n.condition.getText(sf).includes(test)
    ) {
      return true;
    }
  }
  return false;
}

const FUNCTION_KINDS = (n) =>
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) ||
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isGetAccessor(n) ||
  ts.isSetAccessor(n) ||
  ts.isConstructorDeclaration(n);

/**
 * Does `parent` evaluate `child` only conditionally? Hoisting across such an
 * edge makes the expression run when it previously would not have.
 *
 * This is not a style point. `cond && x ? { k: x.y } : null` hoisted above the
 * ternary evaluates `x.y` when `x` is null — a TypeError at runtime, and the
 * narrowing that made it safe is gone too.
 */
function isConditionalEdge(parent, child) {
  if (ts.isConditionalExpression(parent)) {
    return child === parent.whenTrue || child === parent.whenFalse;
  }
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    const shortCircuits =
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken;
    return shortCircuits && child === parent.right;
  }
  return false;
}

/**
 * Where a `const` for this node can legally be bound.
 *
 * Walking up to the nearest Statement is WRONG twice over:
 *   - `raw.map((r) => ({ k: r.x }))` would hoist `r.x` above the statement,
 *     where `r` does not exist — so the walk stops at a function boundary, and
 *     a concise arrow body is converted to a block to bind in.
 *   - `cond ? { k: f(x) } : null` would hoist `f(x)` out of the branch that
 *     guards it — so the walk refuses to cross a conditional edge.
 *
 * Returns null when neither is available; the caller then leaves the site for a
 * human rather than guessing.
 */
function hoistAnchor(node) {
  let n = node;
  while (n) {
    if (n.parent && isConditionalEdge(n.parent, n)) return null;
    if (ts.isStatement(n)) return { kind: "statement", node: n };
    if (FUNCTION_KINDS(n)) {
      // A concise-body arrow: `(r) => EXPR`. Give it a block to bind in.
      if (ts.isArrowFunction(n) && !ts.isBlock(n.body)) {
        return { kind: "arrow-body", node: n };
      }
      return null; // a block-bodied function: a Statement would have matched
    }
    n = n.parent;
  }
  return null;
}

/** The function-ish body enclosing a node, used to avoid a name collision. */
function enclosingScopeText(node, sf) {
  let n = node;
  while (
    n &&
    !ts.isFunctionDeclaration(n) &&
    !ts.isFunctionExpression(n) &&
    !ts.isArrowFunction(n) &&
    !ts.isMethodDeclaration(n) &&
    !ts.isSourceFile(n)
  ) {
    n = n.parent;
  }
  return (n ?? sf).getText(sf);
}

function freshName(base, node, sf) {
  const scope = enclosingScopeText(node, sf);
  const bound = (name) =>
    new RegExp(
      `\\b(const|let|var|function)\\s+${name}\\b|\\b${name}\\s*[,)]?\\s*[:=]`,
    ).test(scope);
  for (const candidate of [
    base,
    `${base}Value`,
    `${base}Opt`,
    `${base}Resolved`,
  ]) {
    if (!bound(candidate)) return candidate;
  }
  return `${base}_eopt`;
}

function run(pkgs) {
  const diags = collect(pkgs);
  // file -> edits; collected across all diagnostics, applied back-to-front.
  const editsByFile = new Map();
  const claimed = new Set();
  const report = {
    cheap: [],
    shorthand: [],
    ternary: [],
    fallback: [],
    hoist: [],
  };
  const hazards = [];
  const explicitUndefined = [];
  const unhandled = [];
  // anchor -> the const declarations to bind there, so repeated hoists into the
  // same statement or arrow body share one insertion.
  const hoistSlots = new Map();

  const addEdit = (file, edit) => {
    if (!editsByFile.has(file)) editsByFile.set(file, []);
    editsByFile.get(file).push(edit);
  };

  for (const d of diags) {
    const sf = sourceFileFor(d.file);
    const { shape } = shapeOf(sf, d);
    if (!SHAPES.includes(shape)) continue;
    const literal = literalFor(sf, d);
    if (!literal || d.props.length === 0) continue;
    const hit = propertyFor(literal, d.props[0]);
    if (!hit) {
      unhandled.push(
        `${d.file}:${d.line} ${d.code} [${d.props.join(",")}] (property not located)`,
      );
      continue;
    }
    const { prop } = hit;
    const key = `${d.file}#${prop.getStart(sf)}`;
    if (claimed.has(key)) continue;

    const name = prop.name.getText(sf);
    const where = `${d.file}:${d.line} ${name}`;

    if (alreadyGuarded(prop, sf)) {
      unhandled.push(`${where} (already inside a guard for the same value)`);
      continue;
    }

    // An initializer that is LITERALLY `undefined` is a deliberate statement,
    // not a value that happens to be missing: in a patch it means "clear this
    // field", and dropping the key means "leave it alone". Guarding it would
    // also produce the tautology `undefined !== undefined`. Never decide this
    // mechanically — hand it to a human.
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.initializer) &&
      prop.initializer.text === "undefined"
    ) {
      explicitUndefined.push(
        `${where}\t${prop.getText(sf).split("\n")[0].slice(0, 100)}`,
      );
      continue;
    }

    // Only an OPAQUE preceding spread can supply this key and thus change
    // behaviour; a spread of literals has known keys and is provably safe.
    if (spreadHazard(hit.literal, prop) === "opaque") {
      hazards.push(
        `${where}\t${prop.getText(sf).split("\n")[0].slice(0, 100)}`,
      );
      continue;
    }
    claimed.add(key);

    const start = prop.getStart(sf);
    const end = prop.getEnd();
    const replace = (text) => addEdit(d.file, { start, end, text });

    if (ts.isShorthandPropertyAssignment(prop)) {
      replace(`...(${name} !== undefined ? { ${name} } : {})`);
      report.shorthand.push(where);
      continue;
    }

    const init = prop.initializer;
    const tern = undefinedTernary(init);
    if (tern) {
      const cond = tern.cond.getText(sf);
      const value = tern.value.getText(sf);
      const test = tern.negate ? `!(${cond})` : cond;
      replace(`...(${test} ? { ${name}: ${value} } : {})`);
      report.ternary.push(where);
      continue;
    }

    const fb = undefinedFallback(init);
    if (fb && isCheap(fb.value)) {
      const v = fb.value.getText(sf);
      // Keep each operator's meaning exactly. `||` is falsy-based, so a truthy
      // test reproduces it. `??` is NULLISH-based: `a ?? undefined` drops null
      // as well, so `!== undefined` would wrongly emit `k: null` — it needs
      // `!= null` (eqeqeq is configured with `null: "ignore"`).
      const test = fb.truthy ? v : `${v} != null`;
      replace(`...(${test} ? { ${name}: ${v} } : {})`);
      report.fallback.push(`${where} (${fb.truthy ? "||" : "??"})`);
      continue;
    }

    if (isCheap(init)) {
      const v = init.getText(sf);
      replace(`...(${v} !== undefined ? { ${name}: ${v} } : {})`);
      report.cheap.push(where);
      continue;
    }

    // Not safe to evaluate twice: bind it to a const, in a scope where every
    // name the expression uses is actually in scope.
    // Walk from the PROPERTY, not the enclosing literal: the property may sit
    // inside a nested `cond ? { k: v } : {}` guard that the outer literal knows
    // nothing about, and hoisting past that guard loses its narrowing.
    const anchor = hoistAnchor(prop);
    if (!anchor) {
      unhandled.push(`${where} (nowhere in scope to hoist into)`);
      claimed.delete(key);
      continue;
    }
    const bindName = freshName(name, literal, sf);
    const decl = `const ${bindName} = ${init.getText(sf)};`;
    const anchorKey = `${d.file}#${anchor.kind}#${anchor.node.getStart(sf)}`;
    let slot = hoistSlots.get(anchorKey);
    if (!slot) {
      slot = { file: d.file, anchor, sf, decls: [] };
      hoistSlots.set(anchorKey, slot);
    }
    slot.decls.push(decl);

    replace(
      bindName === name
        ? `...(${bindName} !== undefined ? { ${bindName} } : {})`
        : `...(${bindName} !== undefined ? { ${name}: ${bindName} } : {})`,
    );
    report.hoist.push(
      `${where} [${anchor.kind}] -> ${decl.split("\n")[0].slice(0, 80)}`,
    );
  }

  // Emit one set of edits per anchor, so several hoists into the same statement
  // or arrow share a single insertion point.
  for (const slot of hoistSlots.values()) {
    const { sf, anchor, decls } = slot;
    if (anchor.kind === "statement") {
      const start = anchor.node.getStart(sf);
      const lineStart =
        sf.getLineStarts()[sf.getLineAndCharacterOfPosition(start).line];
      const indent = sf.text.slice(lineStart, start).match(/^[ \t]*/)[0];
      addEdit(slot.file, {
        start,
        end: start,
        text: decls.join(`\n${indent}`) + `\n${indent}`,
      });
      continue;
    }
    // `(r) => EXPR` becomes `(r) => { const v = ...; return EXPR; }`.
    // Two ZERO-WIDTH insertions at the body's edges, so they never overlap the
    // property rewrites that live strictly inside the body. Prettier reflows it.
    const body = anchor.node.body;
    addEdit(slot.file, {
      start: body.getStart(sf),
      end: body.getStart(sf),
      text: `{ ${decls.join(" ")} return `,
    });
    addEdit(slot.file, {
      start: body.getEnd(),
      end: body.getEnd(),
      text: `; }`,
    });
  }

  return { editsByFile, report, hazards, explicitUndefined, unhandled };
}

const pkgs = pkgArg ? [pkgArg] : PACKAGES;

function applyEdits(editsByFile) {
  let applied = 0;
  for (const [file, edits] of editsByFile) {
    const abs = path.join(repoRoot, file);
    let text = fs.readFileSync(abs, "utf8");
    // Back-to-front so earlier offsets stay valid. At an equal offset a
    // zero-width insertion must run after a replacement that starts there.
    for (const e of edits.sort(
      (a, b) => b.start - a.start || a.end - a.start - (b.end - b.start),
    )) {
      text = text.slice(0, e.start) + e.text + text.slice(e.end);
      applied++;
    }
    if (!dry) fs.writeFileSync(abs, text);
  }
  return applied;
}

// tsc names only the FIRST incompatible property of a literal, so a literal with
// two bad properties needs two passes. Repeat until nothing changes.
const MAX_PASSES = 30;
const totals = { cheap: 0, shorthand: 0, ternary: 0, fallback: 0, hoist: 0 };
const allReports = [];
let hazards = [];
let explicitUndefined = [];
let unhandled = [];
let totalEdits = 0;
let passes = 0;

for (; passes < MAX_PASSES; passes++) {
  resetSourceCache();
  const result = run(pkgs);
  hazards = result.hazards;
  explicitUndefined = result.explicitUndefined;
  unhandled = result.unhandled;

  if (hazardsOnly) {
    process.stdout.write(
      hazards.join("\n") +
        `\n\n${hazards.length} spread-before-property sites\n`,
    );
    process.exit(0);
  }

  const applied = applyEdits(result.editsByFile);
  totalEdits += applied;
  for (const [k, v] of Object.entries(result.report)) totals[k] += v.length;
  allReports.push(
    `### pass ${passes + 1}\n` +
      Object.entries(result.report)
        .map(([k, v]) => `== ${k} (${v.length})\n${v.join("\n")}`)
        .join("\n\n"),
  );
  process.stdout.write(`pass ${passes + 1}: ${applied} edits\n`);
  // --dry writes nothing, so a second pass would only repeat the first.
  if (applied === 0 || dry) break;
}

process.stdout.write(
  `\n${dry ? "[dry] " : ""}${totalEdits} edits over ${passes + 1} pass(es)\n`,
);
for (const [kind, n] of Object.entries(totals)) {
  process.stdout.write(`  ${kind.padEnd(10)} ${n}\n`);
}
process.stdout.write(
  `  ${"HAZARD".padEnd(10)} ${hazards.length} (opaque spread before property — left alone)\n`,
);
process.stdout.write(
  `  ${"explicit".padEnd(10)} ${explicitUndefined.length} (literal \`k: undefined\` — left alone)\n`,
);
process.stdout.write(`  ${"unhandled".padEnd(10)} ${unhandled.length}\n`);

fs.writeFileSync(
  path.join(repoRoot, "scripts/codemods/.eopt-guard-report.txt"),
  allReports.join("\n\n") +
    `\n\n== HAZARD: opaque spread before property, NOT touched (${hazards.length})\n${hazards.join("\n")}` +
    `\n\n== EXPLICIT \`k: undefined\`, NOT touched (${explicitUndefined.length})\n${explicitUndefined.join("\n")}` +
    `\n\n== unhandled (${unhandled.length})\n${unhandled.join("\n")}\n`,
);
process.stdout.write("  report: scripts/codemods/.eopt-guard-report.txt\n");
