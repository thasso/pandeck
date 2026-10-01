/**
 * Collects `exactOptionalPropertyTypes` diagnostics for one or all packages.
 *
 * WHY this exists: the workspace compiles with typescript@7, which ships no
 * JavaScript compiler API, so a codemod cannot ask it which sites are wrong.
 * The root typescript@6 (catalogs.codemods) HAS the API but is a different
 * compiler and may disagree — see scripts/codemods/README.md.
 *
 * So the split is deliberate and load-bearing:
 *   - v7 `tsc` decides WHICH sites are errors (it is the authority),
 *   - ts6's parser is used only for SYNTAX in the codemods (where the two
 *     compilers cannot disagree). No type inference is ever taken from ts6.
 *
 * Re-run:  node scripts/codemods/eopt-diagnostics.mjs [shared|server|web]
 * Prints a JSON array of {pkg,file,line,col,code,message,props}.
 * `props` are the property names tsc named as incompatible, in order.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const PACKAGES = ["shared", "server", "web"];

/** A missing binary makes `tsc | grep -c` report a confident zero. Refuse to guess. */
function tscFor(pkg) {
  const bin = path.join(repoRoot, "app", pkg, "node_modules/.bin/tsc");
  if (!existsSync(bin)) {
    throw new Error(
      `no tsc for @assistant/${pkg} at ${bin} — run pnpm install; ` +
        `there is deliberately no tsc at the repo root`,
    );
  }
  return bin;
}

/** Raw `tsc --exactOptionalPropertyTypes` output for one package. */
export function rawDiagnostics(pkg) {
  const bin = tscFor(pkg);
  try {
    execFileSync(
      bin,
      [
        "--noEmit",
        "--exactOptionalPropertyTypes",
        "-p",
        path.join(repoRoot, "app", pkg, "tsconfig.json"),
      ],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
    );
    return "";
  } catch (error) {
    // tsc exits non-zero when it reports errors; that is the expected path.
    if (typeof error.stdout !== "string") throw error;
    return error.stdout;
  }
}

const HEADER = /^([^\s(][^(]*)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const PROP = /property '([^']+)'/g;

/** Parse tsc's output: one header line per error, indented continuation lines. */
export function parseDiagnostics(pkg, raw) {
  const out = [];
  for (const line of raw.split("\n")) {
    const m = HEADER.exec(line);
    if (m) {
      out.push({
        pkg,
        file: m[1],
        line: Number(m[2]),
        col: Number(m[3]),
        code: m[4],
        message: m[5],
        detail: [],
      });
    } else if (line.startsWith(" ") && out.length > 0) {
      out[out.length - 1].detail.push(line.trim());
    }
  }
  for (const d of out) {
    const props = new Set();
    for (const text of [d.message, ...d.detail]) {
      for (const p of text.matchAll(PROP)) props.add(p[1]);
    }
    d.props = [...props];
    d.detail = d.detail.join(" ");
  }
  return out;
}

export function collect(pkgs = PACKAGES) {
  return pkgs.flatMap((pkg) => parseDiagnostics(pkg, rawDiagnostics(pkg)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  const pkgs = arg ? [arg] : PACKAGES;
  process.stdout.write(JSON.stringify(collect(pkgs), null, 2) + "\n");
}
