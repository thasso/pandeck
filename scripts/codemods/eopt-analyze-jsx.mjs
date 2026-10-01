/**
 * Maps every JSX exactOptionalPropertyTypes site to the (component, prop) pair
 * it is about, so the number of DECLARATIONS to widen is known before any edit.
 *
 * `<C x={maybe} />` and omitting `x` are indistinguishable to React, so for a
 * component prop the honest declaration really is `x?: T | undefined` — fixed
 * once, at the declaration, rather than guarded at each of its call sites.
 *
 * Re-run:  node scripts/codemods/eopt-analyze-jsx.mjs
 *          node scripts/codemods/eopt-analyze-jsx.mjs --pairs
 */
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { collect } from "./eopt-diagnostics.mjs";
import { shapeOf, sourceFileFor } from "./eopt-classify.mjs";

/** The tag name of the JSX element a diagnostic points at. */
function tagNameOf(node) {
  const el =
    ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)
      ? node
      : ts.isJsxAttribute(node)
        ? node.parent.parent
        : null;
  if (!el) return null;
  return el.tagName.getText(el.getSourceFile());
}

export function jsxSites(diags) {
  const out = [];
  for (const d of diags) {
    const sf = sourceFileFor(d.file);
    const { shape, node } = shapeOf(sf, d);
    if (shape !== "jsx-element" && shape !== "jsx-attribute") continue;
    const tag = tagNameOf(node);
    if (!tag) continue;
    for (const prop of d.props.length > 0 ? d.props : ["<unnamed>"]) {
      out.push({ ...d, tag, prop });
    }
  }
  return out;
}

function main() {
  const sites = jsxSites(collect());
  const pairs = new Map();
  for (const s of sites) {
    const key = `${s.tag}.${s.prop}`;
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(s);
  }
  if (process.argv.includes("--pairs")) {
    for (const [key, list] of [...pairs.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )) {
      process.stdout.write(`${String(list.length).padStart(3)}  ${key}\n`);
    }
    return;
  }
  const components = new Set([...pairs.keys()].map((k) => k.split(".")[0]));
  process.stdout.write(
    `${sites.length} JSX prop sites\n` +
      `${pairs.size} distinct (component, prop) pairs\n` +
      `${components.size} distinct components\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
