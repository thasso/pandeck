import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Loading-state source audit (Task-361 / Task-383).
 *
 * `components/common/load.tsx` owns every loading, empty and error affordance the
 * web client draws: the spinner glyph and its size tokens, the skeleton pulse,
 * the refresh indicator, the dashed empty box and the error note. A surface
 * that hand-rolls one of them drifts by construction — before this audit the
 * app had spinners at every size between 9 and 22, three unrelated skeleton
 * treatments, and the dashed empty box re-implemented inline eight times over.
 * This test scans first-party production sources and fails on:
 *
 *  - `animate-spin` / `animate-pulse` outside the owning module (this also
 *    catches a SPINNING `RefreshCw`; importing `RefreshCw` as a static refresh
 *    icon stays fine);
 *  - `LoaderCircle` / `Loader2`, the two spinner glyphs, outside it;
 *  - `border-dashed`, which in this app means an empty state, outside it.
 *
 * The model these rules serve is `app/web/docs/loading-states.md`; the binding
 * summary is `components/CLAUDE.md`.
 *
 * NO ALLOWLIST, and never again one. The audit landed in Phase 1 with a frozen
 * census of the files that predated the model, because the migration was phased
 * (Task-361 phases 2–6) and a rule that only arrives at the end protects nothing
 * in between; Phase 6 (Task-391) emptied it and deleted it, so this is now a
 * zero-bypass audit like `typographyAudit.test.ts`. A new bypass is a bug in the
 * change that introduced it, not a line to add here.
 *
 * The two treatments that are NOT loading states kept their look and lost their
 * exemption, which is what "one owner" has to mean if it means anything:
 * `common/load.tsx` exports them as named class tokens, so the vocabulary still
 * lives in one module and a reviewer sees the import.
 *
 *  - `LIVE_PULSE` — the dictation `Mic` arming and a row's streaming
 *    underline. Nothing has been ASKED for in either, so a spinner would pose a
 *    question the user cannot answer.
 *  - `DASHED_EDGE` — a fillable slot (`NewSessionQuickStart`'s "New worktree"
 *    and "More…"), a provisional object (the queued-prompt bubble in
 *    `MessageList` and `PeerPromptCard`, the pending reply in
 *    `KnowledgeComments`), and an unresolved reference (`ProjectBadge`'s
 *    unknown project). A region with nothing in it is none of those: it uses
 *    `EmptyBox`.
 *
 * The scroller empty item Phase 5 flagged — `NewSessionQuickStart`'s "No
 * worktrees / in <project>" card, which has to carry the snapping and two-line
 * geometry of the worktree cards beside it — became `EmptyBox`'s `item`
 * variant, and `SessionDeliveryMark`'s `creating` mark, a still `LoaderCircle`
 * that was the app's spinner stopped, became the spinner it looked like.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** The module that owns all of it. */
const OWNER_FILES = new Set([join(HERE, "components", "common", "load.tsx")]);

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".css"]);

interface Rule {
  id: string;
  pattern: RegExp;
  /** What the offending source should use instead. */
  fix: string;
}

const RULES: readonly Rule[] = [
  {
    id: "animate-spin",
    pattern: /\banimate-spin\b/g,
    fix: "use `Spinner`/`RefreshIndicator`/`Button busy` from `common/load.tsx`",
  },
  {
    id: "animate-pulse",
    pattern: /\banimate-pulse\b/g,
    fix: "use `Skeleton` from `common/load.tsx`",
  },
  {
    id: "spinner-icon",
    pattern: /\b(?:LoaderCircle|Loader2)\b/g,
    fix: "use `Spinner` from `common/load.tsx`",
  },
  {
    id: "border-dashed",
    pattern: /\bborder-dashed\b/g,
    fix: "use `EmptyBox` from `common/load.tsx`",
  },
];

function shouldScan(path: string): boolean {
  if (OWNER_FILES.has(path)) return false;
  if (path.endsWith(".d.ts")) return false;
  if (/\.test\.[tj]sx?$/.test(path)) return false;
  if (/loadingStateAudit\./.test(path)) return false;
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
  return files.sort();
}

/**
 * Source-relative, POSIX-separated: how an offender is named in the failure
 * messages below, so a path reads the same on every platform.
 */
function sourcePath(file: string): string {
  return relative(HERE, file).split(sep).join("/");
}

/**
 * The file's lines with comment TEXT blanked out and the line count kept, so a
 * scan that reconstructs JSX cannot be tripped by prose about JSX — this file's
 * own rules are quoted in several doc comments, `common/load.tsx`'s among them. Only
 * block comments and whole-line `//` are blanked: a trailing `//` is left alone
 * rather than risk eating code after a `https://` in an attribute.
 */
function codeLines(source: string): string[] {
  let inBlock = false;
  return source.split("\n").map((line) => {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      return "";
    }
    if (trimmed.startsWith("//")) return "";
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlock = true;
      return "";
    }
    return line;
  });
}

function violationsByRule(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>(
    RULES.map((rule) => [rule.id, new Set<string>()]),
  );
  for (const file of collectFiles()) {
    const source = readFileSync(file, "utf8");
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(source)) found.get(rule.id)!.add(sourcePath(file));
    }
  }
  return found;
}

describe("loading-state source audit", () => {
  test("loading, empty and error chrome comes only from common/load.tsx", () => {
    const found = violationsByRule();
    const offenders: string[] = [];
    for (const rule of RULES) {
      for (const file of [...found.get(rule.id)!].sort())
        offenders.push(`${file}: ${rule.id} — ${rule.fix}`);
    }
    expect(
      offenders,
      `Hand-rolled loading affordances (see app/web/docs/loading-states.md):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // R6. With the allowlist gone the rule above already keeps these classes out
  // of every file but the owner, so this holds the line the rule above cannot
  // see: a `.css` file that reaches for one through `@apply`, and any future
  // exception someone argues for — an animation may exist somewhere else only
  // if it still stops for a reader who asked the OS for less motion.
  test("every animation still outside common/load.tsx is motion-safe", () => {
    const bare = /(?<!motion-safe:)\banimate-(?:spin|pulse)\b/;
    const offenders: string[] = [];
    for (const file of collectFiles()) {
      for (const [index, line] of codeLines(
        readFileSync(file, "utf8"),
      ).entries()) {
        if (bare.test(line))
          offenders.push(`${sourcePath(file)}:${index + 1}: ${line.trim()}`);
      }
    }
    expect(
      offenders,
      `Loading animation without \`motion-safe:\` (R6):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  /**
   * The other half of R6, and the trap this audit exists to keep shut: an
   * announcing region must not ALSO be `aria-busy`. A busy live region is the
   * documented licence for assistive tech to hold its output back until busy
   * clears — and a loading region clears by unmounting when the data lands, so
   * "Loading Tasks" can be deferred into never being said. The flag belongs on
   * the persistent container being swapped (`Inspector`'s body, `QuickRow`'s
   * `busy`, a transcript block's body element), which really does go true→false
   * in place. `common/load.tsx` is scanned like every other file here, and
   * `aria-live` counts as announcing too — the deferral applies to any live
   * region, not only the ones spelled `role="status"`.
   */
  test("no announcing region is also marked aria-busy", () => {
    const offenders: string[] = [];
    for (const file of [...collectFiles(), ...OWNER_FILES]) {
      const lines = codeLines(readFileSync(file, "utf8"));
      lines.forEach((line, index) => {
        if (!line.includes('role="status"') && !line.includes("aria-live"))
          return;
        // The element's opening tag: back to the line that opens it, forward to
        // the line that closes it (Prettier puts one attribute per line).
        let start = index;
        while (start > 0 && !(lines[start] ?? "").includes("<")) start -= 1;
        let end = index;
        while (end < lines.length - 1 && !/>\s*$/.test(lines[end] ?? ""))
          end += 1;
        if (
          lines
            .slice(start, end + 1)
            .join("\n")
            .includes("aria-busy")
        )
          offenders.push(`${sourcePath(file)}:${index + 1}`);
      });
    }
    expect(
      offenders,
      `\`aria-busy\` on a live region can silence it (R6) — move it to the container being replaced:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
