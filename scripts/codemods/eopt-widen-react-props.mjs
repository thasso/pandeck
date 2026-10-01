/**
 * CODEMOD 1 of 3 — widens a REACT COMPONENT PROP declaration from `x?: T` to
 * `x?: T | undefined`.
 *
 * WHY this is the honest fix here, and not a cop-out: `<C x={maybe} />` and
 * omitting `x` entirely are indistinguishable to React — both leave
 * `props.x === undefined`. So a component prop really does accept undefined,
 * and saying so once at the declaration beats guarding every call site with a
 * conditional spread into JSX. Every OTHER kind of site is guarded at the use
 * site instead (see eopt-guard-object-props.mjs).
 *
 * It is deliberately per-prop and explicit rather than a `ReactProps<T>` mapped
 * type over each props interface. Such a wrapper DOES work — see
 * `docs/linting.md` for the type and why it is still not used: it hides the
 * widening from anyone reading the interface, it has to be applied consistently
 * wherever a props type is composed, and an explicit `?: T | undefined` is
 * greppable, which is what makes the rule enforceable.
 *
 * Scope guard: it only edits declarations under `app/web/src`. A prop whose
 * declaration lives in `app/shared` is a WIRE type — widening that would make
 * the flag stop helping the protocol, which is the whole point of enabling it —
 * so those are reported and left alone.
 *
 * ts6 is used only to resolve a JSX attribute to its property DECLARATION.
 * Which sites are wrong comes from v7 tsc; whether the fix worked is re-checked
 * with v7 tsc. See eopt-diagnostics.mjs for why that split exists.
 *
 * Widening one prop can reveal another: a component that forwards its now-
 * widened prop into a child makes the child's prop receive undefined too. So it
 * runs PASSES until nothing changes, rebuilding the program each time, and
 * appends every widening to `.eopt-widened-props.txt` for review.
 *
 * Re-run:  node scripts/codemods/eopt-widen-react-props.mjs [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { collect } from "./eopt-diagnostics.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const dry = process.argv.includes("--dry");
const MAX_PASSES = 25;

const cfgPath = path.join(repoRoot, "app/web/tsconfig.json");
const cfg = ts.getParsedCommandLineOfConfigFile(
  cfgPath,
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(String(d.messageText));
    },
  },
);

/** The innermost JSX opening/self-closing element at a reported position. */
function jsxElementAt(sf, line, col) {
  const pos = ts.getPositionOfLineAndCharacter(sf, line - 1, col - 1);
  let best = null;
  const visit = (node) => {
    if (node.getStart(sf) <= pos && pos < node.getEnd()) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
        best = node;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sf, visit);
  return best;
}

/** The props-object type of a component referenced by a JSX tag. */
function propsTypeOf(checker, element) {
  const tagType = checker.getTypeAtLocation(element.tagName);
  for (const sig of [
    ...tagType.getCallSignatures(),
    ...tagType.getConstructSignatures(),
  ]) {
    const param = sig.getParameters()[0];
    if (!param) continue;
    return checker.getTypeOfSymbolAtLocation(param, element);
  }
  return null;
}

/** One pass: returns {applied, widened, skipped, unresolved}. */
function pass() {
  const program = ts.createProgram(cfg.fileNames, {
    ...cfg.options,
    exactOptionalPropertyTypes: true,
  });
  const checker = program.getTypeChecker();

  const edits = new Map();
  const skipped = [];
  const unresolved = [];
  const widened = [];

  for (const d of collect(["web"])) {
    const sf = program.getSourceFile(path.join(repoRoot, d.file));
    if (!sf) continue;
    const element = jsxElementAt(sf, d.line, d.col);
    if (!element) continue;
    const propsType = propsTypeOf(checker, element);
    const tag = element.tagName.getText(sf);
    if (!propsType) {
      unresolved.push(`${d.file}:${d.line} ${tag} (props type unresolved)`);
      continue;
    }
    for (const propName of d.props) {
      const symbol = propsType.getProperty(propName);
      const decl = symbol?.declarations?.find(
        (x) => ts.isPropertySignature(x) || ts.isPropertyDeclaration(x),
      );
      if (!decl?.type) {
        unresolved.push(`${d.file}:${d.line} ${tag}.${propName}`);
        continue;
      }
      // Only an OPTIONAL prop can be widened this way; a required one that gets
      // undefined is a real type error the flag did not invent.
      if (!decl.questionToken) {
        unresolved.push(
          `${d.file}:${d.line} ${tag}.${propName} (not optional)`,
        );
        continue;
      }
      const declSf = decl.getSourceFile();
      const declFile = path.relative(repoRoot, declSf.fileName);
      if (!declFile.startsWith("app/web/src")) {
        skipped.push(
          `${declFile} :: ${tag}.${propName} (from ${d.file}:${d.line})`,
        );
        continue;
      }
      const typeText = decl.type.getText(declSf);
      if (/\|\s*undefined\s*$/.test(typeText)) continue;
      const key = `${declFile}#${decl.type.getStart(declSf)}`;
      if (edits.has(key)) continue;
      edits.set(key, {
        file: declFile,
        start: decl.type.getStart(declSf),
        end: decl.type.getEnd(),
        // A bare function type needs parens: `() => void | undefined` parses as
        // a function returning `void | undefined`, which is not the intent.
        text:
          ts.isFunctionTypeNode(decl.type) ||
          ts.isConstructorTypeNode(decl.type)
            ? `(${typeText}) | undefined`
            : `${typeText} | undefined`,
      });
      widened.push(`${declFile}\t${decl.name.getText(declSf)}?: ${typeText}`);
    }
  }

  const byFile = new Map();
  for (const e of edits.values()) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  let applied = 0;
  for (const [file, list] of byFile) {
    const abs = path.join(repoRoot, file);
    let text = fs.readFileSync(abs, "utf8");
    for (const e of list.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, e.start) + e.text + text.slice(e.end);
      applied++;
    }
    if (!dry) fs.writeFileSync(abs, text);
  }
  return { applied, widened, skipped, unresolved };
}

const allWidened = [];
let lastSkipped = [];
let lastUnresolved = [];
let passes = 0;
for (; passes < MAX_PASSES; passes++) {
  const r = pass();
  allWidened.push(...r.widened);
  lastSkipped = r.skipped;
  lastUnresolved = r.unresolved;
  process.stdout.write(`pass ${passes + 1}: ${r.applied} widened\n`);
  // --dry must not loop: nothing was written, so every pass repeats itself.
  if (r.applied === 0 || dry) break;
}

process.stdout.write(
  `\n${dry ? "[dry] " : ""}${allWidened.length} prop declarations widened over ${passes + 1} pass(es)\n`,
);
if (allWidened.length > 0) {
  fs.writeFileSync(
    path.join(repoRoot, "scripts/codemods/.eopt-widened-props.txt"),
    [...new Set(allWidened)].sort().join("\n") + "\n",
  );
  process.stdout.write(
    "  full list: scripts/codemods/.eopt-widened-props.txt\n",
  );
}
if (lastSkipped.length > 0) {
  process.stdout.write(
    `\nNOT widened — declaration outside app/web/src (${lastSkipped.length}):\n`,
  );
  for (const s of [...new Set(lastSkipped)].sort())
    process.stdout.write(`  ${s}\n`);
}
if (lastUnresolved.length > 0) {
  process.stdout.write(
    `\nleft for the guard codemod / hand (${lastUnresolved.length}):\n`,
  );
  for (const s of [...new Set(lastUnresolved)].sort())
    process.stdout.write(`  ${s}\n`);
}
