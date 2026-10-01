/**
 * Merge & clean up, from the Pull Requests view: the one action's state.
 *
 * It is a hook for the same reason `useWorktreeRetire` is one — the cleanup
 * half has a CONSENT LADDER, and consent state is dangerous state. Every field
 * here is bound to ONE pull request's identity (all four components of it), and
 * a mismatch is not this pull request's state: a refusal is consent-bearing, so
 * shown under another pull request it would arm a forced worktree removal on
 * the strength of a verification that ran somewhere else.
 *
 * The two phases are reported separately by the endpoint and treated separately
 * here, because they can end differently:
 *
 *  - a merge that LANDED is never re-offered and never reported as a failure. A
 *    cleanup that refused afterwards leaves the dialog open on the cleanup
 *    alone, with the merge stated above it and the escalation below it;
 *  - success is silent while the object survives. It only speaks when the pull
 *    request has left the inventory with its checkout — the sanctioned toast,
 *    NAMING what it happened to, because there is no surface left to say it on.
 *
 * Every sentence it shows comes from the SERVER's per-phase outcome. Nothing is
 * assumed about what the click was asked to do.
 */
import { useCallback, useState, type ReactNode } from "react";
import type {
  PullRequestInventoryItem,
  PullRequestViewCleanupOutcome,
  PullRequestViewMergeOutcome,
  PullRequestViewMergeResponse,
} from "@assistant/shared";
import {
  PullRequestMergeDialog,
  type PullRequestMergeChoice,
} from "./PullRequestMergeDialog.tsx";
import { pullRequestRowId } from "../../lib/pullRequestInbox.ts";
import {
  checkPullRequestFromView,
  mergePullRequestFromView,
  PullRequestApiError,
} from "../../lib/pullRequestsApi.ts";
import { showToast } from "../../lib/toast.ts";
import {
  retireOutcomeMessage,
  retireRefusalEscalatable,
} from "../../lib/worktreeRetire.ts";

export interface PullRequestMergeCleanup {
  /** Open the confirmation. The act itself never runs without it. */
  open: () => void;
  /** The action is in flight; the initiating control busies on it (R5). */
  busy: boolean;
  /**
   * The last attempt's outcome is unknown and nothing has proved otherwise yet,
   * so the row offers nothing either: the item on screen may predate it.
   */
  suspended: boolean;
  /** Render once, anywhere in the host. */
  dialog: ReactNode;
}

interface MergeState {
  /** The pull request this state is ABOUT, as `pullRequestRowId` writes it. */
  key: string;
  open: boolean;
  busy: boolean;
  /** A refusal or transport failure from the last attempt. */
  error?: string;
  /** Whether `force` is an answer to that refusal (never a session gate). */
  escalatable: boolean;
  /** The merge that already landed in this flow, in the server's words. */
  mergedNote?: string;
  /**
   * What the state CHECK found, when it found nothing had landed. Neutral
   * information rather than a failure: the attempt is accounted for, and the
   * ordinary decision is on offer again.
   */
  note?: string;
  /**
   * The last attempt never came back, so whether it landed is UNKNOWN. It is
   * not "nothing happened": the request may have merged and the response been
   * lost, and re-offering Merge over an item that predates it would ask the
   * user to merge something that is already in.
   *
   * Only the CHECK — `POST /api/pull-requests/check`, the state read under this
   * pull request's own mutation lock — may clear it. A refetched inventory may
   * not, however fresh it looks: the lost request may still hold that lock, so
   * the read can describe the repository from before it merged. Nor may a
   * re-issued MERGE be what answers: a pull request that has since become a
   * draft, or conflicted, or whose method the repository stopped allowing,
   * would refuse every attempt and leave this standing forever over a pull
   * request that is merely unmergeable right now.
   */
  unknown?: boolean;
}

const NOTHING: MergeState = {
  key: "",
  open: false,
  busy: false,
  escalatable: false,
};

export function usePullRequestMergeCleanup({
  item,
  onDone,
}: {
  item: PullRequestInventoryItem | null;
  /** Something changed on the server — refetch the projection that shows it. */
  onDone: () => void;
}): PullRequestMergeCleanup {
  const [state, setState] = useState<MergeState>(NOTHING);
  const key = item ? pullRequestRowId(item) : undefined;
  // The identity guard, in one place: state that is not about THIS pull
  // request is not this pull request's state, so navigating A → B shows B a
  // fresh dialog rather than A's consent-bearing refusal.
  const mine = key !== undefined && state.key === key ? state : NOTHING;

  const open = useCallback(() => {
    if (!key) return;
    setState((current) =>
      current.key === key
        ? { ...current, open: true }
        : { key, open: true, busy: false, escalatable: false },
    );
  }, [key]);

  const close = useCallback(() => {
    if (!key) return;
    // Closing keeps everything the attempt established: the refusal a reopened
    // dialog escalates from (and the failure it states, since the dialog is
    // the flow that issued the write and the one place it is retried), the
    // merge that landed and must not be offered again, and an unknown outcome
    // — which the row keeps stating as "Check again" until the recovery below
    // answers it.
    setState((current) =>
      current.key === key ? { ...current, open: false } : current,
    );
  }, [key]);

  /**
   * Ask what this pull request IS, under its own mutation lock — the only thing
   * that can answer an attempt whose response was lost.
   *
   * It attempts nothing, which is what makes the answer reachable: a re-issued
   * MERGE would be refused by every guard that has since turned against it (a
   * draft, a conflict, a method the repository stopped allowing) and the
   * surface would stay uncertain forever over a pull request that is merely
   * unmergeable right now. A refusal HERE is only ever "something still holds
   * the lock" or a read that failed, and both are honestly still unknown.
   */
  const check = useCallback(
    async (
      target: PullRequestInventoryItem,
      priorMerge: string | undefined,
    ) => {
      const id = pullRequestRowId(target);
      setState({
        key: id,
        open: true,
        busy: true,
        escalatable: false,
        // The uncertainty stands for the whole check: it ends on an ANSWER,
        // not on having asked.
        unknown: true,
        ...(priorMerge !== undefined ? { mergedNote: priorMerge } : {}),
      });
      try {
        const answer = await checkPullRequestFromView({
          projectId: target.projectId,
          provider: target.provider,
          repositoryKey: target.repositoryKey,
          number: target.number,
        });
        const terminal = answer.state !== "open";
        // The local half has THREE answers and the middle one is not absence:
        // two checkouts on this branch is a situation to state, never "nothing
        // is left here".
        const ambiguous =
          answer.checkout.status === "ambiguous"
            ? answer.checkout.reason
            : undefined;
        setState((current) => ({
          key: id,
          // The uncertainty is over. What is left is an ordinary decision
          // against the refreshed pull request — with the merge half suppressed
          // when the check found it terminal, which is exactly what a merge
          // that landed leaves behind.
          open: current.key === id ? current.open : false,
          busy: false,
          escalatable: false,
          ...(terminal
            ? {
                mergedNote: `Checked under the pull request's lock: #${answer.number} is ${answer.state}.`,
              }
            : priorMerge !== undefined
              ? { mergedNote: priorMerge }
              : {}),
          ...(ambiguous
            ? { note: ambiguous }
            : terminal
              ? {}
              : {
                  note: `Checked under the pull request's lock: #${answer.number} is still open, so the attempt did not merge it.`,
                }),
        }));
        // The sanctioned toast, on the same rule as everywhere here: only when
        // the pull request has left the view with its checkout is there no
        // object left to say it on. An AMBIGUOUS local answer is not that: the
        // checkouts are still there, and the note above says so.
        if (terminal && answer.checkout.status === "none")
          showToast(
            `#${answer.number} is ${answer.state}; no local checkout is left to clean up.`,
            { tone: "success" },
          );
      } catch (err) {
        setState({
          key: id,
          open: true,
          busy: false,
          error: `Whether #${target.number} was merged is still unknown: ${
            err instanceof Error ? err.message : String(err)
          } Check again in a moment.`,
          escalatable: false,
          unknown: true,
          ...(priorMerge !== undefined ? { mergedNote: priorMerge } : {}),
        });
      } finally {
        onDone();
      }
    },
    [onDone],
  );

  const run = useCallback(
    async (
      choice: PullRequestMergeChoice,
      target: PullRequestInventoryItem,
      /**
       * The merge this flow already landed, when the dialog is on its second
       * pass (a cleanup refusal, then the consented retry). It travels from the
       * render that offered the button, so nothing has to read state back out
       * of a stale closure.
       */
      priorMerge: string | undefined,
    ) => {
      const id = pullRequestRowId(target);
      setState({
        key: id,
        open: true,
        busy: true,
        escalatable: false,
        ...(priorMerge !== undefined ? { mergedNote: priorMerge } : {}),
      });
      let lost = false;
      try {
        const result = await mergePullRequestFromView({
          projectId: target.projectId,
          provider: target.provider,
          repositoryKey: target.repositoryKey,
          number: target.number,
          ...(choice.method ? { method: choice.method } : {}),
          deleteRemoteBranch: choice.deleteRemoteBranch,
          removeWorktree: choice.removeWorktree,
          ...(choice.forceRemoveWorktree ? { forceRemoveWorktree: true } : {}),
        });
        setState(settle(id, result, choice, target, priorMerge));
      } catch (err) {
        // Two different facts, and the difference is what the user is told.
        //
        // An ANSWERED refusal (`PullRequestApiError`) means the server handled
        // the request and performed nothing it could not report: the endpoint
        // reports a landed merge as landed even when its own follow-up work
        // fails, so this is a clean "nothing happened" and the control is the
        // retry. A response that never came back is not: the merge may have
        // landed with the answer lost, so the outcome is UNKNOWN and only the
        // CHECK below may end it.
        const answered = err instanceof PullRequestApiError;
        setState({
          key: id,
          open: true,
          busy: false,
          error: answered
            ? err.message
            : `The server did not answer, so whether #${target.number} was merged is unknown: ${
                err instanceof Error ? err.message : String(err)
              } Checking asks what it is now.`,
          escalatable: false,
          ...(answered ? {} : { unknown: true }),
          ...(priorMerge !== undefined ? { mergedNote: priorMerge } : {}),
        });
        lost = !answered;
      } finally {
        onDone();
      }
      // One automatic check per lost response — the common case is a blip after
      // the server was done. One that cannot be answered hands the "Check
      // again" control to the user rather than looping.
      if (lost) await check(target, priorMerge);
    },
    [check, onDone],
  );

  return {
    open,
    busy: mine.busy,
    suspended: mine.unknown === true,
    dialog:
      mine.open && item ? (
        <PullRequestMergeDialog
          item={item}
          {...(mine.mergedNote !== undefined
            ? { mergedNote: mine.mergedNote }
            : {})}
          busy={mine.busy}
          {...(mine.error !== undefined ? { error: mine.error } : {})}
          {...(mine.escalatable && mine.error ? { refusal: mine.error } : {})}
          {...(mine.unknown ? { outcomeUnknown: true } : {})}
          {...(mine.note !== undefined ? { note: mine.note } : {})}
          onConfirm={(choice) => void run(choice, item, mine.mergedNote)}
          // Asks what the pull request IS, never re-attempts the merge: that is
          // what can still be answered once a guard has turned against it.
          onRecheck={() => void check(item, mine.mergedNote)}
          onClose={close}
        />
      ) : null,
  };
}

/**
 * What the run's per-phase answer means for the surface. A cleanup that refused
 * or failed keeps the dialog — the object is still there and this is the
 * control that retries it; anything else is done, and only then may it speak.
 */
function settle(
  key: string,
  result: PullRequestViewMergeResponse,
  choice: PullRequestMergeChoice,
  item: PullRequestInventoryItem,
  priorMerge: string | undefined,
): MergeState {
  // A retry after a refusal finds the pull request already terminal and reports
  // no merge of its own; the one that DID land is still this flow's fact and
  // must keep being stated.
  const merged = mergeSentence(result.merge) ?? priorMerge;
  if (
    result.cleanup.status === "refused" ||
    result.cleanup.status === "failed"
  ) {
    return {
      key,
      open: true,
      busy: false,
      error:
        result.cleanup.status === "refused"
          ? result.cleanup.refusal
          : result.cleanup.error,
      escalatable:
        result.cleanup.status === "refused" &&
        retireRefusalEscalatable(result.cleanup.refusalKind),
      ...(merged !== undefined ? { mergedNote: merged } : {}),
    };
  }
  if (!surfaceIsGone(result.cleanup, item)) return NOTHING;
  // The sanctioned toast: this pull request leaves the inventory with its
  // checkout, so the outcome has no object left to sit on and the message NAMES
  // what it happened to. Every clause is the server's report of what it did.
  const clauses = [
    merged,
    result.cleanup.status === "retired"
      ? retireOutcomeMessage(result.cleanup, {
          forced: choice.forceRemoveWorktree,
        })
      : result.cleanup.status === "no-worktree" && choice.removeWorktree
        ? "No local checkout was left to clean up."
        : undefined,
    result.taskSuggestions.length > 0
      ? `Suggested done on ${result.taskSuggestions
          .map((task) => `Task-${task.id}`)
          .join(", ")}.`
      : undefined,
  ].filter((clause): clause is string => Boolean(clause));
  showToast(
    `#${result.number}: ${
      clauses.length > 0 ? clauses.join(" ") : "nothing was left to do."
    }`,
    { tone: "success" },
  );
  return NOTHING;
}

/**
 * Whether the pull request this ran on is leaving the view. It is listed while
 * it is open, or while a local checkout of it survives — so a merge that also
 * retired the checkout (or found none) takes the surface with it, while one
 * that kept the checkout leaves the object on screen, where the state change
 * speaks for itself and silence is right.
 */
function surfaceIsGone(
  cleanup: PullRequestViewCleanupOutcome,
  item: PullRequestInventoryItem,
): boolean {
  if (cleanup.status === "retired" || cleanup.status === "no-worktree")
    return true;
  return cleanup.status === "not-requested" && !item.worktreeId;
}

/** What happened to the pull request, or nothing when it was already terminal. */
function mergeSentence(merge: PullRequestViewMergeOutcome): string | undefined {
  if (merge.status !== "merged") return undefined;
  const branch =
    merge.remoteBranch === "deleted"
      ? `Deleted the remote branch ${merge.headBranch}.`
      : merge.remoteBranch === "kept"
        ? `The remote branch ${merge.headBranch} was kept.`
        : `The remote branch ${merge.headBranch} was NOT deleted${
            merge.remoteBranchError ? `: ${merge.remoteBranchError}` : "."
          }`;
  return `Merged into ${merge.baseBranch} (${merge.method}). ${branch}`;
}
