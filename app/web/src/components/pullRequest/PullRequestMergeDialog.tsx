/**
 * @component PullRequestMergeDialog
 * @purpose The ONE confirmation behind the Pull Requests view's "Merge & clean
 * up": every consequence of the click listed, with an opt-out where an opt-out
 * is meaningful.
 * @useWhen The object panel's "Merge & clean up…" row asks for the
 * merge-and-cleanup decision.
 * @avoidWhen Merging from the worktree page or a `/pr` card — those are
 * `MergePullRequestDialog` and the card's own controls, which act on a worktree
 * and a card respectively.
 * @intent Consequences are stated BEFORE the click and in the terms of what
 * this click will do, not what was asked for: each control's sentence follows
 * its own checkbox, the picker offers only what the repository REPORTS (unknown
 * offers nothing at all), and a known conflict disables merging with the reason
 * written out as text — a tooltip on a disabled control reaches neither a
 * keyboard nor a phone. Nothing here claims a consequence the browser cannot
 * know: the sessions and the linked Task are described as what the server does,
 * and what it actually did comes back in the outcome.
 * @related usePullRequestMergeCleanup, RemoveWorktreeDialog, pullRequestInbox
 */
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  PULL_REQUEST_MERGE_METHODS,
  type PullRequestInventoryItem,
  type PullRequestMergeMethod,
} from "@assistant/shared";
import { ConfirmDialog } from "../common/dialogs.tsx";

const MERGE_METHOD_LABELS: Record<PullRequestMergeMethod, string> = {
  squash: "Squash — one commit on the base branch",
  merge: "Merge commit — keep individual commits",
  rebase: "Rebase — replay the commits onto the base",
};

export interface PullRequestMergeChoice {
  method?: PullRequestMergeMethod;
  deleteRemoteBranch: boolean;
  removeWorktree: boolean;
  forceRemoveWorktree: boolean;
}

export function PullRequestMergeDialog({
  item,
  mergedNote,
  busy,
  error,
  refusal,
  outcomeUnknown = false,
  note,
  onConfirm,
  onRecheck,
  onClose,
}: {
  item: PullRequestInventoryItem;
  /**
   * The merge of THIS pull request already landed in this flow, so only the
   * cleanup is left to decide. It is stated above the remaining controls: a
   * dialog that offered Merge again would ask for something that cannot happen
   * twice, and hide the one thing that did.
   */
  mergedNote?: string | undefined;
  busy: boolean;
  /** The last attempt's refusal or transport failure, shown without closing. */
  error?: string | undefined;
  /**
   * The cleanup refusal `force` can answer, in the server's own words. Only a
   * refusal about UNVERIFIED DELIVERY (or a git guard) reaches this — a session
   * gate is never escalatable, so it never appears here
   * (`lib/worktreeRetire.ts`).
   */
  refusal?: string | undefined;
  /**
   * The last attempt's RESPONSE was lost, so whether it merged is unknown. The
   * item on screen may be the pre-merge one, so nothing is offered from it and
   * the only control is {@link onRecheck} — asking the server again is the one
   * thing that can answer, because that request is serialized with the attempt.
   */
  outcomeUnknown?: boolean;
  /**
   * What a state check found, when what it found was that nothing had landed.
   * Neutral information, not a failure: the ordinary decision is on offer
   * again under it.
   */
  note?: string | undefined;
  onConfirm: (choice: PullRequestMergeChoice) => void;
  /**
   * Ask what this pull request IS, under its lock. It never re-attempts the
   * merge: that is what keeps the answer reachable once a guard (a draft, a
   * conflict, a method the repository dropped) has turned against merging.
   */
  onRecheck?: () => void;
  onClose: () => void;
}) {
  const merging = item.state === "open" && !mergedNote && !outcomeUnknown;
  // The picker offers what the repository REPORTS and nothing else; unknown
  // capabilities offer nothing rather than a method the server would refuse.
  const supported = item.capabilities?.mergeMethods;
  const offered = PULL_REQUEST_MERGE_METHODS.filter((id) =>
    supported?.includes(id),
  );
  // `false` is the only known conflict. `null` is the provider still checking
  // and `undefined` is not read at all — neither is a conflict, and merging
  // stays on offer for both.
  const conflicts = item.mergeable === false;
  const canDeleteRemoteBranch =
    item.capabilities?.canDeleteBranchOnMerge === true;
  const hasCheckout = Boolean(item.worktreeId);

  const [method, setMethod] = useState<PullRequestMergeMethod | undefined>(
    undefined,
  );
  // A capability change while the dialog is open invalidates a stale choice
  // rather than sending it.
  const selected =
    method && offered.includes(method)
      ? method
      : item.capabilities?.defaultMergeMethod &&
          offered.includes(item.capabilities.defaultMergeMethod)
        ? item.capabilities.defaultMergeMethod
        : offered[0];
  const [deleteRemoteBranch, setDeleteRemoteBranch] = useState(true);
  const [removeWorktree, setRemoveWorktree] = useState(true);
  const [confirmForce, setConfirmForce] = useState(false);

  const branchGoes = canDeleteRemoteBranch && deleteRemoteBranch && !conflicts;
  // An unknown outcome suppresses the LOCAL half too: the cleanup it would run
  // belongs to a decision made against a pull request whose state is exactly
  // what is in doubt.
  const cleaningUp = hasCheckout && removeWorktree && !outcomeUnknown;
  const needsForce = Boolean(refusal) && cleaningUp;
  const mergeBlocked = merging && (conflicts || offered.length === 0);
  const confirmLabel = outcomeUnknown
    ? "Check again"
    : !merging
      ? "Clean up"
      : cleaningUp
        ? "Merge & clean up"
        : "Merge";

  return (
    <ConfirmDialog
      title={`#${item.number} ${item.title}`}
      confirmLabel={confirmLabel}
      bodyTone="plain"
      busy={busy}
      {...(error !== undefined ? { error } : {})}
      confirmDisabled={
        outcomeUnknown
          ? false
          : mergeBlocked ||
            (!merging && !cleaningUp) ||
            (needsForce && !confirmForce)
      }
      onConfirm={() => {
        // While the outcome is unknown the ONE thing this dialog can do is ask
        // what became of the attempt. It is the same request, serialized with
        // it, so it cannot answer before that attempt is over.
        if (outcomeUnknown) {
          onRecheck?.();
          return;
        }
        onConfirm({
          ...(merging && selected ? { method: selected } : {}),
          deleteRemoteBranch: branchGoes,
          removeWorktree: cleaningUp,
          forceRemoveWorktree: needsForce,
        });
      }}
      onCancel={onClose}
      cancelLabel={outcomeUnknown ? "Close" : "Cancel"}
      body={
        outcomeUnknown ? (
          <>
            The response to the last attempt was lost, so whether #{item.number}{" "}
            merged is unknown. Nothing is offered from the state on screen — it
            may predate the attempt, and a refreshed list cannot tell you
            either, because that attempt may still be running. Checking asks the
            server about this pull request again, behind the same lock, so its
            answer is about what actually happened.
          </>
        ) : mergedNote ? (
          <>{mergedNote} What is left is the local checkout below.</>
        ) : (
          <>
            <span className="font-mono">{item.headBranch}</span> →{" "}
            <span className="font-mono">{item.baseBranch}</span>
            {item.state === "open"
              ? "."
              : ` — already ${item.state}, so there is nothing left to merge.`}
          </>
        )
      }
    >
      {/* What a check ACCOUNTED for, above the decision it hands back. */}
      {note ? (
        <p className="mt-2 text-sm text-muted-foreground">{note}</p>
      ) : null}

      {/* --------------------------- the merge ---------------------------- */}
      {merging ? (
        <div className="mt-3">
          {conflicts ? (
            // As TEXT under the row, in place of the controls' own sentences: a
            // tooltip on a disabled button reaches neither keyboard nor phone.
            <p className="text-sm text-amber-500">
              #{item.number} conflicts with {item.baseBranch}, so no merge is
              offered and nothing here can run. Update the branch first.
            </p>
          ) : offered.length === 0 ? (
            <p className="text-sm text-amber-500">
              {supported
                ? "This repository allows no merge method for pull requests, so nothing can be merged here."
                : `The merge methods this repository allows could not be read${
                    item.capabilities?.unknownReason
                      ? ` (${item.capabilities.unknownReason})`
                      : ""
                  }, so no merge is offered.`}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {offered.map((id) => (
                <label
                  key={id}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-sm ${selected === id ? "border-primary bg-accent text-fg" : "border-line text-muted-foreground hover:bg-raised"}`}
                >
                  <input
                    type="radio"
                    name="pull-request-merge-method"
                    checked={selected === id}
                    disabled={busy}
                    onChange={() => setMethod(id)}
                  />
                  {MERGE_METHOD_LABELS[id]}
                </label>
              ))}
            </div>
          )}

          {/* ---------------------- the remote branch ---------------------- */}
          {canDeleteRemoteBranch ? (
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={deleteRemoteBranch}
                disabled={busy || conflicts}
                onChange={(event) =>
                  setDeleteRemoteBranch(event.target.checked)
                }
              />
              Delete the remote branch{" "}
              <span className="font-mono">{item.headBranch}</span>
            </label>
          ) : null}
          {conflicts ? null : (
            <p className="mt-1 text-sm text-faint">
              {!canDeleteRemoteBranch
                ? `Deleting the remote branch is not offered for this repository, so ${item.headBranch} is kept.`
                : deleteRemoteBranch
                  ? `The remote branch ${item.headBranch} is deleted with the merge.`
                  : `The remote branch ${item.headBranch} is kept.`}
            </p>
          )}
        </div>
      ) : null}

      {/* -------------------------- the checkout --------------------------- */}
      {hasCheckout && !outcomeUnknown ? (
        <div className="mt-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={removeWorktree}
              disabled={busy}
              onChange={(event) => setRemoveWorktree(event.target.checked)}
            />
            Remove the local worktree and delete the branch{" "}
            <span className="font-mono">{item.headBranch}</span>
          </label>
          <p className="mt-1 text-sm text-faint">
            {removeWorktree
              ? `The checkout of ${item.headBranch} is removed once delivery into ${item.baseBranch} is verified, its local branch deleted, and the sessions working in it are settled — one that is running, or waiting on an answer or approval, refuses the removal instead.`
              : `The local checkout of ${item.headBranch} is kept; it stays listed here until it is cleaned up.`}
          </p>
        </div>
      ) : null}

      {/* -------------------------- always stated -------------------------- */}
      {merging ? (
        <p className="mt-2 text-sm text-faint">
          Any Task this pull request's card links is SUGGESTED done for you to
          answer; merging never writes a Task's status itself.
        </p>
      ) : null}

      {/* -------------------------- the consent ---------------------------- */}
      {needsForce ? (
        <div className="mt-2 rounded-lg border border-red-400/40 bg-red-500/10 p-2.5">
          <p className="flex items-start gap-1.5 text-sm text-red-400">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {/* The server's own words: this consent answers the refusal its
                refreshed verification actually produced, which is what makes
                the answer match the question. */}
            The cleanup was refused: {refusal} Removing it anyway may LOSE every
            commit on <span className="font-mono">{item.headBranch}</span>.
          </p>
          <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={confirmForce}
              disabled={busy}
              onChange={(event) => setConfirmForce(event.target.checked)}
            />
            I understand, remove it anyway
          </label>
        </div>
      ) : null}

      {!merging && !hasCheckout && !outcomeUnknown ? (
        <p className="mt-2 text-sm text-faint">
          Nothing is left to do here: this pull request is {item.state} and no
          local worktree holds {item.headBranch}.
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
