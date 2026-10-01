/**
 * UI capability helpers derived from a session's clean identity pair
 * `{harness, agentType}` — NOT from the legacy `kind`. These are the Stage2-B
 * replacements for the per-kind booleans that App.tsx used to compute inline
 * (`displayIsWorkspaceKind`, `modelLocked`, …).
 *
 * `harness`/`agentType` are server-populated on every `SessionState` and
 * `SessionListItem`; the optimistic synthetic session staged on the client sets
 * them too, so these read the same off either shape.
 */
import type { Harness, SessionAgentType } from "@assistant/shared";

/** The subset of a session needed to derive its UI capabilities. */
interface SessionCaps {
  harness?: Harness;
  agentType?: SessionAgentType;
}

/**
 * Workspace-aware sessions edit files, so they share the git-status / changed
 * file / review-changes treatment. These are the code-editing personas
 * (Workshop and Developer) — independent of harness: a Claude-SDK *assistant*
 * has no file/shell tools and is NOT workspace aware, while a Claude-SDK
 * coding persona (workshop or developer) is (same as the pi coding agents).
 */
export function isWorkspaceAware(s: SessionCaps): boolean {
  return s.agentType === "workshop" || s.agentType === "developer";
}

/**
 * Whether the session has the Build/Plan mode axis. Every interactive persona
 * gets it on both harnesses: coding sessions lose file writers and every
 * persona loses side-effecting app tools. The server-owned workflow coordinator
 * is not an interactive planning surface.
 */
export function hasModeAxis(s: SessionCaps): boolean {
  return Boolean(s.agentType && s.agentType !== "workflow-coordinator");
}

/**
 * Non-pi harnesses reject post-turn model/thinking changes server-side (Claude
 * SDK), so once started their pickers are read-only. pi sessions can switch
 * freely.
 */
export function locksModelAfterStart(s: SessionCaps): boolean {
  return s.harness !== "pi";
}

/**
 * Whether a harness is created optimistically on the client (staged, then
 * created on first prompt via `harnessSend`) rather than via the pi
 * `newSession` bootstrap. Every non-pi harness is optimistic.
 */
export function isOptimisticHarness(harness: Harness): boolean {
  return harness !== "pi";
}
