import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Typography source audit (Task-184) — strict zero-bypass mode.
 *
 * Tailwind's stock `text-xs/sm/base/lg/xl` utilities (the scale shadcn
 * components use) and their paired line heights are the ONLY typography sizes
 * the web client may use; `app/web/src/index.css` multiplies them by the
 * `--text-scale` preference. The vendored shadcn components in
 * `src/components/ui/` are generated code and exempt.
 * This test scans first-party production sources and fails on any bypass:
 *
 *  - arbitrary Tailwind font sizes (`text-[12px]`, `text-[0.86em]`, …)
 *  - Tailwind sizes above the scale (`text-2xl` … `text-9xl`)
 *  - direct `font-size:` declarations / inline `fontSize:`/`fontSize =` sets
 *    outside the owning stylesheet
 *  - component-level `leading-*` overrides that defeat the role line heights
 *
 * The `font-size`/`fontSize` rules deliberately match DECLARATIONS and
 * ASSIGNMENTS, not reads: the one documented Task-184 exception — Chart.js
 * needing numeric canvas pixels — READS the computed role sizes off the DOM
 * (`getComputedStyle(el).fontSize`) and passes the numbers through, which is
 * the sanctioned way to derive an exceptional visualization value from the
 * central tokens. There is no baseline; new bypasses fail immediately.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "..");

// The owning stylesheet defines every token/utility and is exempt.
const OWNER_FILES = new Set([join(HERE, "index.css")]);
// Vendored shadcn components (`shadcn add`) are generated code.
const VENDORED_DIR = join(HERE, "components", "ui");

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".css", ".html"]);

/** Forbidden typography patterns. */
const RULES: readonly RegExp[] = [
  // Arbitrary Tailwind font size with an explicit CSS length unit.
  /\btext-\[\s*\d[\d.]*(?:px|rem|em|pt)\s*\]/g,
  // Tailwind sizes above the app's scale.
  /\btext-\d+xl\b/g,
  // CSS font-size declaration outside the owning stylesheet.
  /font-size\s*:/g,
  // Inline React fontSize set (object property or property assignment), NOT a
  // computed read like `getComputedStyle(el).fontSize`.
  /\bfontSize\s*[:=]/g,
  // Component-level line-height overrides that defeat the paired role heights.
  /\bleading-(?:none|tight|snug|normal|relaxed|loose|\d+|\[[^\]]*\])\b/g,
];

function shouldScan(path: string): boolean {
  if (OWNER_FILES.has(path)) return false;
  if (path.startsWith(VENDORED_DIR)) return false;
  if (path.endsWith(".d.ts")) return false;
  if (/\.test\.[tj]sx?$/.test(path)) return false;
  if (/typographyAudit\./.test(path)) return false;
  const dot = path.lastIndexOf(".");
  return dot >= 0 && SCAN_EXTENSIONS.has(path.slice(dot));
}

function collectFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(HERE, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    if (shouldScan(full)) files.push(full);
  }
  const indexHtml = join(WEB_ROOT, "index.html");
  if (shouldScan(indexHtml)) files.push(indexHtml);
  return files.sort();
}

function findViolations(source: string): string[] {
  const hits: string[] = [];
  for (const rule of RULES) {
    for (const m of source.match(rule) ?? []) hits.push(m);
  }
  return hits;
}

describe("typography source audit", () => {
  test("first-party production sources use only the stock type scale", () => {
    const offenders: string[] = [];
    for (const file of collectFiles()) {
      const hits = findViolations(readFileSync(file, "utf8"));
      if (hits.length > 0)
        offenders.push(`${relative(WEB_ROOT, file)}: ${hits.join(", ")}`);
    }
    expect(
      offenders,
      `Typography bypasses (use text-xs/sm/base/lg/xl):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
