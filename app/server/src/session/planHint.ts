/**
 * Plan mode's per-turn, model-only hint ([Task-330](pa://task/330)).
 *
 * The tool policy is what Plan mode ENFORCES (the harness refuses its
 * file-mutating native tools), but it cannot reach the shell — v1 keeps `Bash`,
 * so `>`, `sed -i` or `git checkout` would still mutate the worktree. That part
 * of Plan is a convention, and a convention has to be told to the model.
 *
 * Plan is STATE, not an event: the hint rides EVERY Plan turn rather than being
 * announced once at the switch, because a single announcement scrolls out of
 * attention and a resumed transcript replays it out of context. It travels on
 * the model-only seam (`RuntimePromptOptions.contextBlock`), so it never lands
 * in the durable app log or the client projection.
 *
 * Leaving Plan needs no symmetric announcement — the reminder simply stops and
 * the tool block changes by itself. The ONE exception: both harnesses resume a
 * provider transcript that still carries the earlier in-band Plan lines, so the
 * first Build turn after a Plan turn clears them with one short line.
 */
import type { Harness, SessionMode } from "@assistant/shared";

/**
 * Sessions whose last ACCEPTED turn ran in Plan, i.e. the sessions that still
 * owe a clearing line. In-memory on purpose: it is derived from turns, not a
 * session property, and the mode itself is the persisted one. A server restart
 * therefore drops a pending clearing line — the narrow cost is a Build turn
 * whose transcript still shows Plan lines the tool policy already contradicts.
 */
const sessionsLastPromptedInPlan = new Set<string>();

/**
 * The Plan reminder sent on every Plan turn, by the engine that runs it: Claude
 * gets the short form.
 */
const PLAN_MODE_HINTS: Record<Harness, string> = {
  "claude-sdk": [
    "<session-mode>",
    "Plan mode: investigate and propose, change nothing on disk. The file-writing",
    "tools are refused and the shell is not a way around them — no `>`/`>>` redirects,",
    "no `sed -i`, `tee`, `patch`, `git checkout`/`git apply`, no command that writes",
    "build or test artifacts. Reading, searching, `git log`, `rg` and the app tools",
    "are all fine. You may create and organize durable Tasks with `task_manage`; do not",
    "change repository or product files. Deliver the plan as your reply.",
    "</session-mode>",
  ].join("\n"),
  pi: [
    "<session-mode>",
    "Plan mode: investigate and propose, change nothing on disk.",
    "",
    "- Do not create, edit, delete or move a file, and do not call a tool that writes one.",
    "- The shell stays available and is NOT an exception: no `>`/`>>` redirects, no",
    "  `sed -i`, `tee`, `patch`, `git checkout`/`git apply`, and no command that writes",
    "  build or test artifacts.",
    "- Reading and searching stay fine: `cat`, `rg`, `git log`/`git diff`/`git show`,",
    "  and every app (`mcp__pa__*`) tool.",
    "- You may create and organize durable Tasks with `task_manage`, including plans in",
    "  Task descriptions. This does not permit repository or product changes.",
    "- Deliver the plan as your reply; the user switches the session back to Build when",
    "  it is time to implement it.",
    "</session-mode>",
  ].join("\n"),
};

/** The Plan reminder sent on every Plan turn. */
export function planModeHint(harness: Harness): string {
  return PLAN_MODE_HINTS[harness];
}

/** The single line that retires the Plan lines still sitting in the transcript. */
export function planModeClearedHint(): string {
  return "<session-mode>Build mode: the Plan-mode restrictions earlier in this conversation no longer apply — changing files is expected again.</session-mode>";
}

/**
 * The block this turn owes, or undefined for the ordinary Build turn. Pure:
 * `lastTurnWasPlan` is the caller's state, so the decision is testable without
 * a session.
 */
export function planTurnBlock(
  harness: Harness,
  mode: SessionMode | undefined,
  lastTurnWasPlan: boolean,
): string | undefined {
  if (mode === "plan") return planModeHint(harness);
  return lastTurnWasPlan ? planModeClearedHint() : undefined;
}

/** A block to prepend plus the bookkeeping that only an accepted turn does. */
export interface PlanTurnHint {
  readonly block: string;
  /**
   * Record that this turn actually ran. Called from the runtime's
   * `onUserEntry`, which fires only once the durable user entry exists — so a
   * duplicate `clientRequestId` (returned before any append) neither consumes
   * the clearing line nor claims a Plan turn happened.
   */
  commit(): void;
}

/**
 * The Plan hint for one turn of `driver`'s session, or undefined when the turn
 * needs none. A harness without the mode axis reports no `sessionMode` and so
 * behaves exactly as Build — including never emitting a clearing line.
 */
export function planTurnHintFor(driver: {
  readonly sessionId: string;
  readonly harness: Harness;
  readonly sessionMode?: SessionMode;
}): PlanTurnHint | undefined {
  const { sessionId, harness, sessionMode } = driver;
  const lastTurnWasPlan = sessionsLastPromptedInPlan.has(sessionId);
  const block = planTurnBlock(harness, sessionMode, lastTurnWasPlan);
  if (!block) return undefined;
  return {
    block,
    commit: () => {
      if (sessionMode === "plan") sessionsLastPromptedInPlan.add(sessionId);
      else sessionsLastPromptedInPlan.delete(sessionId);
    },
  };
}

/** Drop a session's pending clearing line (tests; session deletion). */
export function forgetPlanHintState(sessionId: string): void {
  sessionsLastPromptedInPlan.delete(sessionId);
}
