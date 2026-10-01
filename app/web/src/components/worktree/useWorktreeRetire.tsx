/**
 * Retiring a worktree: the END of a branch's life, and its consent ladder.
 *
 * Retire is not Remove with a flag. It refreshes the merge target, VERIFIES the
 * branch is contained in it, settles the sessions working there, and only then
 * deletes the checkout and the branch. Remove never fetches, so it can never
 * perform that check — which is why both exist and why neither replaces the
 * other.
 *
 * The ladder is the reason this is a hook rather than a button. A refusal is
 * the server's answer to a verification it actually ran, and ONLY a refusal
 * `force` can answer is escalated: a `refusalKind: "sessions"` one is dropped
 * rather than remembered, because force does not override a running or waiting
 * session, and leaving it on screen would offer a consent that buys nothing.
 *
 * EVERY piece of that state is bound to a worktree ID, and that is the rule
 * this module exists to hold. A refusal is consent-bearing: shown under another
 * branch it would enable a FORCED retirement there, on the strength of a check
 * that ran somewhere else. So the state is keyed, exactly as the surface this
 * moved from keyed it — an unkeyed `useState` in a panel that survives
 * navigation is how that leak happens, and it is silent.
 *
 * It used to live in the Worktrees inbox, which is gone. The capability did not
 * go with it: it moved here, to the worktree's own inspector, with the same
 * dialog, the same escalation rule and the same words.
 */
import { useCallback, useState, type ReactNode } from "react";
import type {
  SessionListItem,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import { RemoveWorktreeDialog } from "./WorktreeDialogs.tsx";
import { retireWorktree } from "../../lib/worktrees.ts";
import {
  retireOutcomeMessage,
  retireRefusalEscalatable,
} from "../../lib/worktreeRetire.ts";
import { showToast } from "../../lib/toast.ts";

export interface WorktreeRetire {
  /** Open the confirmation. The act itself never runs without it. */
  open: () => void;
  /** A retirement is in flight; the initiating action busies on it (R5). */
  busy: boolean;
  /** Render once, anywhere in the host. */
  dialog: ReactNode;
}

/** Everything one worktree's retirement remembers, and nothing another's may see. */
interface RetireState {
  /** The worktree this state is ABOUT. A mismatch is not this worktree's state. */
  id: string;
  open: boolean;
  busy: boolean;
  /** The last refusal `force` could answer, or a transport failure to retry. */
  error?: string;
  /** Whether that error may be escalated from (a delivery/containment refusal). */
  escalatable: boolean;
}

const NO_RETIRE: RetireState = {
  id: "",
  open: false,
  busy: false,
  escalatable: false,
};

/**
 * How many sessions Retire will settle — or `undefined` when this browser
 * cannot say.
 *
 * Only LIVE ones count: an archived or settled session is already done with
 * the checkout and Retire will not move it. The ACT is never gated on this —
 * the server recounts under the removal hold and that recount is what protects
 * a running or waiting session — but the NUMBER is consent text, and a count
 * taken from a list that is not authoritative for this socket episode can
 * promise "settles 0 sessions" while the run settles four. So a stale list
 * yields no number and the dialog says it generically instead.
 */
function liveSessionCount(
  worktree: WorktreeRecord,
  sessions: SessionListItem[],
  sessionsFresh: boolean,
): number | undefined {
  if (!sessionsFresh) return undefined;
  return sessions.filter(
    (session) =>
      session.worktreeId === worktree.id &&
      (session.isStreaming || !(session.archived || session.settledAt)),
  ).length;
}

export function useWorktreeRetire({
  worktree,
  status,
  sessions,
  sessionsFresh,
  merged,
  onRetired,
}: {
  worktree: WorktreeRecord | undefined;
  status?: WorktreeGitStatus | undefined;
  sessions: SessionListItem[];
  /** The session list answered in the CURRENT socket episode (`sessionListFresh`). */
  sessionsFresh: boolean;
  /** The pull request for this branch was merged upstream, when that is known. */
  merged: boolean;
  /** Something changed on the server — refetch what shows it. */
  onRetired?: (() => void) | undefined;
}): WorktreeRetire {
  const [state, setState] = useState<RetireState>(NO_RETIRE);
  const id = worktree?.id;
  // The whole identity guard, in one place: state that is not about THIS
  // worktree is not this worktree's state, so navigating A → B shows B a fresh
  // dialog rather than A's consent-bearing refusal.
  const mine = id !== undefined && state.id === id ? state : NO_RETIRE;

  const open = useCallback(() => {
    if (!id) return;
    setState((current) =>
      current.id === id
        ? { ...current, open: true }
        : { id, open: true, busy: false, escalatable: false },
    );
  }, [id]);

  const close = useCallback(() => {
    if (!id) return;
    // Closing keeps the ladder — the refusal is what a reopened dialog
    // escalates from — but retires the transport error it was shown with.
    setState((current) =>
      current.id === id ? { ...current, open: false } : current,
    );
  }, [id]);

  const runRetire = useCallback(
    async (options: { deleteBranch: boolean; force: boolean }) => {
      if (!id) return;
      setState({ id, open: true, busy: true, escalatable: false });
      try {
        const result = await retireWorktree(id, options);
        if (result.status === "refused") {
          // The refusal stays INLINE on the dialog that asked for it: the
          // object is on screen and this control is the retry
          // (`docs/messaging.md`). Only an answerable one enables force — an
          // unanswerable one must not leave a consent that cannot apply.
          setState({
            id,
            open: true,
            busy: false,
            error: result.refusal,
            escalatable: retireRefusalEscalatable(result.refusalKind),
          });
          return;
        }
        setState(NO_RETIRE);
        // The ONE toast here, and the sanctioned reason for it: this worktree's
        // own surfaces are going away with the checkout, so the outcome has no
        // object left to sit on and the message NAMES what it happened to. The
        // sentence itself is the shared seam's, because the Pull Requests
        // view's cleanup reports the same run and must not word it differently
        // (`lib/worktreeRetire.ts`).
        showToast(retireOutcomeMessage(result, { forced: options.force }), {
          tone: "success",
        });
      } catch (err) {
        // A transport failure is not a refusal: nothing was verified, so it
        // enables no consent. It is shown where the retry is.
        setState({
          id,
          open: true,
          busy: false,
          error: err instanceof Error ? err.message : String(err),
          escalatable: false,
        });
      } finally {
        onRetired?.();
      }
    },
    [id, onRetired],
  );

  return {
    open,
    busy: mine.busy,
    dialog:
      mine.open && worktree ? (
        <RemoveWorktreeDialog
          worktree={worktree}
          {...(status !== undefined ? { status } : {})}
          retire={{
            sessionCount: liveSessionCount(worktree, sessions, sessionsFresh),
            merged,
            // Only an escalatable refusal reaches the consent block; a
            // transport failure is rendered as an error and buys no force.
            ...(mine.escalatable && mine.error ? { refusal: mine.error } : {}),
          }}
          busy={mine.busy}
          {...(mine.error !== undefined ? { error: mine.error } : {})}
          onRemove={(options) => void runRetire(options)}
          onClose={close}
        />
      ) : null,
  };
}
