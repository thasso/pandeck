import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Task save title source audit (Task-303).
 *
 * `TaskSaveRequest.title` is required on a create and optional on an update,
 * where omitting it leaves the stored title alone (Task-297). A surface that is
 * not editing the title must therefore OMIT it: a save built from a snapshot —
 * an agent's recorded Task card, a cached row — that echoes the title it holds
 * rewrites a title that has since changed, and nobody confirming a status means
 * to rename anything. The remaining web echoes were dropped in Task-303.
 *
 * A per-handler test cannot hold that: it only covers the call sites someone
 * remembered to test, while the failure mode is a NEW save (or a re-added
 * `title: item.title`) nobody wrote a test for. So this scans first-party
 * sources for `saveTask(...)` calls and compares the title-carrying ones
 * against the sanctioned list below as a MULTISET: a third such save fails even
 * when it copies a sanctioned file and expression, and a sanctioned entry that
 * matches nothing fails too.
 *
 * Its reach is what a regex can see: a `title` written in the request literal
 * AT the call. A request assembled beforehand and passed by name
 * (`const request = { …, title: item.title }; actions.saveTask(request)`)
 * escapes it, as do titles reaching a save through a spread variable. Parsing
 * TypeScript to close that is not worth it — this catches the shape the echoes
 * actually had — but do not read it as proof that no save carries a title.
 *
 * This is about `title` only. `status` is NOT the same case and must keep being
 * echoed: the server coerces a missing status to `"todo"` (`normalizeTaskStatus`
 * in `connection.ts`), so an update that omits it silently resets the Task.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "..");

const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);

/**
 * One entry per save that may carry a title, as `<file>: <title expression>`.
 * Both pass a title the user just typed — never a copy read back off a Task.
 * The list is exact, not a set of permissions: a second save in a sanctioned
 * file writing the same expression is a new save and has to be justified here.
 */
const SANCTIONED: readonly string[] = [
  // BacklogList.addTask: the composer's new-Task title, required on a create.
  "src/components/BacklogList.tsx: title",
  // TaskManagementPage.renameTask: the title the user just edited.
  "src/components/TaskManagementPage.tsx: title",
];

function shouldScan(path: string): boolean {
  if (path.endsWith(".d.ts")) return false;
  if (/\.test\.[tj]sx?$/.test(path)) return false;
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

/** Index just past a string/template literal opened at `start`. */
function skipString(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === quote) return i;
  }
  return source.length;
}

/** The argument text of the call whose `(` sits at `openParen`. */
function callArgument(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return source.slice(openParen + 1, i);
  }
  return source.slice(openParen + 1);
}

/**
 * The `title` fields of the request literal itself — a key nested in an array
 * or a helper call (an external link's own title, say) is a different field.
 */
function titleExpressions(argument: string): string[] {
  const found: string[] = [];
  const open: string[] = [];
  let previous = "";
  for (let i = 0; i < argument.length; i++) {
    const ch = argument[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(argument, i);
      previous = ch;
      continue;
    }
    if (/\s/.test(ch)) continue;
    if (ch === "{" || ch === "[" || ch === "(") open.push(ch);
    else if (ch === "}" || ch === "]" || ch === ")") open.pop();
    else if (
      open.length === 1 &&
      open[0] === "{" &&
      (previous === "{" || previous === ",") &&
      /[A-Za-z_$]/.test(ch)
    ) {
      const rest = argument.slice(i);
      const key = /^[A-Za-z_$][\w$]*/.exec(rest)![0];
      i += key.length - 1;
      if (key === "title") {
        const value = /^title\s*:\s*([^,}\n]*)/.exec(rest)?.[1]?.trim();
        // Shorthand (`{ title }`) passes the local of that name.
        found.push(value || "title");
      }
      previous = key.slice(-1);
      continue;
    }
    previous = ch;
  }
  return found;
}

/** Every `<file>: <title expression>` a file's saves carry. */
function titleSites(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const sites: string[] = [];
  const call = /\bsaveTask\s*\(/g;
  for (let m = call.exec(source); m; m = call.exec(source)) {
    const argument = callArgument(source, m.index + m[0].length - 1);
    for (const expression of titleExpressions(argument))
      sites.push(`${relative(WEB_ROOT, file)}: ${expression}`);
  }
  return sites;
}

/** Sites with no sanctioned entry left to match, and entries left unmatched. */
function multisetDiff(
  sites: string[],
  sanctioned: readonly string[],
): { extra: string[]; missing: string[] } {
  const unmatched = [...sanctioned];
  const extra: string[] = [];
  for (const site of sites) {
    const at = unmatched.indexOf(site);
    if (at >= 0) unmatched.splice(at, 1);
    else extra.push(site);
  }
  return { extra, missing: unmatched };
}

describe("task save title source audit", () => {
  test("exactly the sanctioned saves carry a title", () => {
    const sites = collectFiles().flatMap(titleSites);
    const { extra, missing } = multisetDiff(sites, SANCTIONED);
    const report = [
      ...extra.map(
        (site) =>
          `carries a title it does not edit (omit it — an update without a title leaves the stored one alone): ${site}`,
      ),
      ...missing.map(
        (site) => `sanctioned save no longer exists (drop the entry): ${site}`,
      ),
    ].join("\n");
    expect([...sites].sort(), report).toEqual([...SANCTIONED].sort());
  });
});
