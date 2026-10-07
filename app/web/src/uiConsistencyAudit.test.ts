import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * UI consistency ratchet (`app/web/docs/ui-components.md`).
 *
 * Every control, overlay and surface comes from the vendored shadcn components
 * in `src/components/ui/`. This audit counts, per file, the markup that
 * bypasses them, and fails when any count rises above the committed baseline
 * (`uiConsistencyBaseline.json`). Counts may only go down: a file that is not
 * in the baseline may have none.
 *
 * After lowering counts, rewrite the baseline with
 * `UPDATE_UI_BASELINE=1 pnpm exec vitest run src/uiConsistencyAudit.test.ts`.
 * The rewrite never raises an entry.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "..");
const BASELINE_FILE = join(HERE, "uiConsistencyBaseline.json");
const VENDORED_DIR = join(HERE, "components", "ui");

/** Each rule names what to use instead; the doc lists the full mapping. */
const RULES: Record<string, { pattern: RegExp; use: string }> = {
  // `render={<button … />}` is how a shadcn part (an `Item` row) becomes a
  // button, not a hand-styled control.
  "raw-button": {
    pattern: /(?<!render=\{\s*)<button\b/g,
    use: "ui/button (Button), or `render={<button />}` on an Item",
  },
  "raw-input": {
    pattern: /<input\b/g,
    use: "ui/input, ui/checkbox, ui/switch, ui/radio-group, ui/slider",
  },
  "raw-select": { pattern: /<select\b/g, use: "ui/select or ui/native-select" },
  "raw-textarea": {
    pattern: /<textarea\b/g,
    use: "ui/textarea or ui/input-group",
  },
  "hand-menu": {
    pattern: /role="menu(?:item(?:checkbox|radio)?)?"/g,
    use: "ui/dropdown-menu or ui/context-menu",
  },
  "hand-dialog": {
    pattern: /role="(?:alert)?dialog"|aria-modal=/g,
    use: "ui/dialog, ui/alert-dialog, ui/sheet or ui/drawer",
  },
  portal: {
    pattern: /\bcreatePortal\(/g,
    use: "the portal of ui/popover, ui/dialog, ui/sheet, ui/tooltip",
  },
  "palette-color": {
    pattern:
      /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(?:-\d{2,3})?\b/g,
    use: "theme tokens (primary, muted, accent, destructive, success, warning, …)",
  },
  "arbitrary-value": {
    pattern: /\b[a-z-]+-\[[^\]\s]+\]/g,
    use: "the Tailwind scale or a ui/ variant",
  },
};

type Counts = Record<string, Record<string, number>>;

const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);

function shouldScan(path: string): boolean {
  if (path.startsWith(VENDORED_DIR)) return false;
  if (/\.test\.[tj]sx?$/.test(path)) return false;
  if (path.endsWith(".d.ts")) return false;
  const dot = path.lastIndexOf(".");
  return dot >= 0 && SCAN_EXTENSIONS.has(path.slice(dot));
}

function measure(): Counts {
  const counts: Counts = {};
  for (const entry of readdirSync(HERE, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    if (!shouldScan(full)) continue;
    const source = readFileSync(full, "utf8");
    const file = relative(WEB_ROOT, full);
    for (const [rule, { pattern }] of Object.entries(RULES)) {
      const hits = source.match(pattern)?.length ?? 0;
      if (hits === 0) continue;
      (counts[file] ??= {})[rule] = hits;
    }
  }
  return counts;
}

function readBaseline(): Counts | null {
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Counts;
  } catch {
    return null;
  }
}

function sorted(counts: Counts): Counts {
  return Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((file) => [
        file,
        Object.fromEntries(
          Object.keys(counts[file]!)
            .sort()
            .map((rule) => [rule, counts[file]![rule]!]),
        ),
      ]),
  );
}

describe("UI consistency ratchet", () => {
  test("no file bypasses the shadcn components more than its baseline", () => {
    const actual = measure();
    const stored = readBaseline();
    if (stored === null && process.env.UPDATE_UI_BASELINE === "1") {
      // Seeding (the baseline file is absent): record today's debt as-is.
      writeFileSync(
        BASELINE_FILE,
        `${JSON.stringify(sorted(actual), null, 2)}\n`,
      );
      return;
    }
    const baseline = stored ?? {};

    if (process.env.UPDATE_UI_BASELINE === "1") {
      // Lower-only: an entry above its old value keeps the old value, so the
      // rewrite cannot launder a regression into the baseline.
      const next: Counts = {};
      for (const [file, rules] of Object.entries(actual))
        for (const [rule, count] of Object.entries(rules)) {
          const allowed = baseline[file]?.[rule] ?? 0;
          const kept = Math.min(count, allowed);
          if (kept > 0) (next[file] ??= {})[rule] = kept;
        }
      writeFileSync(
        BASELINE_FILE,
        `${JSON.stringify(sorted(next), null, 2)}\n`,
      );
      return;
    }

    const regressions: string[] = [];
    for (const [file, rules] of Object.entries(actual))
      for (const [rule, count] of Object.entries(rules)) {
        const allowed = baseline[file]?.[rule] ?? 0;
        if (count > allowed)
          regressions.push(
            `${file}: ${rule} ${count} > ${allowed} — use ${RULES[rule]!.use}`,
          );
      }
    expect(
      regressions,
      `UI consistency regressions (app/web/docs/ui-components.md):\n${regressions.join("\n")}`,
    ).toEqual([]);
  });
});
