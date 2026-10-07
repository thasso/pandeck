import { Eraser, GitMerge, MessageSquare } from "lucide-react";
import { useState } from "react";
import { PULL_REQUEST_MERGE_METHODS } from "@assistant/shared";
import type {
  PullRequestMergeMethod,
  ReviewFinding,
  SessionListItem,
  WorkflowCeilingRaise,
  WorkflowRunCard as WorkflowRunCardProjection,
  WorkflowRunSummary,
} from "@assistant/shared";
import type {
  ClientWorkflowRunCard,
  ClientWorkflowRunDelivery,
} from "../hooks/useAssistant.ts";

import { ErrorNote, Spinner } from "./common/load.tsx";
import { ConfirmDialog, useDialogs } from "./common/dialogs.tsx";
import { DiscreteSlider } from "./common/RuntimePicker.tsx";
// One phase vocabulary for this card and for the Sessions inbox item that leads
// here: a run must not be called one thing where it is found and another where
// it is opened.
import { WORKFLOW_PHASE_LABEL } from "../lib/sessionInbox.ts";

const LIFECYCLE_TONE = {
  active: "bg-accent text-primary",
  paused: "bg-warning/15 text-warning",
  completed: "bg-emerald-500/10 text-emerald-500",
  cancelled: "bg-panel text-faint",
} as const;

const VERDICT_TONE = {
  pass: "text-emerald-500",
  revise: "text-warning",
  fail: "text-danger",
} as const;

const CONTROL_CLASS =
  "min-h-9 rounded-lg border border-line px-3 py-1.5 text-caption font-medium text-muted-foreground hover:bg-panel hover:text-fg";

/** A touch-friendly N-more choice; absolute targets remain on the wire/API. */
function CeilingRaiseControl({
  decision,
  onRaise,
}: {
  decision: NonNullable<WorkflowRunCardProjection["ceilingDecision"]>;
  onRaise: (raise: WorkflowCeilingRaise) => void;
}) {
  // Starts where the run's own history suggests rather than at one. A run that
  // needs four more rounds used to be four interruptions, each granting a
  // decision the user had already made; the slider still reaches every amount.
  const [amount, setAmount] = useState(() =>
    Math.min(10, Math.max(1, decision.suggestedRaise)),
  );
  const noun =
    decision.blocked === "iterations" ? "fix rounds" : "review passes";
  const singular =
    decision.blocked === "iterations" ? "fix round" : "review pass";
  const field =
    decision.blocked === "iterations" ? "maxIterations" : "maxReviewPasses";
  return (
    <div className="w-full rounded-lg border border-line bg-surface/60 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-muted-foreground">Extend by</span>
        <span className="font-medium tabular-nums text-fg">
          {amount} {amount === 1 ? singular : noun}
        </span>
      </div>
      <DiscreteSlider
        min={1}
        max={10}
        value={amount}
        onChange={setAmount}
        ariaLabel={`Additional ${noun}`}
        valueText={`${String(amount)} additional ${noun}`}
      />
      <button
        type="button"
        className={`${CONTROL_CLASS} mt-2`}
        onClick={() =>
          onRaise({ mode: "raise-by", amounts: { [field]: amount } })
        }
      >
        Allow {amount} more
      </button>
    </div>
  );
}

/** The runtime a carried-out decision named, whichever role it was for. */
function routedRuntime(
  decision: NonNullable<WorkflowRunCardProjection["reviewDecision"]>,
): string | undefined {
  const config =
    decision.decision === "fix"
      ? decision.fixer
      : decision.decision === "deliver"
        ? decision.verdict
        : decision.reviewer;
  return config
    ? `${config.provider}:${config.modelId} (${config.thinkingLevel})`
    : undefined;
}

function shortCommit(commit: string): string {
  return commit.slice(0, 8);
}

function SessionButton({
  label,
  sessionId,
  sessions,
  onOpenSession,
}: {
  label: string;
  sessionId: string;
  sessions: SessionListItem[];
  onOpenSession: (id: string) => void;
}) {
  const session = sessions.find((item) => item.id === sessionId);
  const title = session?.title || sessionId;
  return (
    <button
      type="button"
      onClick={() => onOpenSession(sessionId)}
      // The spinner is decorative (R6), so what it stands for — this step's
      // session is still running — has to be in the button's NAME, which is
      // otherwise just the two lines of text below.
      aria-label={
        session?.isStreaming
          ? `${label}: ${title} — session is running`
          : undefined
      }
      className="flex min-h-10 w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-left text-caption text-muted-foreground hover:bg-panel hover:text-fg"
    >
      {session?.isStreaming ? (
        <Spinner size="sm" className="text-primary" />
      ) : (
        <MessageSquare size={13} className="shrink-0 text-faint" aria-hidden />
      )}
      <span className="shrink-0 font-medium text-fg">{label}</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </button>
  );
}

const MERGE_METHOD_LABELS: Record<PullRequestMergeMethod, string> = {
  squash: "Squash",
  merge: "Merge commit",
  rebase: "Rebase",
};

/**
 * The run's two DELIVERY controls, where the run's evidence is.
 *
 * Both act on the pull request the run published, and both used to be reachable
 * only from that card's own session — so finishing a run meant leaving the Task
 * for a chat, merging there, cleaning up there, and coming back to the Sessions
 * inbox for the acknowledgement. They are one block here because they are one
 * sequence: merge, then retire what the merge made disposable.
 *
 * What is offered is the SERVER's answer (`canMerge`/`canCleanUp`), never a
 * rule re-derived from the run's lifecycle: the same conditions guard the
 * messages these buttons send, so nothing offered here is refused there.
 *
 * What is RUNNING is the server's answer too, one beat later: the run's
 * `busyAction` is the pull-request card's, re-projected onto the run list, so
 * every viewer sees the same action. Only the browser that pressed the button
 * reads `pendingAction` as well — the click's own bridge to that echo, because
 * a control that moves only when the server answers is a control the user
 * presses twice (`app/web/docs/loading-states.md` R5).
 *
 * Neither asks for a confirmation, exactly as the live card does not: each
 * button states its consequence in full beside it, which a dialog the user
 * learns to click through would only replace with a worse copy.
 */
function DeliveryControls({
  runId,
  delivery,
  branch,
  onMerge,
  onCleanUp,
}: {
  runId: string;
  delivery: ClientWorkflowRunDelivery;
  branch: string | undefined;
  onMerge: (
    runId: string,
    options: {
      mergeMethod: PullRequestMergeMethod;
      deleteBranch: boolean;
    },
  ) => void;
  onCleanUp: (runId: string) => void;
}) {
  // Both are per-click decisions and neither is remembered: a method chosen for
  // one merge must not silently become the next run's.
  const [method, setMethod] = useState<PullRequestMergeMethod>();
  const [deleteBranch, setDeleteBranch] = useState(true);
  const offered = delivery.mergeMethods ?? [];
  const selected =
    method && offered.includes(method)
      ? method
      : delivery.defaultMergeMethod &&
          offered.includes(delivery.defaultMergeMethod)
        ? delivery.defaultMergeMethod
        : offered[0];
  const running = delivery.busyAction ?? delivery.pendingAction;
  const busy = Boolean(running);
  // The card clears its stored failure only when the server DEQUEUES the next
  // action, so until this click reaches that write the sentence in hand is the
  // PREVIOUS action's — one this click has already answered. It is hidden, not
  // dropped: the same field carries THIS action's refusal, and the moment the
  // click stops owning the control the failure standing there is shown.
  const error =
    delivery.pendingAction && !delivery.busyAction ? undefined : delivery.error;

  // A block with no control left can still be the only place a CONDITION is
  // stated: a retired checkout whose run was not settled with it. What the last
  // action came to is not one of those — the run's own banner already says it
  // merged and was cleaned up, and repeating it here would be a second success
  // note under the first.
  if (
    !delivery.canMerge &&
    !delivery.canCleanUp &&
    !error &&
    !delivery.settleStillNeeded
  )
    return null;

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-line bg-surface/60 px-3 py-2.5 text-caption">
      {delivery.canMerge ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {offered.length > 0 ? (
              <div className="inline-flex overflow-hidden rounded-lg border border-line">
                {PULL_REQUEST_MERGE_METHODS.filter((id) =>
                  offered.includes(id),
                ).map((id) => (
                  <button
                    key={id}
                    type="button"
                    disabled={busy}
                    onClick={() => setMethod(id)}
                    className={`px-2 py-1 transition-colors disabled:opacity-40 ${
                      selected === id
                        ? "bg-primary text-white"
                        : "bg-raised text-muted-foreground hover:bg-surface"
                    }`}
                  >
                    {MERGE_METHOD_LABELS[id]}
                  </button>
                ))}
              </div>
            ) : (
              <span className="text-faint">
                {delivery.mergeMethods
                  ? "This repository allows no merge method"
                  : "Merge methods are not known yet"}
              </span>
            )}
            <label
              className={`inline-flex items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 py-1 text-muted-foreground ${
                busy ? "opacity-40" : "cursor-pointer hover:bg-surface"
              }`}
            >
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={deleteBranch}
                disabled={busy}
                onChange={(event) => setDeleteBranch(event.target.checked)}
              />
              Delete remote branch
            </label>
            <button
              type="button"
              disabled={busy || !selected}
              aria-busy={running === "merge" || undefined}
              onClick={() =>
                selected &&
                onMerge(runId, { mergeMethod: selected, deleteBranch })
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-primary bg-primary px-2.5 py-1 font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-40"
            >
              <span className="flex size-3.5 items-center justify-center">
                {running === "merge" ? (
                  <Spinner size="sm" />
                ) : (
                  <GitMerge size={12} />
                )}
              </span>
              Merge
            </button>
          </div>
          <p className="text-micro text-faint">
            Merging records this run's decision and completes it
            {deleteBranch && branch
              ? `, and deletes the remote branch ${branch}; the local checkout stays until you clean it up.`
              : deleteBranch
                ? ", and deletes the remote branch; the local checkout stays until you clean it up."
                : `. The remote branch${branch ? ` ${branch}` : ""} is KEPT — delete it yourself when you are done with it.`}
          </p>
        </>
      ) : null}

      {delivery.canCleanUp ? (
        <>
          <button
            type="button"
            disabled={busy}
            aria-busy={running === "cleanup" || undefined}
            onClick={() => onCleanUp(runId)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-danger/40 bg-raised px-2.5 py-1 text-danger transition-colors hover:bg-danger/10 disabled:opacity-40"
          >
            <span className="flex size-3.5 items-center justify-center">
              {running === "cleanup" ? (
                <Spinner size="sm" />
              ) : (
                <Eraser size={12} />
              )}
            </span>
            Clean up
          </button>
          <p className="text-micro text-faint">
            Removes this run's worktree and its local branch — only once the
            base branch is confirmed to contain it — settles every session on
            that checkout, and settles the run itself, which takes it out of the
            Sessions inbox.
          </p>
        </>
      ) : null}

      {/* A present-tense CONDITION, derived from the run's attention cursor, so
          it goes away by itself the moment the run is settled anywhere. It does
          not repeat WHY the Settle is refused: the inbox item carries that
          live, on the Settle it disables. */}
      {delivery.settleStillNeeded ? (
        <p className="text-muted-foreground">
          The checkout is gone, but this run is still waiting for its Settle in
          the Sessions inbox.
        </p>
      ) : null}
      {error ? <ErrorNote message={error} /> : null}
    </div>
  );
}

/** One list of the reviewer's own words; nothing renders for an empty list. */
function ReviewList({
  label,
  items,
}: {
  label: string;
  items: (ReviewFinding | string)[] | undefined;
}) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="font-medium text-fg">{label}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {items.map((item, index) => (
          <li
            key={`${index}-${typeof item === "string" ? item : `${item.severity}-${item.text}`}`}
            className="break-words"
          >
            {typeof item === "string"
              ? item
              : `[${item.severity}] ${item.path && item.line ? `${item.path}:${item.line} — ` : ""}${item.text}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The coordinator and inspection surface for one code-delivery Workflow Run. */
export function WorkflowRunCard({
  run,
  card,
  sessions,
  onOpenSession,
  onPause,
  onResume,
  onCancel,
  onDelete,
  onRetry,
  onAnswerCeiling,
  onRebaseAndReview,
  onMerge,
  onCleanUp,
}: {
  run: WorkflowRunSummary;
  /** The wire projection plus this browser's unanswered delivery click. */
  card: ClientWorkflowRunCard | undefined;
  sessions: SessionListItem[];
  onOpenSession: (id: string) => void;
  onPause: (runId: string) => void;
  onResume: (runId: string) => void;
  onCancel: (runId: string) => void;
  onDelete: (
    runId: string,
    options: { deleteWorktree: boolean; archiveSessions: boolean },
  ) => void;
  onRetry: (runId: string) => void;
  onAnswerCeiling: (
    runId: string,
    choice: "raise" | "deliver" | "re-evaluate" | "cancel",
    raise?: WorkflowCeilingRaise,
  ) => void;
  onRebaseAndReview: (runId: string) => void;
  /** Merge the run's pull request at its merge seam; omitted where it cannot. */
  onMerge?: (
    runId: string,
    options: { mergeMethod: PullRequestMergeMethod; deleteBranch: boolean },
  ) => void;
  /** Retire the finished run's checkout and settle the run with it. */
  onCleanUp?: (runId: string) => void;
}) {
  const dialogs = useDialogs();
  // A CANCELLED run's "Delete run…", which is not this card's "Clean up": that
  // one retires a delivered run's checkout, this one discards an abandoned
  // attempt's history.
  const [deleteRunOpen, setDeleteRunOpen] = useState(false);
  // Runs are first broadcast before provisioning binds their worktree. Keep the
  // default derived until the user actually changes it, so that later binding
  // still makes cleanup default on without overwriting an explicit choice.
  const [deleteWorktreeChoice, setDeleteWorktreeChoice] = useState<boolean>();
  const deleteWorktree = deleteWorktreeChoice ?? Boolean(run.worktreeId);
  const [archiveSessions, setArchiveSessions] = useState(true);
  const terminal =
    run.lifecycle === "completed" || run.lifecycle === "cancelled";
  const delivery = card?.pullRequest?.delivery;
  const phase = card?.phase ?? "starting";
  const activity = card?.activity;
  const activityLabel =
    activity === "running"
      ? "working"
      : activity === "waiting"
        ? "waiting to start"
        : null;
  // `maxIterations` may legitimately be 0 — "review it, and no agent touches
  // the code again" — and there is then no iteration to be on; counting one
  // would read "iteration 0 of 0".
  const iteration = Math.min(
    (card?.iterationsUsed ?? 0) + 1,
    run.limits.maxIterations,
  );
  const showNextAction = !(
    run.lifecycle === "paused" &&
    run.lifecycleReason &&
    card?.nextAction.trim() === run.lifecycleReason.trim()
  );
  // The stopped step's own words, but only where they add something: the banner
  // and `nextAction` may already carry the very same sentence.
  const blocked = card?.blockedReason;
  const blockedSummary =
    run.lifecycle === "paused" &&
    blocked &&
    blocked.summary.trim() !== run.lifecycleReason?.trim() &&
    blocked.summary.trim() !== card?.nextAction.trim()
      ? blocked.summary
      : null;
  // A retry that reproduced its predecessor's outcome. The COUNT belongs to the
  // recipe's pause reason, which the banner or `nextAction` already renders
  // verbatim; repeating it here would be exactly the duplication `blockedSummary`
  // above avoids. What neither says is what pressing Retry again would do.
  const attempts = card?.repeatedAttempts ?? 1;
  const repeatedAttempts =
    run.lifecycle === "paused" && attempts > 1 ? attempts : null;

  // Every control below asks before it acts, so each is an async body reached
  // from a `() => void` slot: `dialogs` settles rather than rejecting, and what
  // follows a yes is a plain synchronous callback. The ceiling gate's Cancel and
  // the footer's Cancel are the SAME irreversible action, so they share one
  // question here rather than restating it in two places.
  const confirmCancel = async (answer: () => void) => {
    const confirmed = await dialogs.confirm({
      title: "Cancel this workflow run?",
      body: "Its sessions, worktree, and any pull request will be preserved.",
      confirmLabel: "Cancel run",
      cancelLabel: "Keep running",
      danger: true,
    });
    if (confirmed) answer();
  };
  const confirmRebaseAndReview = async () => {
    const confirmed = await dialogs.confirm({
      title: "Rebase and send through review again?",
      body: "The new head goes back through review. A conflict gets one automatic repair attempt before the run pauses.",
      confirmLabel: "Rebase and re-review",
    });
    if (confirmed) onRebaseAndReview(run.id);
  };
  // Retries stay uncapped: only the user can know whether the condition the step
  // reported has been repaired outside the run, and an agent tail's next attempt
  // runs a fresh session, so a repeat is evidence rather than a verdict. A cap
  // would strand the run of someone who just repaired it — so this asks once the
  // same outcome has come back, and then does whatever they chose.
  const confirmRetry = async () => {
    if (
      repeatedAttempts &&
      !(await dialogs.confirm({
        title: "Retry anyway?",
        body: `The last ${repeatedAttempts} attempts ended with the same result. Retry re-runs the same assignment.`,
        confirmLabel: "Retry",
      }))
    )
      return;
    onRetry(run.id);
  };

  return (
    <article className="rounded-xl border border-line bg-panel/40 p-4">
      <div className="flex items-center gap-2">
        <h3 className="shrink-0 text-body font-semibold text-fg">Workflow</h3>
        {run.branch ? (
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted-foreground">
            {run.branch}
          </span>
        ) : null}
        <span
          className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-micro font-medium uppercase tracking-wide ${LIFECYCLE_TONE[run.lifecycle]}`}
        >
          {run.lifecycle}
        </span>
      </div>

      <p className="mt-2 text-caption text-muted-foreground">
        <span className="font-medium text-fg">
          {WORKFLOW_PHASE_LABEL[phase]}
        </span>
        {activityLabel ? ` — ${activityLabel}` : ""}
        {run.limits.maxIterations > 0
          ? ` · iteration ${iteration} of ${run.limits.maxIterations}`
          : " · no fix rounds"}
      </p>

      {run.lifecycle === "paused" ? (
        <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-caption text-warning">
          {run.lifecycleReason || "Paused"}
        </p>
      ) : null}

      {blockedSummary && blocked ? (
        <p className="mt-2 break-words text-caption text-muted-foreground">
          <span className="font-medium text-fg">
            {blocked.phase ? WORKFLOW_PHASE_LABEL[blocked.phase] : "Step"}{" "}
            {blocked.status}
          </span>{" "}
          — {blockedSummary}
        </p>
      ) : null}

      {run.lifecycle === "paused" && blocked?.rebaseConflict ? (
        <div className="mt-2 rounded-lg border border-warning/30 px-3 py-2 text-caption text-muted-foreground">
          <p className="font-medium text-fg">Rebase conflict</p>
          {blocked.rebaseConflict.files.length > 0 ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {blocked.rebaseConflict.files.map((file) => (
                <li key={file} className="break-words font-mono">
                  {file}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1">
              Git could not determine the conflicted files.
            </p>
          )}
          {blocked.rebaseConflict.truncated ? (
            <p className="mt-1 text-faint">The file list was shortened.</p>
          ) : null}
          <p className="mt-2 break-words">
            {blocked.rebaseConflict.restored
              ? "The failed rebase was aborted, so the run branch was restored and the worktree is clean."
              : "The server could not verify that the run branch was restored and clean. Inspect the run worktree before continuing."}{" "}
            Resolve the rebase onto {blocked.rebaseConflict.baseBranch} in the
            run worktree, then Retry.
          </p>
        </div>
      ) : null}

      {run.lifecycle === "paused" && blocked?.operationTriage ? (
        <div className="mt-2 rounded-lg border border-warning/30 px-3 py-2 text-caption text-muted-foreground">
          <p className="font-medium text-fg">Automatic triage already spent</p>
          <p className="mt-1 break-words">
            The {WORKFLOW_PHASE_LABEL[blocked.operationTriage.phase]} step
            failed the same way twice, so the run handed its implementer one
            diagnostic assignment before stopping here.{" "}
            {blocked.operationTriage.stoppedOn === "triage"
              ? "The summary above is what that agent found."
              : "The operation ran again afterwards and failed on its own terms; the summary above is its error."}{" "}
            {blocked.operationTriage.restored
              ? "The run branch was left exactly as the triage found it."
              : "The server could not verify that the run branch was left as the triage found it. Inspect the run worktree before continuing."}
          </p>
        </div>
      ) : null}

      {repeatedAttempts ? (
        <p className="mt-2 break-words text-caption text-muted-foreground">
          <span className="font-medium text-fg">
            Retry re-runs the same assignment
          </span>{" "}
          — exactly as this step received it, and usually in the same session,
          which remembers the attempt that stopped. It can still end
          differently: the condition it reported may have been repaired outside
          the run.
        </p>
      ) : null}

      {card?.workPlan ? (
        <div className="mt-3 rounded-lg border border-line px-3 py-2 text-caption text-muted-foreground">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium capitalize text-fg">
              {card.workPlan.complexity} complexity
            </span>
          </div>
          <div className="mt-1 break-words">
            Implement: {card.workPlan.implementer.provider}:
            {card.workPlan.implementer.modelId} (
            {card.workPlan.implementer.thinkingLevel},{" "}
            {card.workPlan.implementer.family}){" · "}
            Review: {card.workPlan.reviewer.provider}:
            {card.workPlan.reviewer.modelId} (
            {card.workPlan.reviewer.thinkingLevel},{" "}
            {card.workPlan.reviewer.family})
          </div>
          <p className="mt-1 break-words text-faint">
            {card.workPlan.rationale}
          </p>
        </div>
      ) : null}

      {card?.reviewDecision ? (
        <div className="mt-3 text-caption text-muted-foreground">
          <p>
            After review pass {card.reviewDecision.afterPass}, the run{" "}
            <span className="font-medium text-fg">
              {card.reviewDecision.decision === "deliver"
                ? "delivered"
                : card.reviewDecision.decision === "fix"
                  ? card.reviewDecision.assignee === "implementer"
                    ? "sent the findings back to the implementer"
                    : "took a fix round"
                  : "took another review pass"}
            </span>
            {routedRuntime(card.reviewDecision)
              ? ` on ${routedRuntime(card.reviewDecision)}`
              : ""}
            .
          </p>
          <p className="mt-1 break-words text-faint">
            {card.reviewDecision.rationale}
          </p>
          <ReviewList
            label={
              card.reviewDecision.decision === "fix"
                ? "Focus for the fix round"
                : "Focus for the next pass"
            }
            items={card.reviewDecision.focus}
          />
          {card.reviewDecision.truncated ? (
            <p className="mt-1 text-faint">
              Shortened for this card — the coordinator session has the full
              decision.
            </p>
          ) : null}
        </div>
      ) : null}

      {card?.latestAssessment ? (
        <div className="mt-3 text-caption text-muted-foreground">
          <p>
            Reviewed commit{" "}
            <span className="font-mono text-fg">
              {shortCommit(card.latestAssessment.headCommit)}
            </span>{" "}
            —{" "}
            <span
              className={`font-medium ${VERDICT_TONE[card.latestAssessment.verdict]}`}
            >
              {card.latestAssessment.verdict}
            </span>
            {card.latestAssessment.stale ? " (outdated — workspace moved)" : ""}
          </p>
          {card.latestAssessment.summary ? (
            <p className="mt-1 break-words text-faint">
              {card.latestAssessment.summary}
            </p>
          ) : null}
          <ReviewList
            label="Findings — these must be addressed before delivery"
            items={card.latestAssessment.findings}
          />
          <ReviewList
            label="Observations — noted, not required"
            items={card.latestAssessment.observations}
          />
          {card.latestAssessment.truncated ? (
            <p className="mt-1 text-faint">
              Shortened for this card — the reviewer session has the full
              review.
            </p>
          ) : null}
          {card.reviewSet ? (
            <p className="mt-1 text-faint">
              Published as a review set on the worktree:{" "}
              {card.reviewSet.findingCount} anchored{" "}
              {card.reviewSet.findingCount === 1 ? "finding" : "findings"} —{" "}
              {card.reviewSet.resolvedCount} resolved,{" "}
              {card.reviewSet.disputedCount} answered and left open,{" "}
              {card.reviewSet.openCount} unanswered. Open the worktree's review
              to read the threads.
            </p>
          ) : null}
        </div>
      ) : null}

      {card?.pullRequest ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-caption">
          <a
            href={card.pullRequest.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary hover:underline"
          >
            Pull request #{card.pullRequest.number}
          </a>
          <button
            type="button"
            className="text-muted-foreground hover:text-fg"
            onClick={() => onOpenSession(card.pullRequest!.sessionId)}
          >
            Open live PR card
          </button>
        </div>
      ) : null}

      {card?.coordinatorSessionId ||
      card?.implementerSessionId ||
      card?.fixerSessionId ||
      card?.verdictSessionId ||
      card?.reviewerSessions?.length ? (
        // `grid-cols-1` is load-bearing, not noise: a bare `grid` leaves an
        // implicit `auto` column, whose minimum is the row's min-content — and a
        // `truncate` (white-space: nowrap) session title contributes its FULL
        // width there, so a long title pushes the buttons out of the card
        // instead of ellipsing. `grid-cols-*` tracks are `minmax(0, 1fr)`.
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {card.coordinatorSessionId ? (
            <SessionButton
              label="Coordinator"
              sessionId={card.coordinatorSessionId}
              sessions={sessions}
              onOpenSession={onOpenSession}
            />
          ) : null}
          {card.implementerSessionId ? (
            <SessionButton
              label="Implementer"
              sessionId={card.implementerSessionId}
              sessions={sessions}
              onOpenSession={onOpenSession}
            />
          ) : null}
          {card.fixerSessionId ? (
            <SessionButton
              label="Fixer"
              sessionId={card.fixerSessionId}
              sessions={sessions}
              onOpenSession={onOpenSession}
            />
          ) : null}
          {card.verdictSessionId ? (
            <SessionButton
              label="Verdict"
              sessionId={card.verdictSessionId}
              sessions={sessions}
              onOpenSession={onOpenSession}
            />
          ) : null}
          {(card.reviewerSessions ?? []).map((review) => (
            <SessionButton
              key={review.sessionId}
              label={
                (card.reviewerSessions ?? []).length > 1
                  ? `Reviewer ${review.pass}`
                  : "Reviewer"
              }
              sessionId={review.sessionId}
              sessions={sessions}
              onOpenSession={onOpenSession}
            />
          ))}
        </div>
      ) : null}

      {card?.cancelRequested ? (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-caption text-amber-600">
          Cancelling — waiting for the step in flight to finish. Nothing further
          will be started.
        </p>
      ) : null}

      {card?.ceilingDecision ? (
        <div className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-caption text-amber-600">
          <p>
            The run reached its{" "}
            {card.ceilingDecision.blocked === "iterations"
              ? "fix-round"
              : "review-pass"}{" "}
            ceiling and wanted to {card.ceilingDecision.wanted}.
          </p>
          <p className="mt-1 text-faint">
            Spent so far: {card.ceilingDecision.spent.iterations} fix{" "}
            {card.ceilingDecision.spent.iterations === 1 ? "round" : "rounds"}{" "}
            of {card.ceilingDecision.ceilings.maxIterations},{" "}
            {card.ceilingDecision.spent.reviewPasses} review{" "}
            {card.ceilingDecision.spent.reviewPasses === 1 ? "pass" : "passes"}{" "}
            of {card.ceilingDecision.ceilings.maxReviewPasses}, and{" "}
            {card.ceilingDecision.spent.sessions}{" "}
            {card.ceilingDecision.spent.sessions === 1 ? "session" : "sessions"}
            .
          </p>
          {card.ceilingDecision.allowedChoices.includes("re-evaluate") ? (
            <p className="mt-1">
              There is no commit to deliver from here. Commit or discard the
              stray work yourself and choose “Look again”, or extend the run.
            </p>
          ) : !card.ceilingDecision.allowedChoices.includes("deliver") ? (
            <p className="mt-1">
              There is no commit to deliver from here. Extend the run, or cancel
              it and keep the worktree.
            </p>
          ) : !card.ceilingDecision.headCarriesDiscoveryReview ? (
            <p className="mt-1 font-medium">
              Delivering as it stands would ship work no review pass has
              accepted.
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <CeilingRaiseControl
              key={`${card.ceilingDecision.blocked}:${String(card.ceilingDecision.ceilings.maxIterations)}:${String(card.ceilingDecision.ceilings.maxReviewPasses)}`}
              decision={card.ceilingDecision}
              onRaise={(raise) => onAnswerCeiling(run.id, "raise", raise)}
            />
            {card.ceilingDecision.allowedChoices.includes("deliver") ? (
              <button
                type="button"
                className={CONTROL_CLASS}
                onClick={() => onAnswerCeiling(run.id, "deliver")}
              >
                Deliver as it stands
              </button>
            ) : null}
            {card.ceilingDecision.allowedChoices.includes("re-evaluate") ? (
              <button
                type="button"
                className={CONTROL_CLASS}
                onClick={() => onAnswerCeiling(run.id, "re-evaluate")}
              >
                Look again
              </button>
            ) : null}
            <button
              type="button"
              className={`${CONTROL_CLASS} text-danger`}
              onClick={() =>
                void confirmCancel(() => onAnswerCeiling(run.id, "cancel"))
              }
            >
              Cancel run
            </button>
          </div>
        </div>
      ) : null}

      {card?.mergeDecisionReady ? (
        <p className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-caption text-emerald-500">
          Reviewed head passed CI and is mergeable. Merge below to record this
          run's decision, or cancel the run.
        </p>
      ) : null}

      {run.lifecycle === "completed" ? (
        <p className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-caption text-emerald-500">
          Pull request merged.
          {delivery?.canCleanUp
            ? " Clean up below to retire the checkout and settle the run."
            : delivery?.cleanedUp
              ? " The checkout was cleaned up."
              : ""}{" "}
          Answering the Task's own status stays a separate choice.
        </p>
      ) : null}

      {delivery && onMerge && onCleanUp ? (
        <DeliveryControls
          runId={run.id}
          delivery={delivery}
          branch={run.branch}
          onMerge={onMerge}
          onCleanUp={onCleanUp}
        />
      ) : null}

      {run.lifecycle === "cancelled" ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-3">
          <p className="min-w-0 flex-1 text-caption text-muted-foreground">
            No more work will run. Delete this attempt when you no longer need
            its history.
          </p>
          <button
            type="button"
            className={`${CONTROL_CLASS} text-danger`}
            onClick={() => setDeleteRunOpen(true)}
          >
            Delete run…
          </button>
        </div>
      ) : null}

      {showNextAction ? (
        <p className="mt-3 text-caption text-fg">
          {card?.nextAction ??
            (run.lifecycle === "paused"
              ? // No card means this build has no decision function for the
                // run's recipe, and none is coming. "Preparing…" would promise
                // a status that never arrives, in the one state where the user
                // has to decide to cancel.
                "This build does not recognize this run's recipe, so it cannot be continued. Cancelling keeps the worktree, branch, sessions and any pull request."
              : "Preparing workflow status…")}
        </p>
      ) : null}

      {!terminal ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {run.lifecycle === "active" ? (
            <button
              type="button"
              className={CONTROL_CLASS}
              onClick={() => onPause(run.id)}
            >
              Pause
            </button>
          ) : null}
          {/* The server decides this: Resume is offered only where it would
              actually move the run. A pause the recipe re-derives from the same
              history comes straight back, and a run with no card at all is one
              this build has no decision function for. */}
          {card?.canResume ? (
            <button
              type="button"
              className={CONTROL_CLASS}
              onClick={() => onResume(run.id)}
            >
              Resume
            </button>
          ) : null}
          {card?.canRebaseAndReview ? (
            <button
              type="button"
              className={CONTROL_CLASS}
              onClick={() => void confirmRebaseAndReview()}
            >
              Rebase and re-review
            </button>
          ) : null}
          {card?.canRetry ? (
            <button
              type="button"
              className={CONTROL_CLASS}
              onClick={() => void confirmRetry()}
            >
              {repeatedAttempts ? "Retry again" : "Retry"}
            </button>
          ) : null}
          <button
            type="button"
            className={`${CONTROL_CLASS} text-danger`}
            onClick={() => void confirmCancel(() => onCancel(run.id))}
          >
            Cancel
          </button>
        </div>
      ) : null}
      {deleteRunOpen ? (
        <ConfirmDialog
          title="Delete this cancelled workflow run?"
          body="This permanently deletes the run's recorded steps and review history. Choose which resources to clean up with it."
          confirmLabel="Delete run"
          cancelLabel="Keep run"
          danger
          onConfirm={() => {
            onDelete(run.id, {
              deleteWorktree: Boolean(run.worktreeId) && deleteWorktree,
              archiveSessions,
            });
            setDeleteRunOpen(false);
          }}
          onCancel={() => setDeleteRunOpen(false)}
        >
          <div className="mt-3 space-y-2 text-caption text-muted-foreground">
            {run.worktreeId ? (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={deleteWorktree}
                  onChange={(event) =>
                    setDeleteWorktreeChoice(event.target.checked)
                  }
                />
                <span>
                  Delete the worktree and local branch, discarding unmerged
                  changes.
                </span>
              </label>
            ) : null}
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={archiveSessions}
                onChange={(event) => setArchiveSessions(event.target.checked)}
              />
              <span>
                {run.worktreeId
                  ? "Archive the sessions linked to this workflow's worktree."
                  : "Archive the workflow's sessions."}
              </span>
            </label>
          </div>
        </ConfirmDialog>
      ) : null}
    </article>
  );
}
