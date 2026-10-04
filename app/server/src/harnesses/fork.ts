/**
 * Forking a session on either engine (`docs/agent-harnesses.md` step 11d). The
 * client names OUR log entry; each engine branches at its own native id, so
 * each translates the pick into its own cut and refuses one it cannot make.
 * The caller keeps what is not the engine's: resolving the session, the
 * persona guard, the view and what the client is told.
 */
import type { AgentType, Harness } from "@assistant/shared";
import { claudeSdkStore } from "../claudeSdk/claudeSdkStore.ts";
import {
  linkSessionToWorktree,
  worktreeIdForSession,
} from "../db/worktreeStore.ts";
import type { LiveSession } from "../harness.ts";
import { piStore } from "../piSdk/piStore.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";
import { broadcastWorktreeEdgeChange } from "../worktrees/worktrees.ts";

/** The native anchors OUR log holds around the picked entry. */
type ForkAnchors = ReturnType<typeof sessionRuntime.forkAnchors>;

/** A fork the client asked for, at an entry its session still has. */
interface ForkRequest {
  id: string;
  kind: AgentType;
  file: string;
  /** OUR id for the row the user picked; the fork's lineage carries it. */
  entryId: string;
  position: "before" | "at";
  anchors: ForkAnchors;
}

/** A fork refused before anything was written, or one ready to run. */
type PreparedFork = { refusal: string } | { fork(): Promise<LiveSession> };

/**
 * Check that the engine can make the fork, then hand back the step that makes
 * it. A refusal comes before anything is written for the child.
 */
export function prepareFork(
  harness: Harness,
  request: ForkRequest,
): PreparedFork {
  const prepared = engines[harness](request);
  if ("refusal" in prepared) return prepared;
  return {
    fork: async () => {
      const live = await prepared.fork();
      // Forks inherit the parent's execution context durably: copy the
      // in_worktree edge so a later reopen resolves the same cwd.
      const parentWorktreeId = worktreeIdForSession(request.id);
      if (parentWorktreeId) {
        linkSessionToWorktree(live.sessionId, parentWorktreeId);
        broadcastWorktreeEdgeChange();
      }
      return live;
    },
  };
}

const NO_ANCHOR =
  "Failed to fork session: this message has no provider anchor to branch from.";

const engines: Record<Harness, (request: ForkRequest) => PreparedFork> = {
  /**
   * The SDK slices its transcript INCLUSIVELY, so the two positions differ only
   * in where the cut lands: "at" keeps the chosen assistant turn, while
   * "before" cuts at the turn PRECEDING the chosen prompt. Both the native cut
   * and OUR slice stop at the same entry.
   */
  "claude-sdk": ({ id, entryId, position, anchors }) => {
    const cut =
      position === "at"
        ? { anchor: anchors.own, entryId }
        : { anchor: anchors.previous, entryId: anchors.previousEntryId };
    if (!cut.anchor || !cut.entryId)
      return {
        refusal:
          position === "at"
            ? NO_ANCHOR
            : "Failed to fork session: there is nothing before this prompt to branch from.",
      };
    const { anchor, entryId: keepThroughEntryId } = cut;
    return {
      fork: () =>
        claudeSdkStore.forkSession(id, {
          anchor,
          keepThroughEntryId,
          forkOrigin: {
            harness: "claude-sdk",
            parentSessionId: id,
            parentEntryId: entryId,
            position,
            createdAt: Date.now(),
          },
        }),
    };
  },

  pi: ({ id, kind, file, entryId, position, anchors }) => {
    // pi branches FROM the selected native entry (it walks to the parent itself
    // for a "before" fork), so it always wants that entry's OWN anchor. Our log
    // id in its place would reach the store as an id it cannot resolve.
    if (!anchors.own) return { refusal: NO_ANCHOR };
    const cut = piForkCut(id, entryId, position, anchors);
    // An "at" fork whose turn end cannot be named on BOTH sides is refused
    // rather than cut: our copy always runs to the end of the turn, so
    // branching pi anywhere earlier hands the child tool calls whose results
    // nothing holds.
    if (!cut.anchor)
      return {
        refusal:
          "Failed to fork session: this turn has no provider anchor for its end to branch from.",
      };
    // OUR cut is validated BEFORE pi branches: its branch writes a session file
    // that nothing would reference if the copy then proved impossible, and
    // unlike the Claude path there is nothing to undo.
    if (cut.logCut && !sessionRuntime.canForkLogAt(id, cut.logCut))
      return {
        refusal: "Cannot fork: selected message is no longer available.",
      };
    const { anchor, logCut } = cut;
    return {
      fork: async () => {
        // `entryId` travels alongside the native anchor: the fork's recorded
        // lineage must carry OUR id, since the client resolves `parentEntryId`
        // against its own transcript and pi's ids name nothing there.
        const live = await piStore.forkSession(
          kind,
          file,
          anchor,
          position,
          entryId,
        );
        // Seed the child's durable transcript. pi branches its OWN session
        // file and leaves our log untouched, so without this the fork opens on
        // an empty chat beside a pi session carrying the whole history. (The
        // Claude store does it inside its fork, where the session record is
        // derived from the same copy.)
        if (logCut) sessionRuntime.forkLog(id, live.sessionId, logCut);
        return live;
      },
    };
  },
};

/**
 * The two halves of a pi fork, which must name the SAME point: the native id
 * pi branches at, and OUR log entry the copy runs through.
 *
 * "before" is the simpler half: pi walks to the selected prompt's PARENT, so
 * we copy through the entry immediately preceding that prompt in our log —
 * anchored or not, because a copy needs no anchor. Cutting at the nearest
 * ANCHORED entry instead would drop a turn that was left unbound (the
 * reconciliation refuses a turn it cannot place with certainty) from the
 * child's transcript while pi's branch still carries it in context. For the
 * first prompt there is nothing before it, so the copy is empty — which is
 * what pi answers with a fresh session too.
 *
 * "at" takes the work, because ONE of our assistant entries is the whole pi
 * turn: natively that turn is `assistant(call) → result → … → final
 * assistant`, while our log holds the aggregated entry followed by its tool
 * results. So the two cuts run to each transcript's own end of that turn — our
 * copy through the last owned tool result (`forkCutEntryId`), pi through the
 * turn's terminal native id (`ownTurnEnd`, which the post-turn scan resolved).
 * Cutting pi at the entry's own native message instead would hand the child
 * tool calls whose results nothing holds and drop the turn's final answer,
 * while our copy showed both.
 *
 * An entry anchored BEFORE turn ends were resolved has no `ownTurnEnd`, and
 * its `own` is whatever that older binding recorded — the message that OPENED
 * the turn, not its end. Those keep the rule they were written under: cut pi
 * at the anchor of OUR turn-end entry, the last row both transcripts agree on.
 * When that entry carries no anchor either — the common shape of a legacy
 * multi-cycle turn, whose positional binding stopped before its tool results —
 * there is NO id that names the end of the turn, so the fork is refused
 * (`anchor` undefined) rather than cut at the opening message: our copy would
 * carry results and a final answer the child's provider context never got.
 * Nothing here repairs such a binding.
 */
function piForkCut(
  id: string,
  entryId: string,
  position: "before" | "at",
  anchors: ForkAnchors,
): { anchor?: string; logCut?: string } {
  if (position === "before")
    return {
      anchor: anchors.own!,
      ...(anchors.precedingEntryId ? { logCut: anchors.precedingEntryId } : {}),
    };
  const logCut = sessionRuntime.forkCutEntryId(id, entryId) ?? entryId;
  if (anchors.ownTurnEnd) return { anchor: anchors.ownTurnEnd, logCut };
  // Legacy binding: only OUR turn-end entry's own anchor can name the end.
  const legacyTurnEndAnchor = sessionRuntime.forkAnchors(id, logCut).own;
  return legacyTurnEndAnchor
    ? { anchor: legacyTurnEndAnchor, logCut }
    : { logCut };
}
