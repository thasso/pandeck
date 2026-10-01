/**
 * @widget PullRequestCard
 * @purpose Live, durable `/pr` card (Task 323 stage 2): `choosing-task` (a
 *   Task-disambiguation prompt) → `creating` → `open` (CI · review ·
 *   mergeable/conflicting · draft) → `merged` | `closed` | `failed`, plus the
 *   stage-3 ACTIONS on it: merge (method per merge), update with main, the
 *   local cleanup after a merge, and answering the linked Task's suggestion.
 *   Store-driven: injected into snapshot()/re-emitted on attach by the server
 *   and kept current by `pullRequestCardUpdate` broadcasts from
 *   `pullRequestWatcher.ts`, mirroring `ApprovalCard`.
 * @payload `pullRequest` DisplayBlock (`PullRequestCard`, the shared type).
 * @useWhen A `/pr` command opens or reuses a pull request, or the watcher
 *   observes a CI/review/mergeability change.
 */
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CheckSquare,
  CircleDot,
  Eraser,
  ExternalLink,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  RefreshCw,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { PULL_REQUEST_MERGE_METHODS } from "@assistant/shared";
import type {
  PullRequestCardAction,
  PullRequestCardActionOptions,
  PullRequestMergeMethod,
  WorktreeCiStatus,
} from "@assistant/shared";
import type { ClientPullRequestCard } from "../hooks/useAssistant.ts";
import { Markdown } from "./Markdown.tsx";
import { ErrorNote, Spinner } from "./ui/load.tsx";

/**
 * The wire card plus the reducer's browser-local click overlay — one type, so
 * the button's busy state cannot drift from what `useAssistant` writes.
 */
type PullRequestCardData = ClientPullRequestCard;

function HeaderIcon({ status }: { status: PullRequestCardData["status"] }) {
  const cls = "mt-0.5 shrink-0";
  if (status === "merged")
    return <GitMerge size={16} className={`${cls} text-purple-500`} />;
  if (status === "closed" || status === "failed")
    return (
      <GitPullRequestClosed
        size={16}
        className={`${cls} ${status === "failed" ? "text-danger" : "text-warning"}`}
      />
    );
  return <GitPullRequestArrow size={16} className={`${cls} text-success`} />;
}

function StatusBadge({ card }: { card: PullRequestCardData }) {
  const { status } = card;
  if (status === "choosing-task")
    return (
      <span className="rounded-full bg-yellow-500/15 px-2 py-0.5 text-micro font-medium text-yellow-600 dark:text-yellow-400">
        Choose a Task
      </span>
    );
  if (status === "creating")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-micro font-medium text-blue-600 dark:text-blue-400">
        <Spinner size="sm" />
        Creating
      </span>
    );
  if (status === "failed")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-2 py-0.5 text-micro font-medium text-danger">
        <XCircle size={9} />
        Failed
      </span>
    );
  if (status === "merged")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/15 px-2 py-0.5 text-micro font-medium text-purple-600 dark:text-purple-400">
        <GitMerge size={9} />
        Merged
      </span>
    );
  if (status === "closed")
    return (
      <span className="rounded-full bg-surface px-2 py-0.5 text-micro font-medium text-muted">
        Closed
      </span>
    );
  return (
    <span className="rounded-full bg-success/15 px-2 py-0.5 text-micro font-medium text-success">
      Open
    </span>
  );
}

function CiBadge({ ci }: { ci: WorktreeCiStatus }) {
  if (ci.state === "pending")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-micro font-medium text-blue-600 dark:text-blue-400">
        <Spinner size="sm" />
        CI running
      </span>
    );
  if (ci.state === "success")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-micro font-medium text-green-600 dark:text-green-400">
        <CheckCircle2 size={9} />
        CI passed
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-2 py-0.5 text-micro font-medium text-danger">
      <XCircle size={9} />
      CI failed
    </span>
  );
}

function ReviewBadge({ changesRequested }: { changesRequested: boolean }) {
  if (!changesRequested) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-micro font-medium text-fg">
      <AlertTriangle size={9} />
      Changes requested
    </span>
  );
}

function MergeabilityBadge({ card }: { card: PullRequestCardData }) {
  if (card.conflicts)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-2 py-0.5 text-micro font-medium text-danger">
        <AlertTriangle size={9} />
        Conflicting
      </span>
    );
  // Only a pull request someone might merge is "being checked": a draft's
  // mergeability is unknown because nobody asked for it (Forgejo answers
  // nothing about a WIP pull request), and the draft badge beside this one
  // already says that.
  if (card.mergeable === null && !card.draft)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-micro font-medium text-muted">
        <CircleDot size={9} />
        Checking mergeability…
      </span>
    );
  return null;
}

function TaskChooser({
  card,
  onChooseTask,
}: {
  card: PullRequestCardData;
  onChooseTask?: ((cardId: string, taskId: string | null) => void) | undefined;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  // Mirrors ApprovalCard's stuck-spinner guard: a card update that ISN'T the
  // choice taking effect (e.g. the server never received the click, or an
  // unrelated watcher patch arrived first) must not leave every button
  // disabled forever, so a bounded timeout clears it too.
  useEffect(() => {
    if (card.status !== "choosing-task") setBusy(null);
  }, [card.status]);
  useEffect(() => {
    if (!busy) return;
    const timeout = window.setTimeout(() => setBusy(null), 15_000);
    return () => window.clearTimeout(timeout);
  }, [busy]);
  const candidates = card.taskCandidates ?? [];
  return (
    <div className="space-y-2 px-3 py-3">
      <div className="text-caption text-muted">
        Several linked Tasks qualify. Which one does this pull request address?
      </div>
      <div className="flex flex-wrap gap-1.5">
        {candidates.map((task) => (
          <button
            key={task.id}
            type="button"
            disabled={busy !== null}
            aria-busy={busy === task.id || undefined}
            onClick={() => {
              setBusy(task.id);
              onChooseTask?.(card.id, task.id);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 py-1 text-caption text-fg hover:bg-surface disabled:opacity-50"
          >
            {busy === task.id && <Spinner size="sm" />}
            Task-{task.id}: {task.title}
          </button>
        ))}
        <button
          type="button"
          disabled={busy !== null}
          aria-busy={busy === "none" || undefined}
          onClick={() => {
            setBusy("none");
            onChooseTask?.(card.id, null);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 py-1 text-caption text-muted hover:bg-surface disabled:opacity-50"
        >
          {busy === "none" && <Spinner size="sm" />}
          None of these
        </button>
      </div>
    </div>
  );
}

const MERGE_METHOD_LABELS: Record<PullRequestMergeMethod, string> = {
  squash: "Squash",
  merge: "Merge commit",
  rebase: "Rebase",
};

/** One action button; `busy` is the SERVER's running action, not a local guess. */
function ActionButton({
  icon,
  label,
  title,
  busy,
  disabled,
  danger,
  primary,
  onRun,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  busy: boolean;
  disabled: boolean;
  danger?: boolean;
  /** The one next step in this card's state; at most one button carries it. */
  primary?: boolean;
  onRun: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={onRun}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-caption transition-colors disabled:opacity-40 ${
        danger
          ? "border-danger/40 bg-raised text-danger hover:bg-danger/10"
          : primary
            ? "border-accent bg-accent font-medium text-white hover:bg-accent/90"
            : "border-line bg-raised text-fg hover:bg-surface"
      }`}
    >
      <span className="flex size-3.5 items-center justify-center">
        {busy ? <Spinner size="sm" /> : icon}
      </span>
      {label}
    </button>
  );
}

/**
 * The actions on a live card. What is OFFERED follows the card's own state —
 * merge only while open, cleanup only once merged and only for a session that
 * has a worktree — and each button says its consequence rather than relying on
 * a confirmation the user would learn to click through.
 *
 * The worktree is resolved exactly as the server's `requireWorktree` does, the
 * card's own id FIRST and the session's as the fallback: a card minted without
 * one (an older server, a session linked to its checkout afterwards) would
 * otherwise hide a button the server runs perfectly well.
 *
 * A CONFLICTING pull request is the one state where the hierarchy changes:
 * merging is impossible until the branch is updated, so merge is disabled and
 * the update becomes the primary button. Only `conflicts` does this, and it is
 * the server's CONFIRMED conflict — an unanswered `mergeable` (null, or a
 * single `false` no second read has reproduced) is not it, and pre-judging that
 * would take away a merge the provider would have accepted.
 */
function CardActions({
  card,
  sessionBusy,
  sessionWorktreeId,
  worktreeLiveSiblings,
  onAction,
}: {
  card: PullRequestCardData;
  sessionBusy: boolean;
  sessionWorktreeId?: string | undefined;
  worktreeLiveSiblings: number;
  onAction: (
    cardId: string,
    action: PullRequestCardAction,
    options?: PullRequestCardActionOptions,
  ) => void;
}) {
  // Only what the repository CURRENTLY allows may be offered. Unknown
  // capabilities offer nothing rather than a method the backend would refuse,
  // and a set that changes under a pending choice invalidates it below.
  const supportedMethods = card.repositoryCapabilities?.mergeMethods;
  const [method, setMethod] = useState<PullRequestMergeMethod | undefined>(
    undefined,
  );
  // Deleting the remote branch is the DEFAULT and the opt-out is per merge, so
  // it is local click state — never remembered on the card, which would carry
  // one merge's decision into the next one.
  const [deleteBranch, setDeleteBranch] = useState(true);
  const offeredMethods = supportedMethods ?? [];
  const selectedMethod =
    method && offeredMethods.includes(method)
      ? method
      : card.repositoryCapabilities?.defaultMergeMethod &&
          offeredMethods.includes(
            card.repositoryCapabilities.defaultMergeMethod,
          )
        ? card.repositoryCapabilities.defaultMergeMethod
        : offeredMethods[0];
  const running = card.busyAction ?? card.pendingAction;
  const open = card.status === "open";
  const merged = card.status === "merged";
  const worktreeId = card.worktreeId ?? sessionWorktreeId;
  const local = Boolean(worktreeId);
  // The count is the VIEWED session's; it says nothing about a card that names
  // a different checkout.
  const siblings =
    worktreeId && worktreeId === sessionWorktreeId ? worktreeLiveSiblings : 0;
  const settles =
    siblings > 0
      ? `settle this session and ${siblings} other${siblings === 1 ? "" : "s"} on this worktree`
      : "settle this session";
  const taskOpen = card.linkedTask && card.linkedTask.status !== "done";
  const canCleanup = merged && local && !card.cleanedUp;
  const conflicted = open && card.conflicts === true;
  // The click already became a PROMPT in this session: the rebase is the
  // agent's turn now, and a second click would start another one on the branch
  // it is holding. Paired with the session actually running, so an agent that
  // gave up (or a card whose flag outlived its turn) hands the button back
  // instead of leaving the user with nothing to press.
  const handedOff = open && card.rebaseHandedOff === true && sessionBusy;
  // Nothing to offer and nothing to say — a merged card whose worktree is gone
  // and whose Task is answered — renders no section at all, rather than an
  // empty bordered box under the header.
  const hasButton = open || canCleanup || (merged && taskOpen);
  const hasNote =
    Boolean(card.actionError) || Boolean(card.actionMessage) || card.cleanedUp;
  if ((!open && !merged) || (!hasButton && !hasNote)) return null;

  return (
    <div className="space-y-2 border-t border-line/60 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {open && (
          <>
            {offeredMethods.length > 0 ? (
              <div className="inline-flex overflow-hidden rounded-lg border border-line">
                {PULL_REQUEST_MERGE_METHODS.filter((id) =>
                  offeredMethods.includes(id),
                ).map((id) => (
                  <button
                    key={id}
                    type="button"
                    disabled={Boolean(running) || conflicted}
                    onClick={() => setMethod(id)}
                    className={`px-2 py-1 text-caption transition-colors disabled:opacity-40 ${
                      selectedMethod === id
                        ? "bg-accent text-white"
                        : "bg-raised text-muted hover:bg-surface"
                    }`}
                  >
                    {MERGE_METHOD_LABELS[id]}
                  </button>
                ))}
              </div>
            ) : (
              <span className="text-caption text-faint">
                {supportedMethods
                  ? "This repository allows no merge method"
                  : "Merge methods are not known yet"}
              </span>
            )}
            <label
              className={`inline-flex items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 py-1 text-caption text-muted ${
                running || conflicted
                  ? "opacity-40"
                  : "cursor-pointer hover:bg-surface"
              }`}
            >
              <input
                type="checkbox"
                className="size-3.5 accent-accent"
                checked={deleteBranch}
                disabled={Boolean(running) || conflicted}
                onChange={(event) => setDeleteBranch(event.target.checked)}
              />
              Delete remote branch
            </label>
            <ActionButton
              icon={<GitMerge size={12} />}
              label="Merge"
              title={
                conflicted
                  ? `${card.headBranch} conflicts with ${card.baseBranch}: update it before merging`
                  : selectedMethod
                    ? `Merge #${card.number ?? ""} with ${MERGE_METHOD_LABELS[selectedMethod].toLowerCase()} and ${deleteBranch ? "delete" : "keep"} the remote branch ${card.headBranch}`
                    : "The merge methods this repository allows are not known yet"
              }
              busy={running === "merge"}
              disabled={Boolean(running) || conflicted || !selectedMethod}
              onRun={() =>
                selectedMethod &&
                onAction(card.id, "merge", {
                  mergeMethod: selectedMethod,
                  deleteBranch,
                })
              }
            />
          </>
        )}
        {open && local && (
          <ActionButton
            icon={<RefreshCw size={12} />}
            label={handedOff ? "Agent is rebasing" : "Update with main"}
            title={
              handedOff
                ? `The rebase conflicted and was handed to this session's agent; it is working on ${card.headBranch} now.`
                : `Rebase ${card.headBranch} onto an up-to-date ${card.baseBranch} and force-push it with lease`
            }
            busy={running === "update-with-main" || handedOff}
            disabled={Boolean(running) || handedOff}
            primary={conflicted && !handedOff}
            onRun={() => onAction(card.id, "update-with-main")}
          />
        )}
        {canCleanup && (
          <ActionButton
            danger
            icon={<Eraser size={12} />}
            label="Clean up worktree"
            title={
              sessionBusy
                ? "This session is still running."
                : `Pull ${card.baseBranch}, verify it contains ${card.headBranch}, then remove the worktree, delete the branch and ${settles}`
            }
            busy={running === "cleanup"}
            disabled={Boolean(running) || sessionBusy}
            onRun={() => onAction(card.id, "cleanup")}
          />
        )}
        {merged && taskOpen && (
          <ActionButton
            icon={<CheckSquare size={12} />}
            label={`Mark Task-${card.linkedTask!.id} done`}
            busy={running === "mark-task-done"}
            disabled={Boolean(running)}
            onRun={() => onAction(card.id, "mark-task-done")}
          />
        )}
      </div>
      {/* Why merge is off, in text: a `title` tooltip is unreachable on a
          phone and on a disabled button, and the colour alone says nothing. */}
      {conflicted && (
        <p className="flex items-start gap-1.5 text-caption text-fg">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
          <span>
            {card.headBranch} conflicts with {card.baseBranch}, so it cannot be
            merged.{" "}
            {/* Once the work is with the agent the instruction changes: the
                button that sentence points at is the one now disabled. */}
            {handedOff
              ? "This session's agent was asked to resolve the conflicts and republish the branch; follow it below."
              : local
                ? "Update with main rebases it and republishes the branch; a conflict git cannot resolve on its own is handed to this session's agent."
                : `Resolve the conflicts on ${card.headBranch} and push it, then merge.`}
          </span>
        </p>
      )}
      {/* What the merge will do to the remote branch — stated before the click,
          and only while there is a merge to click: pairing it with "cannot be
          merged" would describe a button that is off. */}
      {open && !conflicted && (
        <p className="text-micro text-faint">
          {deleteBranch
            ? `Merging deletes the remote branch ${card.headBranch}; the local checkout stays until you clean it up.`
            : `The remote branch ${card.headBranch} is KEPT after the merge; delete it yourself when you are done with it.`}
        </p>
      )}
      {canCleanup && (
        <p className="text-micro text-faint">
          Cleanup removes this worktree and deletes {card.headBranch} locally —
          only after {card.baseBranch} is confirmed to contain it.
          {siblings > 0 &&
            ` ${siblings === 1 ? "One other live session" : `${siblings} other live sessions`} run${siblings === 1 ? "s" : ""} on this worktree and will be settled too.`}
        </p>
      )}
      {card.cleanedUp && (
        <p className="text-caption text-muted">
          Worktree removed and {card.headBranch} deleted locally.
        </p>
      )}
      {card.actionError && <ErrorNote message={card.actionError} />}
      {card.actionMessage && !card.actionError && (
        <p className="text-caption text-muted">{card.actionMessage}</p>
      )}
    </div>
  );
}

export function PullRequestCard({
  pullRequest,
  sessionBusy = false,
  sessionWorktreeId,
  worktreeLiveSiblings = 0,
  onChooseTask,
  onAction,
}: {
  pullRequest: PullRequestCardData;
  /** The card's session is running: cleanup would pull the ground from under it. */
  sessionBusy?: boolean | undefined;
  /** The viewed session's worktree — the fallback when the card stored none. */
  sessionWorktreeId?: string | undefined;
  /** Other live sessions on that worktree; cleanup settles them too. */
  worktreeLiveSiblings?: number | undefined;
  onChooseTask?: ((cardId: string, taskId: string | null) => void) | undefined;
  onAction?:
    | ((
        cardId: string,
        action: PullRequestCardAction,
        options?: PullRequestCardActionOptions,
      ) => void)
    | undefined;
}) {
  // Keep the wire card authoritative underneath the click overlay. A refusal
  // drops only the overlay, so the linked-Task action returns immediately
  // without restoring a stored inverse over a concurrent Task write.
  const card = pullRequest.optimisticLinkedTask
    ? { ...pullRequest, linkedTask: pullRequest.optimisticLinkedTask }
    : pullRequest;
  const open = card.status === "open";
  const tone =
    card.status === "failed"
      ? "border-danger/30 bg-danger/5"
      : open
        ? "border-success/30 bg-success-soft"
        : card.status === "merged"
          ? "border-purple-500/30 bg-purple-500/5"
          : "border-warning/35 bg-warning-soft";

  return (
    <div className={`my-1.5 overflow-hidden rounded-xl border ${tone}`}>
      <div className="flex items-start gap-3 border-b border-line/60 px-3 py-3">
        <HeaderIcon status={card.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div className="text-body font-semibold text-fg">
              {card.reused ? "Pull request reused" : "Pull request"}
            </div>
            {card.provider && card.number !== undefined && (
              <span className="text-caption text-faint">
                {card.provider} #{card.number}
              </span>
            )}
            <StatusBadge card={card} />
            {card.draft && (
              <span className="rounded-full bg-warning-soft px-2 py-0.5 text-micro text-fg">
                draft
              </span>
            )}
            {open && card.ci && <CiBadge ci={card.ci} />}
            {open && card.review && (
              <ReviewBadge changesRequested={card.review.changesRequested} />
            )}
            {open && <MergeabilityBadge card={card} />}
            {card.reused && <RotateCcw size={13} className="text-faint" />}
          </div>
          <div className="mt-1 truncate text-body text-fg">{card.title}</div>
          <div className="mt-1 font-mono text-caption text-faint">
            {card.headBranch} → {card.baseBranch}
          </div>
        </div>
        {card.url && (
          <a
            href={card.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-white transition-colors hover:bg-accent/90"
          >
            Open
            <ExternalLink size={12} />
          </a>
        )}
      </div>

      {card.status === "choosing-task" && (
        <TaskChooser card={card} onChooseTask={onChooseTask} />
      )}

      {onAction && (
        <CardActions
          card={card}
          sessionBusy={sessionBusy}
          sessionWorktreeId={sessionWorktreeId}
          worktreeLiveSiblings={worktreeLiveSiblings}
          onAction={onAction}
        />
      )}

      {card.status === "failed" && card.error && (
        <div className="px-3 py-3">
          <ErrorNote message={card.error} />
        </div>
      )}

      {((card.body?.length ?? 0) > 0 ||
        card.warnings.length > 0 ||
        card.linkedTask) && (
        <div className="space-y-3 px-3 py-3">
          {card.linkedTask && (
            <div className="text-caption text-muted">
              Linked to{" "}
              <span className="font-medium text-fg">
                Task-{card.linkedTask.id}: {card.linkedTask.title}
              </span>
            </div>
          )}

          {(card.body?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-line bg-panel/50 p-2 text-body text-fg">
              <Markdown text={card.body!.join("\n\n")} />
            </div>
          )}

          {card.warnings.length > 0 && (
            <div className="rounded-lg border border-warning/35 bg-warning-soft px-2.5 py-2 text-caption text-fg">
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                <AlertTriangle size={13} className="text-warning" />
                Warnings
              </div>
              <ul className="list-disc space-y-1 pl-5 marker:text-warning">
                {card.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
