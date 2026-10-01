/**
 * Reports the SYNTACTIC shape at each exactOptionalPropertyTypes error site,
 * grouped, so the fix strategy is chosen from evidence rather than assumption.
 *
 * Read-only: it never edits a file. Run it before and after a codemod to see
 * what is left.
 *
 * Re-run:  node scripts/codemods/eopt-classify.mjs [shared|server|web]
 *          node scripts/codemods/eopt-classify.mjs --shape=jsx-attribute
 *            (lists the individual sites of one shape)
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { PACKAGES, collect } from "./eopt-diagnostics.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const sourceCache = new Map();

export function sourceFileFor(file) {
  let sf = sourceCache.get(file);
  if (!sf) {
    const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
    sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    sourceCache.set(file, sf);
  }
  return sf;
}

/** Drop the parse cache — required between codemod passes that rewrote files. */
export function resetSourceCache() {
  sourceCache.clear();
}

/** The innermost node starting at, or containing, the reported position. */
export function nodeAt(sf, line, col) {
  const pos = ts.getPositionOfLineAndCharacter(sf, line - 1, col - 1);
  let best = null;
  const visit = (node) => {
    if (node.getStart(sf) <= pos && pos < node.getEnd()) {
      best = node;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sf, visit);
  return best;
}

/** Classify what kind of source construct the error is pointing at. */
export function shapeOf(sf, diag) {
  const node = nodeAt(sf, diag.line, diag.col);
  if (!node) return { shape: "not-found", node: null };
  let n = node;
  // Walk out of the identifier/expression to the meaningful enclosing construct.
  for (let hops = 0; n && hops < 6; hops++, n = n.parent) {
    if (ts.isJsxAttribute(n)) return { shape: "jsx-attribute", node: n };
    if (ts.isJsxSpreadAttribute(n)) return { shape: "jsx-spread", node: n };
    // tsc reports a whole-element prop mismatch at the TAG NAME, so the error
    // position lands on the component identifier rather than the attribute.
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      return { shape: "jsx-element", node: n };
    }
    if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) {
      return { shape: "object-literal-prop", node: n };
    }
    if (ts.isObjectLiteralExpression(n)) {
      return { shape: "object-literal", node: n };
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      return { shape: "assignment", node: n };
    }
    if (ts.isVariableDeclaration(n)) return { shape: "variable-decl", node: n };
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      return { shape: "call-arg", node: n };
    }
    if (ts.isReturnStatement(n)) return { shape: "return", node: n };
    if (ts.isSatisfiesExpression?.(n)) return { shape: "satisfies", node: n };
    if (ts.isAsExpression(n)) return { shape: "as-cast", node: n };
    if (ts.isPropertySignature(n))
      return { shape: "property-signature", node: n };
  }
  return { shape: `other:${ts.SyntaxKind[node.kind]}`, node };
}

function main() {
  const args = process.argv.slice(2);
  const shapeFilter = args.find((a) => a.startsWith("--shape="))?.slice(8);
  const pkgArg = args.find((a) => !a.startsWith("--"));
  const diags = collect(pkgArg ? [pkgArg] : PACKAGES);

  const groups = new Map();
  for (const d of diags) {
    const { shape } = shapeOf(sourceFileFor(d.file), d);
    if (!groups.has(shape)) groups.set(shape, []);
    groups.get(shape).push(d);
  }

  if (shapeFilter) {
    for (const d of groups.get(shapeFilter) ?? []) {
      process.stdout.write(
        `${d.file}:${d.line}:${d.col} ${d.code} [${d.props.join(",")}]\n`,
      );
    }
    return;
  }

  const rows = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [shape, list] of rows) {
    const codes = {};
    for (const d of list) codes[d.code] = (codes[d.code] ?? 0) + 1;
    const tests = list.filter((d) =>
      /\.(test|spec)\.[tj]sx?$/.test(d.file),
    ).length;
    process.stdout.write(
      `${String(list.length).padStart(4)}  ${shape.padEnd(22)} ` +
        `tests=${String(tests).padStart(3)}  ` +
        Object.entries(codes)
          .sort((a, b) => b[1] - a[1])
          .map(([c, n]) => `${c}:${n}`)
          .join(" ") +
        "\n",
    );
  }
  process.stdout.write(`${String(diags.length).padStart(4)}  TOTAL\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
