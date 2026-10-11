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
import { useEffect, useState, type ReactNode } from "react";
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
import { ErrorNote, Spinner } from "./common/load.tsx";
import { NoticeList } from "./tools/NoticeList.tsx";
import { LinkButton } from "./common/LinkButton.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppCard, type AppCardTone } from "./common/AppCard.tsx";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";

/**
 * The wire card plus the reducer's browser-local click overlay — one type, so
 * the button's busy state cannot drift from what `useAssistant` writes.
 */
type PullRequestCardData = ClientPullRequestCard;

/** The card's header: its state in words, its tone, and its glyph. */
function pullRequestHeader(card: PullRequestCardData): {
  tone: AppCardTone;
  label: string;
  icon: ReactNode;
} {
  switch (card.status) {
    case "choosing-task":
      return {
        tone: "warning",
        label: "Choose a Task",
        icon: <GitPullRequestArrow />,
      };
    case "creating":
      return {
        tone: "info",
        label: "Opening pull request",
        icon: <Spinner size="sm" />,
      };
    case "failed":
      return {
        tone: "destructive",
        label: "Pull request failed",
        icon: <XCircle />,
      };
    case "merged":
      return { tone: "success", label: "Merged", icon: <GitMerge /> };
    case "closed":
      return {
        tone: "neutral",
        label: "Pull request closed",
        icon: <GitPullRequestClosed />,
      };
    default:
      return {
        tone: "info",
        label: card.reused ? "Pull request reused" : "Pull request open",
        icon: card.reused ? <RotateCcw /> : <GitPullRequestArrow />,
      };
  }
}

function CiBadge({ ci }: { ci: WorktreeCiStatus }) {
  if (ci.state === "pending")
    return (
      <Badge variant="secondary">
        <Spinner size="sm" />
        CI running
      </Badge>
    );
  if (ci.state === "success")
    return (
      <Badge variant="success">
        <CheckCircle2 />
        CI passed
      </Badge>
    );
  return (
    <Badge variant="destructive">
      <XCircle />
      CI failed
    </Badge>
  );
}

function MergeabilityBadge({ card }: { card: PullRequestCardData }) {
  if (card.conflicts)
    return (
      <Badge variant="destructive">
        <AlertTriangle />
        Conflicting
      </Badge>
    );
  // Only a pull request someone might merge is "being checked": a draft's
  // mergeability is unknown because nobody asked for it (Forgejo answers
  // nothing about a WIP pull request), and the draft badge beside this one
  // already says that.
  if (card.mergeable === null && !card.draft)
    return (
      <Badge variant="outline">
        <CircleDot />
        Checking mergeability…
      </Badge>
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
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground">
        Several linked Tasks qualify. Which one does this pull request address?
      </p>
      <div className="flex flex-wrap gap-1.5">
        {candidates.map((task) => (
          <Button
            key={task.id}
            variant="outline"
            size="sm"
            disabled={busy !== null}
            busy={busy === task.id}
            onClick={() => {
              setBusy(task.id);
              onChooseTask?.(card.id, task.id);
            }}
          >
            Task-{task.id}: {task.title}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          busy={busy === "none"}
          onClick={() => {
            setBusy("none");
            onChooseTask?.(card.id, null);
          }}
        >
          None of these
        </Button>
      </div>
    </div>
  );
}

const MERGE_METHOD_LABELS: Record<PullRequestMergeMethod, string> = {
  squash: "Squash",
  merge: "Merge commit",
  rebase: "Rebase",
};

/**
 * The per-merge choices: the method, among those the repository allows, and
 * whether the remote branch goes with it. Shared by every surface that merges a
 * pull request, so a merge looks the same wherever it is offered.
 */
export function MergeMethodPicker({
  offered,
  known,
  selected,
  onSelect,
  deleteBranch,
  onDeleteBranchChange,
  disabled,
}: {
  offered: readonly PullRequestMergeMethod[];
  /** The repository's methods were read (an empty list then means "none"). */
  known: boolean;
  selected: PullRequestMergeMethod | undefined;
  onSelect: (method: PullRequestMergeMethod) => void;
  deleteBranch: boolean;
  onDeleteBranchChange: (value: boolean) => void;
  disabled: boolean;
}) {
  // One compact row: a dropdown rather than a button per method, so the
  // method and the branch choice sit side by side even on a phone.
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {offered.length > 0 ? (
        <Select
          value={selected ?? null}
          disabled={disabled}
          onValueChange={(next: string | null) => {
            const method = offered.find((id) => id === next);
            if (method) onSelect(method);
          }}
        >
          <SelectTrigger size="sm" aria-label="Merge method">
            <span className="truncate">
              {selected ? MERGE_METHOD_LABELS[selected] : "Merge method"}
            </span>
          </SelectTrigger>
          <SelectContent align="start">
            {PULL_REQUEST_MERGE_METHODS.filter((id) =>
              offered.includes(id),
            ).map((id) => (
              <SelectItem key={id} value={id}>
                {MERGE_METHOD_LABELS[id]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="text-muted-foreground">
          {known
            ? "This repository allows no merge method"
            : "Merge methods are not known yet"}
        </span>
      )}
      <Label>
        <Checkbox
          checked={deleteBranch}
          disabled={disabled}
          onCheckedChange={onDeleteBranchChange}
        />
        Delete remote branch
      </Label>
    </div>
  );
}

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
    <Button
      variant={danger ? "destructive" : primary ? "default" : "outline"}
      size="xs"
      title={title}
      disabled={disabled}
      busy={busy}
      onClick={onRun}
    >
      {busy ? null : icon}
      {label}
    </Button>
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
function usePullRequestCardActions({
  card,
  sessionBusy,
  sessionWorktreeId,
  worktreeLiveSiblings,
  onAction: onActionProp,
}: {
  card: PullRequestCardData;
  sessionBusy: boolean;
  sessionWorktreeId?: string | undefined;
  worktreeLiveSiblings: number;
  onAction?:
    | ((
        cardId: string,
        action: PullRequestCardAction,
        options?: PullRequestCardActionOptions,
      ) => void)
    | undefined;
}): { form: ReactNode; buttons: ReactNode; notes: ReactNode } | null {
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
  if (!onActionProp) return null;
  const onAction = onActionProp;
  if ((!open && !merged) || (!hasButton && !hasNote)) return null;

  return {
    form: open ? (
      <MergeMethodPicker
        offered={offeredMethods}
        known={Boolean(supportedMethods)}
        selected={selectedMethod}
        onSelect={setMethod}
        deleteBranch={deleteBranch}
        onDeleteBranchChange={setDeleteBranch}
        disabled={Boolean(running) || conflicted}
      />
    ) : null,
    buttons: (
      <>
        {open && (
          <>
            <ActionButton
              icon={<GitMerge />}
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
            icon={<RefreshCw />}
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
            icon={<Eraser />}
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
            icon={<CheckSquare />}
            label={`Mark Task-${card.linkedTask!.id} done`}
            busy={running === "mark-task-done"}
            disabled={Boolean(running)}
            onRun={() => onAction(card.id, "mark-task-done")}
          />
        )}
      </>
    ),
    notes: (
      <>
        {/* Why merge is off, in text: a `title` tooltip is unreachable on a
          phone and on a disabled button, and the colour alone says nothing. */}
        {conflicted && (
          <Alert variant="warning" role="note">
            <AlertTriangle />
            <AlertDescription>
              {card.headBranch} conflicts with {card.baseBranch}, so it cannot
              be merged.{" "}
              {/* Once the work is with the agent the instruction changes: the
                button that sentence points at is the one now disabled. */}
              {handedOff
                ? "This session's agent was asked to resolve the conflicts and republish the branch; follow it below."
                : local
                  ? "Update with main rebases it and republishes the branch; a conflict git cannot resolve on its own is handed to this session's agent."
                  : `Resolve the conflicts on ${card.headBranch} and push it, then merge.`}
            </AlertDescription>
          </Alert>
        )}
        {/* What the merge will do to the remote branch — stated before the click,
          and only while there is a merge to click: pairing it with "cannot be
          merged" would describe a button that is off. */}
        {open && !conflicted && (
          <p className="text-xs text-muted-foreground">
            {deleteBranch
              ? `Merging deletes the remote branch ${card.headBranch}; the local checkout stays until you clean it up.`
              : `The remote branch ${card.headBranch} is KEPT after the merge; delete it yourself when you are done with it.`}
          </p>
        )}
        {canCleanup && (
          <p className="text-xs text-muted-foreground">
            Cleanup removes this worktree and deletes {card.headBranch} locally
            — only after {card.baseBranch} is confirmed to contain it.
            {siblings > 0 &&
              ` ${siblings === 1 ? "One other live session" : `${siblings} other live sessions`} run${siblings === 1 ? "s" : ""} on this worktree and will be settled too.`}
          </p>
        )}
        {card.cleanedUp && (
          <p className="text-muted-foreground">
            Worktree removed and {card.headBranch} deleted locally.
          </p>
        )}
        {card.actionError && <ErrorNote message={card.actionError} />}
        {card.actionMessage && !card.actionError && (
          <p className="text-muted-foreground">{card.actionMessage}</p>
        )}
      </>
    ),
  };
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

  const header = pullRequestHeader(card);
  const actions = usePullRequestCardActions({
    card,
    sessionBusy,
    sessionWorktreeId,
    worktreeLiveSiblings,
    onAction,
  });
  const hasBadges =
    card.draft || (open && (card.ci || card.review?.changesRequested)) || open;

  return (
    <AppCard
      tone={header.tone}
      icon={header.icon}
      label={header.label}
      status={
        card.provider && card.number !== undefined
          ? `${card.provider} #${card.number}`
          : null
      }
      actions={
        <>
          {card.url ? (
            <LinkButton
              variant="ghost"
              size="xs"
              href={card.url}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink />
              Open
            </LinkButton>
          ) : null}
          {actions?.buttons}
        </>
      }
      contentClassName="gap-3"
    >
      {/* The pull request itself: its title, where it goes, and its checks. */}
      <div className="flex min-w-0 flex-col gap-1">
        <p className="truncate font-medium">{card.title}</p>
        <p className="font-mono text-muted-foreground">
          {card.headBranch} → {card.baseBranch}
        </p>
        {hasBadges ? (
          <div className="flex flex-wrap items-center gap-1">
            {card.draft && <Badge variant="warning">draft</Badge>}
            {open && card.ci && <CiBadge ci={card.ci} />}
            {open && card.review?.changesRequested && (
              <Badge variant="warning">
                <AlertTriangle />
                Changes requested
              </Badge>
            )}
            {open && <MergeabilityBadge card={card} />}
          </div>
        ) : null}
      </div>

      {card.status === "choosing-task" && (
        <TaskChooser card={card} onChooseTask={onChooseTask} />
      )}
      {card.status === "failed" && card.error && (
        <ErrorNote message={card.error} />
      )}
      {card.linkedTask && (
        <p className="text-muted-foreground">
          Linked to{" "}
          <span className="font-medium text-foreground">
            Task-{card.linkedTask.id}: {card.linkedTask.title}
          </span>
        </p>
      )}
      {(card.body?.length ?? 0) > 0 && (
        <div className="border-t pt-2">
          <Markdown text={card.body!.join("\n\n")} />
        </div>
      )}
      <NoticeList title="Warnings" items={card.warnings} />
      {actions?.form}
      {actions?.notes}
    </AppCard>
  );
}
