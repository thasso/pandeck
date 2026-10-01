import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * `App.tsx` hook-order audit.
 *
 * `App` renders a loading shell and returns early while the socket is still
 * connecting or the routed session has not arrived. Every hook it calls has to
 * sit ABOVE that early return: a hook below it is skipped on the hydrating
 * render and then runs on the connected render that follows, so React sees more
 * hooks than last time, throws #310, and the whole app is a blank page.
 *
 * That failure is invisible to the rest of the suite and to a warm browser tab.
 * The scenario tests mount `App` against an already-connected fake socket, so
 * they never render the shell first; a tab that loaded the previous bundle keeps
 * running it. Only a cold load of a fresh bundle hits it — which means the first
 * report comes from production. It shipped exactly once, in 0.9.1, when the
 * Project page's caches and callbacks were added at their point of use, below
 * the return.
 *
 * So this is a source audit, not a render test, and it has NO ALLOWLIST: a hook
 * below the early return is a bug in the change that introduced it. Hoist the
 * hook to the other hooks and read the value it needs from there — the block
 * above the early return is where `App` derives everything, including state that
 * only one page consumes.
 *
 * The binding rule is in `app/web/src/CLAUDE.md`.
 */

const APP_FILE = join(dirname(fileURLToPath(import.meta.url)), "App.tsx");

/** The early return that splits the component. */
const EARLY_RETURN = "  if (showLoadingShell) {";

/**
 * A hook CALL: `use` + capital, then `(` or a generic argument list. The `(`
 * requirement is what keeps plain values like `usePreview` out of the scan.
 */
const HOOK_CALL = /(?:^|[^\w.])(use[A-Z]\w*)\s*[(<]/;

/** Comments and strings are not code; a hook named in prose is not a call. */
function stripNonCode(line: string): string {
  return line.replace(/\/\/.*$/, "").replace(/\*.*$/, "");
}

describe("App hook order", () => {
  const source = readFileSync(APP_FILE, "utf8");
  const lines = source.split("\n");

  test("the loading-shell early return is still the one that splits App", () => {
    const matches = lines.filter((line) => line === EARLY_RETURN);
    expect(matches).toHaveLength(1);
  });

  test("no hook is called below the loading-shell early return", () => {
    const start = lines.indexOf(EARLY_RETURN);
    expect(start).toBeGreaterThan(0);

    const offenders = lines
      .slice(start + 1)
      .map((line, index) => ({ line, number: start + 2 + index }))
      .filter(({ line }) => HOOK_CALL.test(stripNonCode(line)))
      .map(({ line, number }) => `App.tsx:${number}: ${line.trim()}`);

    expect(offenders).toEqual([]);
  });
});
