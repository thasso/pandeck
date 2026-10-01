import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Panel user-control audit.
 *
 * `app/web/docs/ui-shell.md`: both side panels are the user's, not the route's.
 * The object panel is "pure user state at every size — navigation never opens or
 * closes [it], and it is never disabled: for a surface with nothing to inspect
 * it is at most empty". The left sidebar is route-driven only in its small-screen
 * form, where it is a SCREEN rather than a panel.
 *
 * Closing one anyway is invisible to every render test — the app still works,
 * the panel is simply gone — and reads to the user as a bug in the shell. It got
 * in four times over, each a local decision that made sense on a phone (the dock
 * sheet covers the whole screen there, so landing on a new surface behind it
 * would show the user nothing) and was never a decision about a wide layout at
 * all.
 *
 * So the audit is on the GUARD, not on the call: a close may exist, but only
 * behind a small-screen condition or as the user's own dismiss. That keeps the
 * phone behaviour and makes the desktop rule mechanical. There is no allowlist —
 * a close that genuinely has to happen on a wide layout is a change to the shell
 * concept first, and this test second.
 */

const APP_FILE = join(dirname(fileURLToPath(import.meta.url)), "App.tsx");

/** Closing either panel. Opening is not audited: it never loses user state. */
const CLOSE_CALL = /set(?:Inspector|Sidebar)Open\(false\)/;

/**
 * The conditions under which a close is legitimate: a small-screen layout, the
 * small-screen browser screen, or an explicit dismiss handler (the backdrop,
 * Escape, the dock's grabber — all of them the user asking).
 */
const GUARDED = /mobileLayout|browserScreen|onDismiss/;

function auditedLines(): { line: number; text: string }[] {
  return readFileSync(APP_FILE, "utf8")
    .split("\n")
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => CLOSE_CALL.test(text));
}

describe("panel user-control audit", () => {
  test("App.tsx closes a panel only on small screens or by user dismissal", () => {
    const unguarded = auditedLines()
      .filter(({ text }) => !GUARDED.test(text))
      .map(({ line, text }) => `App.tsx:${line}: ${text.trim()}`);
    expect(unguarded).toEqual([]);
  });

  test("the audit is looking at something", () => {
    // A rename that made the pattern match nothing would leave the test green
    // and the rule unenforced.
    expect(auditedLines().length).toBeGreaterThan(0);
  });
});
