import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * `App.tsx` new-session draft audit (`docs/agent-definitions.md` "UI").
 *
 * A failed first send is held for retry with the context it consumed: its
 * Task, worktree and project. Two rules keep that held send from leaking into
 * what runs next, and both live in `App`, which no render test mounts with a
 * failed first send:
 *
 * - Every fresh-draft starter retires the held send first (`beginFreshDraft`),
 *   or re-issuing it from the new draft would carry the old draft's context.
 * - Every re-issue goes through `reissuedFirstSend`, which runs what the
 *   pickers show NOW (engine, persona, account, model, effort, agent). A path
 *   that spreads the held send instead re-runs a pick the user has since
 *   changed, an agent the draft dropped included.
 *
 * The helpers themselves are tested in `lib/stagedSession.test.ts`; this holds
 * `App` to calling them.
 */

const APP_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "App.tsx"),
  "utf8",
);

/** The body of `const <name> = useCallback(`, up to its dependency list. */
function callbackBody(name: string): string {
  const start = APP_SOURCE.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} is a useCallback in App.tsx`).toBeGreaterThan(-1);
  // The next top-level declaration in App ends this one.
  const end = APP_SOURCE.indexOf("\n  const ", start + 1);
  return APP_SOURCE.slice(start, end === -1 ? undefined : end);
}

describe("App new-session drafts", () => {
  const starters = [...APP_SOURCE.matchAll(/const (start\w+) = useCallback\(/g)]
    .map((match) => match[1]!)
    // Restages the draft it is on; it starts no new one.
    .filter((name) => name !== "startStagedSession");

  test("finds the starters", () => {
    expect(starters).toContain("startNewChat");
    expect(starters).toContain("startSessionInWorktree");
  });

  test.each(starters)("%s retires the held first send", (name) => {
    expect(callbackBody(name)).toContain("beginFreshDraft();");
  });

  test("both re-issue paths run what the pickers show now", () => {
    expect(
      APP_SOURCE.match(/reissuedFirstSend\(/g)?.length,
      "the composer re-issue and retryFirstSend",
    ).toBe(2);
    expect(callbackBody("retryFirstSend")).toContain("reissuedFirstSend(");
    expect(APP_SOURCE).not.toMatch(/\.\.\.stagedSend!?\.input/);
    expect(APP_SOURCE).not.toMatch(/\.\.\.send\.input\b/);
  });
});
