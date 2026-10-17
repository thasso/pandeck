import { Markdown } from "./Markdown.tsx";
import { runtimeLabel } from "./common/runtimeLabel.ts";
import {
  ChevronRight,
  CircleCheck,
  Eraser,
  GitMerge,
  MessageSquare,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import type {
  PullRequestMergeMethod,
  ReviewFinding,
  SessionListItem,
  WorkflowCeilingRaise,
  WorkflowCommitCheckBlocker,
  WorkflowCommitCheckChoice,
  WorkflowRunCard as WorkflowRunCardProjection,
  WorkflowRunCardRoleConfig,
  WorkflowRunSummary,
} from "@assistant/shared";
import type { ClientWorkflowRunCard } from "../hooks/useAssistant.ts";

import { ErrorNote, Spinner } from "./common/load.tsx";
import { ConfirmDialog, useDialogs } from "./common/dialogs.tsx";
import { DiscreteSlider } from "./common/RuntimePicker.tsx";
// One phase vocabulary for this card and for the Sessions inbox item that leads
// here: a run must not be called one thing where it is found and another where
// it is opened.
import { WORKFLOW_PHASE_LABEL } from "../lib/sessionInbox.ts";
import { MergeMethodPicker } from "./PullRequestCard.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AppCard, type AppCardTone } from "./common/AppCard.tsx";
import {
  DateProperty,
  PropertyLabel,
  PropertyList,
  PropertyText,
} from "./common/PropertyList.tsx";
import { shortCommit } from "@assistant/shared/buildInfo";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { OverflowMenu } from "./common/OverflowMenu.tsx";
import { useStoredOpen } from "../hooks/useStoredOpen.ts";

const LIFECYCLE_TONE: Record<WorkflowRunSummary["lifecycle"], AppCardTone> = {
  active: "info",
  paused: "warning",
  completed: "success",
  cancelled: "neutral",
};

const LIFECYCLE_LABEL: Record<WorkflowRunSummary["lifecycle"], string> = {
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
};

const VERDICT_TONE = {
  pass: "text-success",
  revise: "text-warning",
  fail: "text-destructive",
} as const;

/** "commit step 2215 ended as blocked" → "Commit step 2215 ended as blocked". */
function sentence(text: string): string {
  const trimmed = shortCommits(text.trim());
  return trimmed ? trimmed[0]!.toUpperCase() + trimmed.slice(1) : trimmed;
}

/** Server prose names full 40-character commits; a reader needs the short id. */
function shortCommits(text: string): string {
  return text.replace(/\b[0-9a-f]{40}\b/g, (oid) => shortCommit(oid) ?? oid);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the commit check called each problem, in a reader's words. */
const COMMIT_CHECK_KIND_LABEL: Record<
  WorkflowCommitCheckBlocker["kind"],
  string
> = {
  secret: "Secret",
  unrelated: "Unrelated change",
  too_broad: "Too broad for one commit",
  unsafe: "Unsafe",
  unclear: "Unclear",
  other: "Problem",
};

/**
 * A stopped step's summary without the operation's own prefix ("commit phase
 * blocked: …"): the box around it already says which step stopped and how.
 */
function stepSummaryText(summary: string): string {
  return sentence(summary.replace(/^[\w -]+ phase (blocked|failed):\s*/i, ""));
}

/**
 * The stopped step's report in the attention box. A step's summary is often
 * the agent's own words, so it renders as Markdown, in a `div` because Markdown
 * renders blocks.
 */
function StepSummary({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words">
      <Markdown text={stepSummaryText(text)} density="compact" />
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

/**
 * The run's ONE condition that needs the reader, stated where its controls
 * are. A run can be in several at once (paused, blocked, at a ceiling), but
 * only the first that asks for a decision is shown: the rest are either the
 * same fact restated or follow from it.
 */
function Attention({
  variant,
  title,
  children,
}: {
  variant: "warning" | "success";
  title: string;
  children?: ReactNode;
}) {
  return (
    <Alert variant={variant} role="note">
      {variant === "warning" ? <TriangleAlert /> : <CircleCheck />}
      <AlertTitle>{title}</AlertTitle>
      {children ? (
        // The flex gap spaces the paragraphs; the description's own paragraph
        // margin would stack on top of it.
        <AlertDescription className="flex flex-col gap-1.5 [&_p:not(:last-child)]:mb-0">
          {children}
        </AlertDescription>
      ) : null}
    </Alert>
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
    <div>
      <p className="font-medium text-foreground">{label}</p>
      <ul className="mt-1 flex list-disc flex-col gap-1 pl-4">
        {items.map((item, index) => (
          <li
            key={`${index}-${typeof item === "string" ? item : `${item.severity}-${item.text}`}`}
            className="break-words"
          >
            {typeof item === "string" ? (
              <Markdown text={item} inline />
            ) : (
              <>
                <span className="font-medium text-foreground">
                  {item.severity}
                </span>
                {item.path ? (
                  <span className="font-mono text-xs">
                    {" "}
                    {item.path}
                    {item.line ? `:${item.line}` : ""}
                  </span>
                ) : null}{" "}
                — <Markdown text={item.text} inline />
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A folded part of the run's evidence: closed by default, and whether it is
 * open is remembered for every run, so a reader who always reads the review
 * finds it open on the next run too.
 */
function RunSection({
  storageKey,
  title,
  children,
}: {
  storageKey: string;
  title: string;
  children: ReactNode;
}) {
  const [open, toggleOpen] = useStoredOpen(storageKey, false);
  return (
    <Collapsible open={open} onOpenChange={toggleOpen}>
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="-mx-2 w-fit justify-start font-medium text-foreground"
          />
        }
      >
        <ChevronRight className="transition-transform in-aria-expanded:rotate-90" />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 pt-1 pb-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A role's model as a property value: the model, its thinking level, the account. */
function RuntimeText({
  runtime,
  accountName,
}: {
  runtime: WorkflowRunCardRoleConfig;
  accountName: string | undefined;
}) {
  return (
    <PropertyText title={`${runtime.provider}:${runtime.modelId}`}>
      {runtimeLabel({
        model: runtime.modelId,
        thinkingLevel: runtime.thinkingLevel,
        account: accountName,
      })}
    </PropertyText>
  );
}

/** A role's session, as one row of the Sessions list. */
function SessionRow({
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
    <li>
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-2 font-normal"
        onClick={() => onOpenSession(sessionId)}
        // The spinner is decorative (R6), so what it stands for — this step's
        // session is still running — has to be in the row's NAME.
        aria-label={
          session?.isStreaming
            ? `${label}: ${title} — session is running`
            : undefined
        }
      >
        {session?.isStreaming ? <Spinner size="sm" /> : <MessageSquare />}
        <span className="shrink-0 font-medium">{label}</span>
        <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
          {title}
        </span>
      </Button>
    </li>
  );
}

/**
 * A session named inline — in a summary row or a sentence — opened on click.
 * Its full title is the tooltip; a running session carries the spinner.
 */
function SessionLink({
  sessionId,
  sessions,
  onOpenSession,
  children,
}: {
  sessionId: string;
  sessions: SessionListItem[];
  onOpenSession: (id: string) => void;
  /** The words to show; the session's title when omitted. */
  children?: ReactNode;
}) {
  const session = sessions.find((item) => item.id === sessionId);
  const title = session?.title || sessionId;
  return (
    <Button
      variant="link"
      size="xs"
      className="h-auto max-w-full gap-1 p-0 align-baseline font-normal"
      title={title}
      onClick={() => onOpenSession(sessionId)}
    >
      {session?.isStreaming ? <Spinner size="sm" /> : null}
      <span className="min-w-0 truncate">{children ?? title}</span>
    </Button>
  );
}

/** The coordinator and inspection surface for one code-delivery Workflow Run. */
export function WorkflowRunCard({
  run,
  card,
  sessions,
  accountNames,
  onOpenSession,
  onPause,
  onResume,
  onCancel,
  onDelete,
  onRetry,
  onAnswerCeiling,
  onAnswerCommitCheck,
  onRebaseAndReview,
  onMerge,
  onCleanUp,
  defaultCollapsed = false,
}: {
  run: WorkflowRunSummary;
  /** The wire projection plus this browser's unanswered delivery click. */
  card: ClientWorkflowRunCard | undefined;
  sessions: SessionListItem[];
  /** Account names by credential profile id, to say which account a role uses. */
  accountNames?: Readonly<Record<string, string>>;
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
  onAnswerCommitCheck: (
    runId: string,
    choice: WorkflowCommitCheckChoice,
  ) => void;
  onRebaseAndReview: (runId: string) => void;
  /** Merge the run's pull request at its merge seam; omitted where it cannot. */
  onMerge?: (
    runId: string,
    options: { mergeMethod: PullRequestMergeMethod; deleteBranch: boolean },
  ) => void;
  /** Retire the finished run's checkout and settle the run with it. */
  onCleanUp?: (runId: string) => void;
  /**
   * Start as one line (header, outcome, "Show details"): an older, finished
   * run under a newer one on the same Task.
   */
  defaultCollapsed?: boolean;
}) {
  const dialogs = useDialogs();
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  // A CANCELLED run's "Delete run…", which is not "Clean up": that one retires
  // a delivered run's checkout, this one discards an abandoned attempt's
  // history.
  const [deleteRunOpen, setDeleteRunOpen] = useState(false);
  // Runs are first broadcast before provisioning binds their worktree. Keep the
  // default derived until the user actually changes it, so that later binding
  // still makes cleanup default on without overwriting an explicit choice.
  const [deleteWorktreeChoice, setDeleteWorktreeChoice] = useState<boolean>();
  const deleteWorktree = deleteWorktreeChoice ?? Boolean(run.worktreeId);
  const [archiveSessions, setArchiveSessions] = useState(true);

  // Merge options are per-click decisions and neither is remembered: a method
  // chosen for one merge must not silently become the next run's.
  const [mergeMethod, setMergeMethod] = useState<PullRequestMergeMethod>();
  const [deleteBranch, setDeleteBranch] = useState(true);

  // The ceiling's "Allow N more" starts where the run's own history suggests
  // rather than at one, and starts over when the run hits a different ceiling.
  const ceiling = card?.ceilingDecision;
  const ceilingKey = ceiling
    ? `${ceiling.blocked}:${String(ceiling.ceilings.maxIterations)}:${String(ceiling.ceilings.maxReviewPasses)}`
    : "";
  const [raiseChoice, setRaiseChoice] = useState<{
    key: string;
    amount: number;
  }>();
  const raiseAmount =
    raiseChoice?.key === ceilingKey
      ? raiseChoice.amount
      : Math.min(10, Math.max(1, ceiling?.suggestedRaise ?? 1));

  const terminal =
    run.lifecycle === "completed" || run.lifecycle === "cancelled";
  const delivery = card?.pullRequest?.delivery;
  const phase = card?.phase ?? "starting";
  const running = card?.activity === "running";

  // `maxIterations` may legitimately be 0 — "review it, and no agent touches
  // the code again" — and there is then no iteration to be on.
  const iteration = Math.min(
    (card?.iterationsUsed ?? 0) + 1,
    run.limits.maxIterations,
  );
  const reviewPasses = card?.reviewerSessions?.length ?? 0;

  // The stopped step's own words, but only where they add something: the
  // headline may already carry the very same sentence.
  const blocked = card?.blockedReason;
  const blockedSummary =
    run.lifecycle === "paused" &&
    blocked &&
    blocked.summary.trim() !== run.lifecycleReason?.trim() &&
    blocked.summary.trim() !== card?.nextAction.trim()
      ? blocked.summary
      : null;
  // A retry that reproduced its predecessor's outcome: Retry then asks first.
  const attempts = card?.repeatedAttempts ?? 1;
  const repeatedAttempts =
    run.lifecycle === "paused" && attempts > 1 ? attempts : null;

  // Delivery: what is offered is the SERVER's answer (`canMerge`/`canCleanUp`),
  // and what is running is the server's answer one beat later (`busyAction`),
  // bridged by this browser's own click (`pendingAction`) so a control never
  // waits for the echo to move (`app/web/docs/loading-states.md` R5).
  const offeredMethods = delivery?.mergeMethods ?? [];
  const selectedMethod =
    mergeMethod && offeredMethods.includes(mergeMethod)
      ? mergeMethod
      : delivery?.defaultMergeMethod &&
          offeredMethods.includes(delivery.defaultMergeMethod)
        ? delivery.defaultMergeMethod
        : offeredMethods[0];
  const deliveryRunning = delivery?.busyAction ?? delivery?.pendingAction;
  const deliveryBusy = Boolean(deliveryRunning);
  // The stored failure is the PREVIOUS action's until this click reaches the
  // server's dequeue, so it is hidden — not dropped — while the click owns it.
  const deliveryError =
    delivery?.pendingAction && !delivery.busyAction
      ? undefined
      : delivery?.error;
  const canMerge = Boolean(delivery?.canMerge && onMerge);
  const canCleanUp = Boolean(delivery?.canCleanUp && onCleanUp);

  // Every control asks before it acts where the action cannot be taken back.
  // The ceiling's Cancel and the menu's Cancel are the SAME action, so they
  // share one question.
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
  const confirmCommitAnyway = async () => {
    const confirmed = await dialogs.confirm({
      title: "Commit over the commit check?",
      body: "The change is committed as it is, with the problems the check found. The run then reviews it as usual.",
      confirmLabel: "Commit anyway",
      danger: true,
    });
    if (confirmed) onAnswerCommitCheck(run.id, "commit-anyway");
  };
  const confirmRebaseAndReview = async () => {
    const confirmed = await dialogs.confirm({
      title: "Rebase and send through review again?",
      body: "The new head goes back through review. A conflict gets one automatic repair attempt before the run pauses.",
      confirmLabel: "Rebase and re-review",
    });
    if (confirmed) onRebaseAndReview(run.id);
  };
  // Retries stay uncapped: only the user can know whether the condition the
  // step reported has been repaired outside the run. Once the same outcome has
  // come back, this asks first, and then does whatever they chose.
  const confirmRetry = async () => {
    if (
      repeatedAttempts &&
      !(await dialogs.confirm({
        title: "Retry anyway?",
        body: `The last ${repeatedAttempts} attempts ended with the same result. Retry re-runs the same assignment, usually in the same session, which remembers the attempt that stopped.`,
        confirmLabel: "Retry",
      }))
    )
      return;
    onRetry(run.id);
  };

  const commitCheck = card?.commitCheckDecision;
  // What the run is doing, or what it needs: the line under the branch. Where
  // the attention box below explains a pause, this only says the run is waiting
  // and on whom — the box is where the why and the what-now are.
  const explainedPause =
    run.lifecycle !== "paused"
      ? null
      : commitCheck
        ? "Paused until you decide what happens to the refused commit."
        : ceiling
          ? "Paused at the run's limit until you decide."
          : blocked?.rebaseConflict ||
              blocked?.operationTriage ||
              blockedSummary
            ? "Paused. Retry once the cause is fixed, or cancel the run."
            : null;
  const headline =
    run.lifecycle === "completed"
      ? card?.pullRequest
        ? `Merged pull request #${card.pullRequest.number}.${delivery?.cleanedUp ? " The checkout was cleaned up." : ""}`
        : "Completed."
      : run.lifecycle === "cancelled"
        ? "Cancelled. No more work will run."
        : card?.cancelRequested
          ? "Cancelling — waiting for the step in flight to finish. Nothing further will be started."
          : explainedPause
            ? explainedPause
            : run.lifecycle === "paused" && run.lifecycleReason
              ? sentence(run.lifecycleReason)
              : card
                ? sentence(card.nextAction)
                : run.lifecycle === "paused"
                  ? // No card means this build has no decision function for the
                    // run's recipe, and none is coming.
                    "This build does not recognize this run's recipe, so it cannot be continued. Cancelling keeps the worktree, branch, sessions and any pull request."
                  : "Preparing workflow status…";

  const attention: ReactNode = commitCheck ? (
    <Attention
      variant="warning"
      title={
        commitCheck.autoFixSpent ? "Commit refused again" : "Commit refused"
      }
    >
      <p>
        The commit check read the change and did not commit it
        {commitCheck.autoFixSpent ? ", even after two fixes" : ""}:
      </p>
      <ul className="flex flex-col gap-1.5">
        {commitCheck.blockers.map((item, index) => (
          <li key={`${index}-${item.kind}`} className="flex flex-col">
            <span className="font-medium">
              {COMMIT_CHECK_KIND_LABEL[item.kind]}
              {item.file ? (
                <span className="font-mono text-xs font-normal">
                  {" "}
                  · {item.file}
                </span>
              ) : null}
            </span>
            <span className="break-words">
              <Markdown text={item.reason} inline />
            </span>
          </li>
        ))}
      </ul>
      {commitCheck.changedBySessionId ? (
        <p>
          The change came from the{" "}
          <SessionLink
            sessionId={commitCheck.changedBySessionId}
            sessions={sessions}
            onOpenSession={onOpenSession}
          >
            {commitCheck.changedBySessionId === card?.fixerSessionId
              ? "fixer's session"
              : "implementer's session"}
          </SessionLink>
          .
        </p>
      ) : null}
      <p>
        {commitCheck.blockers.some((item) => item.kind === "secret")
          ? "A secret must not be committed: send it back to take it out, or cancel the run."
          : commitCheck.autoFixSpent
            ? "Send it back for another fix, commit it as it is, or cancel the run."
            : "This is your call: send it back for a fix, commit it as it is, or cancel the run."}
      </p>
    </Attention>
  ) : ceiling ? (
    <Attention
      variant="warning"
      title={
        ceiling.blocked === "iterations"
          ? "Fix-round limit reached"
          : "Review-pass limit reached"
      }
    >
      <p>The run wanted to {shortCommits(ceiling.wanted)}.</p>
      <p>
        Spent {ceiling.spent.iterations} of {ceiling.ceilings.maxIterations} fix
        rounds and {ceiling.spent.reviewPasses} of{" "}
        {ceiling.ceilings.maxReviewPasses} review passes, in{" "}
        {plural(ceiling.spent.sessions, "session", "sessions")}.
      </p>
      {ceiling.allowedChoices.includes("re-evaluate") ? (
        <p>
          There is no commit to deliver. Commit or discard the stray work
          yourself and choose “Look again”, or extend the run.
        </p>
      ) : !ceiling.allowedChoices.includes("deliver") ? (
        <p>There is no commit to deliver. Extend the run, or cancel it.</p>
      ) : !ceiling.headCarriesDiscoveryReview ? (
        <p className="font-medium">
          Delivering as it stands ships work no review pass has accepted.
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5 pt-1">
        <div className="flex items-baseline justify-between gap-2">
          <span>Extend by</span>
          <span className="font-medium tabular-nums">
            {ceiling.blocked === "iterations"
              ? plural(raiseAmount, "fix round", "fix rounds")
              : plural(raiseAmount, "review pass", "review passes")}
          </span>
        </div>
        <DiscreteSlider
          min={1}
          max={10}
          value={raiseAmount}
          onChange={(amount) => setRaiseChoice({ key: ceilingKey, amount })}
          ariaLabel={
            ceiling.blocked === "iterations"
              ? "Additional fix rounds"
              : "Additional review passes"
          }
          valueText={`${String(raiseAmount)} more`}
        />
      </div>
    </Attention>
  ) : run.lifecycle === "paused" && blocked?.rebaseConflict ? (
    <Attention variant="warning" title="Rebase conflict">
      {blocked.rebaseConflict.files.length > 0 ? (
        <ul className="list-disc pl-4">
          {blocked.rebaseConflict.files.map((file) => (
            <li key={file} className="font-mono text-xs break-words">
              {file}
            </li>
          ))}
        </ul>
      ) : (
        <p>Git could not determine the conflicted files.</p>
      )}
      {blocked.rebaseConflict.truncated ? (
        <p>The file list was shortened.</p>
      ) : null}
      <p>
        {blocked.rebaseConflict.restored
          ? "The run branch was restored and the worktree is clean."
          : "The server could not verify that the run branch was restored. Inspect the worktree first."}{" "}
        Resolve the rebase onto {blocked.rebaseConflict.baseBranch} in the run
        worktree, then Retry.
      </p>
    </Attention>
  ) : run.lifecycle === "paused" && blocked?.operationTriage ? (
    <Attention variant="warning" title="Automatic triage already spent">
      <p>
        The {WORKFLOW_PHASE_LABEL[blocked.operationTriage.phase]} step failed
        the same way twice, so the implementer got one diagnostic assignment
        before the run stopped.{" "}
        {blocked.operationTriage.restored
          ? "The run branch is as the triage left it."
          : "The server could not verify the run branch afterwards. Inspect the worktree first."}
      </p>
      {blockedSummary ? <StepSummary text={blockedSummary} /> : null}
    </Attention>
  ) : blockedSummary && blocked ? (
    <Attention
      variant="warning"
      title={`${blocked.phase ? WORKFLOW_PHASE_LABEL[blocked.phase] : "Step"} ${blocked.status}`}
    >
      <StepSummary text={blockedSummary} />
      {repeatedAttempts ? (
        <p>The last {repeatedAttempts} attempts ended the same way.</p>
      ) : null}
    </Attention>
  ) : card?.mergeDecisionReady ? (
    <Attention variant="success" title="Ready to merge">
      <p>The reviewed head passed CI and is mergeable.</p>
    </Attention>
  ) : null;

  const plan = card?.workPlan;
  // Who does the work, role by role: the plan's implementer and reviewer, and
  // the fixer or verdict when the latest decision named one.
  const roleRuntimes: Array<{
    label: string;
    runtime: WorkflowRunCardRoleConfig;
  }> = plan
    ? [
        { label: "Implementer", runtime: plan.implementer },
        { label: "Reviewer", runtime: plan.reviewer },
        ...(card?.reviewDecision?.fixer
          ? [{ label: "Fixer", runtime: card.reviewDecision.fixer }]
          : []),
        ...(card?.reviewDecision?.verdict
          ? [{ label: "Verdict", runtime: card.reviewDecision.verdict }]
          : []),
      ]
    : [];
  const assessment = card?.latestAssessment;
  const decision = card?.reviewDecision;
  const sessionRows: Array<{ key: string; label: string; sessionId: string }> =
    [
      ...(card?.coordinatorSessionId
        ? [
            {
              key: "coordinator",
              label: "Coordinator",
              sessionId: card.coordinatorSessionId,
            },
          ]
        : []),
      ...(card?.implementerSessionId
        ? [
            {
              key: "implementer",
              label: "Implementer",
              sessionId: card.implementerSessionId,
            },
          ]
        : []),
      ...(card?.fixerSessionId
        ? [{ key: "fixer", label: "Fixer", sessionId: card.fixerSessionId }]
        : []),
      ...(card?.reviewerSessions ?? []).map((review) => ({
        key: `review-${review.sessionId}`,
        label:
          (card?.reviewerSessions ?? []).length > 1
            ? `Reviewer ${review.pass}`
            : "Reviewer",
        sessionId: review.sessionId,
      })),
      ...(card?.verdictSessionId
        ? [
            {
              key: "verdict",
              label: "Verdict",
              sessionId: card.verdictSessionId,
            },
          ]
        : []),
      ...(card?.pullRequest
        ? [
            {
              key: "pull-request",
              label: "Pull request",
              sessionId: card.pullRequest.sessionId,
            },
          ]
        : []),
    ];
  // The role whose session is working right now, so the card can say where.
  const liveRow = sessionRows.find(
    (row) => sessions.find((item) => item.id === row.sessionId)?.isStreaming,
  );

  // The footer: the one thing to do now on the right, the rest in a menu.
  const menuItems: ReactNode[] = [];
  if (!terminal && run.lifecycle === "active" && !card?.cancelRequested)
    menuItems.push(
      <DropdownMenuItem key="pause" onClick={() => onPause(run.id)}>
        Pause
      </DropdownMenuItem>,
    );
  if (!terminal && card?.canRebaseAndReview)
    menuItems.push(
      <DropdownMenuItem
        key="rebase"
        onClick={() => void confirmRebaseAndReview()}
      >
        Rebase and re-review
      </DropdownMenuItem>,
    );
  if (card?.pullRequest) {
    const prSession = card.pullRequest.sessionId;
    menuItems.push(
      <DropdownMenuItem key="pr-card" onClick={() => onOpenSession(prSession)}>
        Open live PR card
      </DropdownMenuItem>,
    );
  }
  if (!terminal && !card?.cancelRequested)
    menuItems.push(
      <DropdownMenuSeparator key="sep" />,
      <DropdownMenuItem
        key="cancel"
        variant="destructive"
        onClick={() => void confirmCancel(() => onCancel(run.id))}
      >
        Cancel run…
      </DropdownMenuItem>,
    );

  const primary: ReactNode[] = [];
  if (!terminal && commitCheck) {
    if (commitCheck.allowedChoices.includes("commit-anyway"))
      primary.push(
        <Button
          key="commit-anyway"
          size="xs"
          variant="outline"
          onClick={() => void confirmCommitAnyway()}
        >
          Commit anyway
        </Button>,
      );
    primary.push(
      <Button
        key="send-to-implementer"
        size="xs"
        onClick={() => onAnswerCommitCheck(run.id, "send-to-implementer")}
      >
        Send back for a fix
      </Button>,
    );
  }
  if (!terminal && ceiling) {
    if (ceiling.allowedChoices.includes("re-evaluate"))
      primary.push(
        <Button
          key="look"
          size="xs"
          variant="outline"
          onClick={() => onAnswerCeiling(run.id, "re-evaluate")}
        >
          Look again
        </Button>,
      );
    if (ceiling.allowedChoices.includes("deliver"))
      primary.push(
        <Button
          key="deliver"
          size="xs"
          variant="outline"
          onClick={() => onAnswerCeiling(run.id, "deliver")}
        >
          Deliver as it stands
        </Button>,
      );
    primary.push(
      <Button
        key="raise"
        size="xs"
        onClick={() =>
          onAnswerCeiling(run.id, "raise", {
            mode: "raise-by",
            amounts: {
              [ceiling.blocked === "iterations"
                ? "maxIterations"
                : "maxReviewPasses"]: raiseAmount,
            },
          })
        }
      >
        Allow {raiseAmount} more
      </Button>,
    );
  }
  if (canMerge)
    primary.push(
      <Button
        key="merge"
        size="xs"
        disabled={deliveryBusy || !selectedMethod}
        busy={deliveryRunning === "merge"}
        onClick={() =>
          selectedMethod &&
          onMerge?.(run.id, { mergeMethod: selectedMethod, deleteBranch })
        }
      >
        {deliveryRunning === "merge" ? null : <GitMerge />}
        Merge
      </Button>,
    );
  if (canCleanUp)
    primary.push(
      <Button
        key="cleanup"
        size="xs"
        variant="outline"
        disabled={deliveryBusy}
        busy={deliveryRunning === "cleanup"}
        onClick={() => onCleanUp?.(run.id)}
      >
        {deliveryRunning === "cleanup" ? null : <Eraser />}
        Clean up
      </Button>,
    );
  // The server decides these: each is offered only where it would move the run.
  if (!terminal && card?.canRetry)
    primary.push(
      <Button key="retry" size="xs" onClick={() => void confirmRetry()}>
        {repeatedAttempts ? "Retry again" : "Retry"}
      </Button>,
    );
  if (!terminal && card?.canResume)
    primary.push(
      <Button
        key="resume"
        size="xs"
        variant={card.canRetry ? "outline" : "default"}
        onClick={() => onResume(run.id)}
      >
        Resume
      </Button>,
    );
  if (run.lifecycle === "cancelled" && expanded)
    primary.push(
      <Button
        key="delete"
        variant="destructive"
        size="xs"
        onClick={() => setDeleteRunOpen(true)}
      >
        Delete run…
      </Button>,
    );

  // While Merge is offered, its picker takes the footer's left and this line
  // moves into the content above it.
  const mergeOutcome = canMerge
    ? deleteBranch
      ? "Completes the run and deletes the remote branch."
      : "Completes the run and keeps the remote branch."
    : null;
  const footerStart = canMerge
    ? null
    : canCleanUp
      ? "Removes the worktree and local branch, and settles the run."
      : run.lifecycle === "cancelled" && expanded
        ? "Deleting discards the run's history."
        : null;

  const status = (
    <>
      {!terminal ? <span>{WORKFLOW_PHASE_LABEL[phase]}</span> : null}
      <span>
        {card?.cancelRequested && !terminal
          ? "Cancelling"
          : run.lifecycle === "completed" && card?.pullRequest
            ? "Merged"
            : LIFECYCLE_LABEL[run.lifecycle]}
      </span>
    </>
  );

  return (
    <AppCard
      tone={LIFECYCLE_TONE[run.lifecycle]}
      icon={running ? <Spinner size="sm" /> : <Workflow />}
      label="Workflow run"
      status={status}
      footerStart={expanded ? footerStart : null}
      options={
        expanded && canMerge && delivery ? (
          <MergeMethodPicker
            offered={offeredMethods}
            known={Boolean(delivery.mergeMethods)}
            selected={selectedMethod}
            onSelect={setMergeMethod}
            deleteBranch={deleteBranch}
            onDeleteBranchChange={setDeleteBranch}
            disabled={deliveryBusy}
          />
        ) : null
      }
      actions={
        expanded ? (
          primary.length || menuItems.length ? (
            <>
              {primary}
              {menuItems.length ? (
                <OverflowMenu
                  label="More run actions"
                  size="icon-xs"
                  contentClassName="w-48"
                >
                  {menuItems}
                </OverflowMenu>
              ) : null}
            </>
          ) : null
        ) : (
          <Button variant="ghost" size="xs" onClick={() => setExpanded(true)}>
            Show details
          </Button>
        )
      }
      contentClassName="gap-3"
    >
      {/* The card's subject: what the run is on, and where it stands. */}
      <div className="flex min-w-0 flex-col gap-0.5">
        {run.branch ? (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {run.branch}
          </span>
        ) : null}
        <p className="break-words text-foreground">
          <Markdown text={headline} inline />
        </p>
      </div>

      {expanded ? (
        <>
          {attention}

          {/* A present-tense CONDITION from the run's attention cursor: it goes
              away by itself the moment the run is settled anywhere. */}
          {delivery?.settleStillNeeded ? (
            <p className="text-muted-foreground">
              The checkout is gone, but this run still waits for its Settle in
              the Sessions inbox.
            </p>
          ) : null}
          {deliveryError ? <ErrorNote message={deliveryError} /> : null}

          <PropertyList align="start" size="sm">
            {card?.coordinatorSessionId ? (
              <>
                <PropertyLabel>Coordinator</PropertyLabel>
                <PropertyText className="flex min-w-0">
                  <SessionLink
                    sessionId={card.coordinatorSessionId}
                    sessions={sessions}
                    onOpenSession={onOpenSession}
                  />
                </PropertyText>
              </>
            ) : null}
            {liveRow && liveRow.key !== "coordinator" ? (
              <>
                <PropertyLabel>Working in</PropertyLabel>
                <PropertyText className="flex min-w-0">
                  <SessionLink
                    sessionId={liveRow.sessionId}
                    sessions={sessions}
                    onOpenSession={onOpenSession}
                  >
                    {liveRow.label} session
                  </SessionLink>
                </PropertyText>
              </>
            ) : null}
            <PropertyLabel>Progress</PropertyLabel>
            <PropertyText>
              {run.limits.maxIterations > 0
                ? `Fix round ${iteration} of ${run.limits.maxIterations}`
                : "No fix rounds"}
              {` · ${reviewPasses} of ${run.limits.maxReviewPasses} review passes`}
            </PropertyText>
            {plan ? (
              <>
                <PropertyLabel>Complexity</PropertyLabel>
                <PropertyText className="capitalize">
                  {plan.complexity}
                </PropertyText>
                {roleRuntimes.map((row) => (
                  <Fragment key={row.label}>
                    <PropertyLabel>{row.label}</PropertyLabel>
                    <RuntimeText
                      runtime={row.runtime}
                      accountName={
                        row.runtime.credentialProfileId
                          ? accountNames?.[row.runtime.credentialProfileId]
                          : undefined
                      }
                    />
                  </Fragment>
                ))}
              </>
            ) : null}
            {assessment ? (
              <>
                <PropertyLabel>Last review</PropertyLabel>
                <PropertyText>
                  <span
                    className={`font-medium capitalize ${VERDICT_TONE[assessment.verdict]}`}
                  >
                    {assessment.verdict}
                  </span>
                  <span className="text-muted-foreground">
                    {" · "}
                    <span className="font-mono">
                      {shortCommit(assessment.headCommit)}
                    </span>
                    {assessment.findings?.length
                      ? ` · ${plural(assessment.findings.length, "finding", "findings")}`
                      : ""}
                    {assessment.stale ? " · outdated" : ""}
                  </span>
                </PropertyText>
              </>
            ) : null}
            {card?.pullRequest ? (
              <>
                <PropertyLabel>Pull request</PropertyLabel>
                <PropertyText>
                  <a
                    href={card.pullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    #{card.pullRequest.number}
                  </a>
                </PropertyText>
              </>
            ) : null}
            <PropertyLabel>Started</PropertyLabel>
            <DateProperty date={{ ms: run.createdAt, dateOnly: false }} />
          </PropertyList>

          {assessment || decision ? (
            <RunSection storageKey="workflow-run-review" title="Review">
              {assessment?.summary ? (
                <div className="min-w-0 text-muted-foreground">
                  <Markdown text={assessment.summary} density="compact" />
                </div>
              ) : null}
              <ReviewList
                label="Findings — must be addressed before delivery"
                items={assessment?.findings}
              />
              <ReviewList
                label="Observations — noted, not required"
                items={assessment?.observations}
              />
              {assessment?.truncated ? (
                <p className="text-muted-foreground">
                  Shortened here — the reviewer session has the full review.
                </p>
              ) : null}
              {card?.reviewSet ? (
                <p className="text-muted-foreground">
                  Review threads on the worktree: {card.reviewSet.resolvedCount}{" "}
                  resolved, {card.reviewSet.disputedCount} answered,{" "}
                  {card.reviewSet.openCount} open.
                </p>
              ) : null}
              {decision ? (
                <div className="flex flex-col gap-1">
                  <p>
                    After pass {decision.afterPass}, the run{" "}
                    <span className="font-medium">
                      {decision.decision === "deliver"
                        ? "delivered"
                        : decision.decision === "fix"
                          ? decision.assignee === "implementer"
                            ? "sent the findings back to the implementer"
                            : "took a fix round"
                          : "took another review pass"}
                    </span>
                    {routedRuntime(decision)
                      ? ` on ${routedRuntime(decision)}`
                      : ""}
                    .
                  </p>
                  <div className="min-w-0 text-muted-foreground">
                    <Markdown text={decision.rationale} density="compact" />
                  </div>
                  <ReviewList
                    label={
                      decision.decision === "fix"
                        ? "Focus for the fix round"
                        : "Focus for the next pass"
                    }
                    items={decision.focus}
                  />
                  {decision.truncated ? (
                    <p className="text-muted-foreground">
                      Shortened here — the coordinator session has the full
                      decision.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </RunSection>
          ) : null}

          {plan ? (
            <RunSection storageKey="workflow-run-plan" title="Why this plan">
              <div className="min-w-0 text-muted-foreground">
                <Markdown text={plan.rationale} density="compact" />
              </div>
            </RunSection>
          ) : null}

          {sessionRows.length ? (
            <RunSection
              storageKey="workflow-run-sessions"
              title={`Sessions (${sessionRows.length})`}
            >
              <ul className="-mx-2 flex flex-col">
                {sessionRows.map((row) => (
                  <SessionRow
                    key={row.key}
                    label={row.label}
                    sessionId={row.sessionId}
                    sessions={sessions}
                    onOpenSession={onOpenSession}
                  />
                ))}
              </ul>
            </RunSection>
          ) : null}

          {/* Last, so it sits right above the picker it describes. */}
          {mergeOutcome ? (
            <p className="text-xs text-muted-foreground">{mergeOutcome}</p>
          ) : null}
        </>
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
          <FieldGroup className="mt-3 gap-2">
            {run.worktreeId ? (
              <Field orientation="horizontal">
                <Checkbox
                  id={`${run.id}-delete-worktree`}
                  checked={deleteWorktree}
                  onCheckedChange={setDeleteWorktreeChoice}
                />
                <FieldLabel
                  htmlFor={`${run.id}-delete-worktree`}
                  className="font-normal"
                >
                  Delete the worktree and local branch, discarding unmerged
                  changes.
                </FieldLabel>
              </Field>
            ) : null}
            <Field orientation="horizontal">
              <Checkbox
                id={`${run.id}-archive-sessions`}
                checked={archiveSessions}
                onCheckedChange={setArchiveSessions}
              />
              <FieldLabel
                htmlFor={`${run.id}-archive-sessions`}
                className="font-normal"
              >
                {run.worktreeId
                  ? "Archive the sessions linked to this workflow's worktree."
                  : "Archive the workflow's sessions."}
              </FieldLabel>
            </Field>
          </FieldGroup>
        </ConfirmDialog>
      ) : null}
    </AppCard>
  );
}
