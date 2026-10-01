/**
 * For every diagnostic that resolves to a property inside an object literal,
 * reports the KIND of the offending property's initializer and whether the
 * literal has a spread BEFORE that property.
 *
 * The spread flag is the one that matters: in `{ ...base, k: undefined }` the
 * explicit `undefined` OVERWRITES `base.k`, while omitting the key preserves
 * it. Guarding such a site is a behaviour change, so those sites are listed
 * individually and never auto-applied.
 *
 * Re-run:  node scripts/codemods/eopt-analyze-props.mjs [pkg]
 *          node scripts/codemods/eopt-analyze-props.mjs --spread   (hazard list)
 *          node scripts/codemods/eopt-analyze-props.mjs --kind=call
 */
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { PACKAGES, collect } from "./eopt-diagnostics.mjs";
import { shapeOf, sourceFileFor } from "./eopt-classify.mjs";

/** The object literal a diagnostic is about, searched from the reported node. */
export function literalFor(sf, diag) {
  const { shape, node } = shapeOf(sf, diag);
  if (!node) return null;
  if (ts.isObjectLiteralExpression(node)) return node;
  if (shape === "object-literal-prop") {
    return ts.isObjectLiteralExpression(node.parent) ? node.parent : null;
  }
  // `return {...}` / `const x: T = {...}` / `f({...})`: descend to the literal.
  const found = [];
  const visit = (n) => {
    if (ts.isObjectLiteralExpression(n)) found.push(n);
    else ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found.length === 1 ? found[0] : (found[0] ?? null);
}

/** The property assignment for `name`, searched depth-first through nesting. */
export function propertyFor(literal, name) {
  const hits = [];
  const walk = (lit) => {
    for (const p of lit.properties) {
      const pname =
        p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
          ? p.name.text
          : null;
      if (
        pname === name &&
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))
      ) {
        hits.push({ prop: p, literal: lit });
      }
      if (
        ts.isPropertyAssignment(p) &&
        ts.isObjectLiteralExpression(p.initializer)
      ) {
        walk(p.initializer);
      }
      // A guard this codemod already wrote — `...(cond ? { k: v } : {})` — can
      // itself still hold a `v` that is optional, when `v` came from a call
      // returning `T | undefined`. Descend so a later pass can guard it too.
      if (ts.isSpreadAssignment(p)) {
        for (const inner of spreadLiterals(p.expression)) walk(inner);
      }
    }
  };
  walk(literal);
  return hits.length === 1 ? hits[0] : null;
}

/** The object literals a spread expression can contribute, syntactically. */
function spreadLiterals(expr) {
  if (ts.isParenthesizedExpression(expr))
    return spreadLiterals(expr.expression);
  if (ts.isObjectLiteralExpression(expr)) return [expr];
  if (ts.isConditionalExpression(expr)) {
    return [
      ...spreadLiterals(expr.whenTrue),
      ...spreadLiterals(expr.whenFalse),
    ];
  }
  return [];
}

/**
 * The set of property names a spread expression can contribute, or null when
 * that cannot be known from syntax alone.
 *
 * `...{ a: 1 }` and `...(c ? { a: 1 } : {})` have statically known keys, so a
 * spread of that shape provably cannot supply some OTHER key. `...base` is
 * opaque and might supply anything.
 */
function spreadKeys(expr) {
  if (ts.isParenthesizedExpression(expr)) return spreadKeys(expr.expression);
  if (ts.isObjectLiteralExpression(expr)) {
    const keys = new Set();
    for (const p of expr.properties) {
      if (ts.isSpreadAssignment(p)) {
        const inner = spreadKeys(p.expression);
        if (!inner) return null;
        for (const k of inner) keys.add(k);
      } else if (
        p.name &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
      ) {
        keys.add(p.name.text);
      } else {
        return null;
      }
    }
    return keys;
  }
  if (ts.isConditionalExpression(expr)) {
    const a = spreadKeys(expr.whenTrue);
    const b = spreadKeys(expr.whenFalse);
    if (!a || !b) return null;
    return new Set([...a, ...b]);
  }
  return null;
}

/**
 * Whether omitting `prop`'s key could let a PRECEDING spread show through.
 * Returns "none", "safe" (every preceding spread has known keys and none of
 * them is this one), or "opaque" (a spread that might supply this key).
 *
 * Only "opaque" is a real behaviour hazard — see the module comment.
 */
export function spreadHazard(literal, prop) {
  const name =
    prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
      ? prop.name.text
      : null;
  let sawSpread = false;
  for (const p of literal.properties) {
    if (p === prop) break;
    if (!ts.isSpreadAssignment(p)) continue;
    sawSpread = true;
    const keys = spreadKeys(p.expression);
    if (!keys || name === null || keys.has(name)) return "opaque";
  }
  return sawSpread ? "safe" : "none";
}

/** True when a spread appears before `prop` — see the module comment. */
export function hasSpreadBefore(literal, prop) {
  return spreadHazard(literal, prop) !== "none";
}

/**
 * Is this expression safe to evaluate TWICE (once in the guard, once in the
 * value)? Only identifiers, `this`, literals and plain/optional property access
 * chains over those qualify. Anything else must be bound to a const first.
 */
export function isCheap(expr) {
  if (ts.isIdentifier(expr) || expr.kind === ts.SyntaxKind.ThisKeyword)
    return true;
  if (ts.isStringLiteral(expr) || ts.isNumericLiteral(expr)) return true;
  if (ts.isPropertyAccessExpression(expr)) return isCheap(expr.expression);
  if (ts.isElementAccessExpression(expr)) {
    return isCheap(expr.expression) && isCheap(expr.argumentExpression);
  }
  if (ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr)) {
    return isCheap(expr.expression);
  }
  return false;
}

/** A ternary whose false branch is literally `undefined` — idiom #2. */
export function undefinedTernary(expr) {
  if (!ts.isConditionalExpression(expr)) return null;
  const isU = (n) => ts.isIdentifier(n) && n.text === "undefined";
  if (isU(expr.whenFalse))
    return { cond: expr.condition, value: expr.whenTrue, negate: false };
  if (isU(expr.whenTrue))
    return { cond: expr.condition, value: expr.whenFalse, negate: true };
  return null;
}

export function kindOf(prop) {
  if (ts.isShorthandPropertyAssignment(prop)) return "shorthand";
  const e = prop.initializer;
  if (undefinedTernary(e)) return "ternary-undefined";
  if (ts.isConditionalExpression(e)) return "ternary-other";
  if (isCheap(e)) return "cheap";
  if (ts.isCallExpression(e)) return "call";
  if (ts.isBinaryExpression(e))
    return `binary:${ts.tokenToString(e.operatorToken.kind)}`;
  if (ts.isObjectLiteralExpression(e)) return "object";
  if (ts.isAwaitExpression(e)) return "await";
  return `other:${ts.SyntaxKind[e.kind]}`;
}

function main() {
  const args = process.argv.slice(2);
  const kindFilter = args.find((a) => a.startsWith("--kind="))?.slice(7);
  const spreadOnly = args.includes("--spread");
  const pkgArg = args.find((a) => !a.startsWith("--"));
  const diags = collect(pkgArg ? [pkgArg] : PACKAGES);

  const kinds = new Map();
  const spreads = [];
  let unresolved = 0;

  for (const d of diags) {
    const sf = sourceFileFor(d.file);
    const { shape } = shapeOf(sf, d);
    if (
      ![
        "object-literal",
        "return",
        "variable-decl",
        "object-literal-prop",
        "call-arg",
      ].includes(shape)
    ) {
      continue;
    }
    const literal = literalFor(sf, d);
    const hit =
      literal && d.props.length > 0 ? propertyFor(literal, d.props[0]) : null;
    if (!hit) {
      unresolved++;
      continue;
    }
    const kind = kindOf(hit.prop);
    const spread = hasSpreadBefore(hit.literal, hit.prop);
    const rec = {
      d,
      kind,
      spread,
      text: hit.prop.getText(sf).split("\n")[0].slice(0, 90),
    };
    if (!kinds.has(kind)) kinds.set(kind, []);
    kinds.get(kind).push(rec);
    if (spread) spreads.push(rec);
  }

  if (spreadOnly) {
    for (const r of spreads) {
      process.stdout.write(`${r.d.file}:${r.d.line} [${r.kind}] ${r.text}\n`);
    }
    process.stdout.write(
      `\n${spreads.length} sites with a spread BEFORE the guarded property\n`,
    );
    return;
  }
  if (kindFilter) {
    for (const r of kinds.get(kindFilter) ?? []) {
      process.stdout.write(
        `${r.d.file}:${r.d.line}${r.spread ? " SPREAD" : ""} ${r.text}\n`,
      );
    }
    return;
  }
  for (const [kind, list] of [...kinds.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const s = list.filter((r) => r.spread).length;
    process.stdout.write(
      `${String(list.length).padStart(4)}  ${kind.padEnd(24)} spread-before=${s}\n`,
    );
  }
  process.stdout.write(
    `${String(unresolved).padStart(4)}  (property not resolved syntactically)\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
