/**
 * Who may OWN background work ([Task-483](pa://task/483)).
 *
 * Only an interactive top-level session the user owns qualifies: background
 * work outlives the provider turn, so somebody has to be able to see it and
 * stop it, and that somebody is the user looking at their own conversation.
 * Every excluded context keeps ordinary FOREGROUND execution untouched — this
 * policy governs admission to background work and nothing else.
 *
 * The decision is split in two on purpose. {@link backgroundWorkOwnerDecision}
 * is pure over evidence, so the rule can be read and tested as a rule;
 * {@link readBackgroundWorkOwnerEvidence} is the only place that reads durable
 * state for it. Nothing here branches on a persona/agent type: whether a
 * session may own background work is a property of its scope, its ownership
 * edges and its harness's CAPABILITY, never of which prompt it runs — the
 * harness question goes through the shared
 * {@link harnessSupportsBackgroundWorkBackend} predicate.
 */
import type {
  BackgroundWorkBackend,
  Harness,
  SessionScope,
} from "@assistant/shared";
import { harnessSupportsBackgroundWorkBackend } from "@assistant/shared";
import { sessionStore } from "../db/sessionStore.ts";
import { subagentStore } from "../db/subagentStore.ts";
import { workflowOwnershipForExecutor } from "../db/workflowStore.ts";

/** The bounded set of reasons a session may not own the background work asked for. */
export type BackgroundWorkOwnerExclusion =
  | "unknown-session"
  | "non-user-scope"
  | "subagent-owned"
  | "workflow-owned"
  | "harness-backend-mismatch";

/** What the durable stores say about one candidate owner. */
export interface BackgroundWorkOwnerEvidence {
  /** A live (non-deleted) session row exists. */
  exists: boolean;
  /**
   * The PERSISTED scope, read explicitly. `session_index.scope` is
   * default-closed, so an unreadable or unknown value has already failed closed
   * to `internal` by the time it gets here.
   */
  scope: SessionScope;
  /** This session is the agent side of a subagent thread. */
  subagentOwned: boolean;
  /** This session is (or has been) a workflow step's executor. */
  workflowOwned: boolean;
  /**
   * The engine that runs this session, which decides WHICH background backend
   * it can supervise at all. Absent only when there is no session row, where
   * the `exists` branch answers first.
   */
  harness?: Harness;
}

export type BackgroundWorkOwnerEligibility =
  | { eligible: true }
  | {
      eligible: false;
      exclusion: BackgroundWorkOwnerExclusion;
      /** One bounded sentence, suitable for a denial an agent will read. */
      reason: string;
    };

/**
 * The rule itself, over evidence and the backend the caller asked for. The
 * session-standing questions come first, then the capability one: an
 * `internal` session is not the user's whichever backend it names.
 */
export function backgroundWorkOwnerDecision(
  evidence: BackgroundWorkOwnerEvidence,
  backend: BackgroundWorkBackend,
): BackgroundWorkOwnerEligibility {
  if (!evidence.exists)
    return {
      eligible: false,
      exclusion: "unknown-session",
      reason:
        "background work needs a live session that owns it, and this one has no session record",
    };
  // `internal` covers the server's own helper and one-shot runs: they have no
  // conversation the user could watch work in, so nothing may outlive them.
  if (evidence.scope !== "user")
    return {
      eligible: false,
      exclusion: "non-user-scope",
      reason: `a ${evidence.scope} session may not own background work; only the user's own sessions may`,
    };
  if (evidence.subagentOwned)
    return {
      eligible: false,
      exclusion: "subagent-owned",
      reason:
        "a subagent session may not own background work; it belongs to its parent's run, not to the user",
    };
  if (evidence.workflowOwned)
    return {
      eligible: false,
      exclusion: "workflow-owned",
      reason:
        "a workflow-owned session may not own background work; the workflow engine owns its lifecycle",
    };
  // The capability question, asked of the harness and never of a persona: a pi
  // session cannot hold a Claude query's task, and a Claude session does not
  // supervise a PA-owned process. Admitting the mismatch would create a row
  // nothing could ever bind, stop or close.
  if (
    evidence.harness === undefined ||
    !harnessSupportsBackgroundWorkBackend(evidence.harness, backend)
  )
    return {
      eligible: false,
      exclusion: "harness-backend-mismatch",
      reason: `a ${evidence.harness ?? "unknown"} session cannot own ${backend} background work`,
    };
  return { eligible: true };
}

/**
 * Gather the evidence. Reads are default-closed throughout: a missing row is
 * "unknown", and both ownership questions answer "owned" on ANY edge rather
 * than trying to decide whether a past assignment has finished — a session the
 * engine or a parent ever executed is not the user's interactive top-level
 * session, whatever state that assignment is in now.
 */
export function readBackgroundWorkOwnerEvidence(
  sessionId: string,
): BackgroundWorkOwnerEvidence {
  const session = sessionStore.get(sessionId);
  if (!session)
    return {
      exists: false,
      scope: "internal",
      subagentOwned: false,
      workflowOwned: false,
    };
  return {
    exists: true,
    scope: session.scope,
    harness: session.harness,
    // Normally implied by the scope — a subagent session is persisted as
    // `subagent` — but the thread edge is what the rule is ABOUT, so it is
    // asked directly rather than inferred from another store's invariant.
    subagentOwned: Boolean(subagentStore.getThreadBySessionId(sessionId)),
    workflowOwned: workflowOwnershipForExecutor(sessionId).length > 0,
  };
}

export function backgroundWorkOwnerEligibility(
  sessionId: string,
  backend: BackgroundWorkBackend,
): BackgroundWorkOwnerEligibility {
  return backgroundWorkOwnerDecision(
    readBackgroundWorkOwnerEvidence(sessionId),
    backend,
  );
}
