/**
 * Worktree dialogs: create, manual/agent-generated commit outcomes, confirmed
 * HEAD-scoped clean, PR creation, PR merge, local merge back, and guarded
 * removal.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, GitMerge, RefreshCw } from "lucide-react";
import { PULL_REQUEST_MERGE_METHODS } from "@assistant/shared";
import type {
  CommitDisplay,
  PullRequestMergeMethod,
  WorktreeGitStatus,
  WorktreeMergePhase,
  WorktreeMergeStrategy,
  WorktreeRecord,
} from "@assistant/shared";
import { ErrorNote, Spinner } from "../common/load.tsx";
import {
  ConfirmDialog,
  DialogAction,
  DialogCancelButton,
  DialogHeader,
  DialogOverlay as Overlay,
} from "../common/dialogs.tsx";

/* ---------------------------------- create --------------------------------- */

export function CreateWorktreeDialog({
  projectName,
  proposal,
  onPropose,
  onCreate,
  onClose,
}: {
  projectName: string;
  /** Latest naming-agent proposal for OUR request, or null while pending. */
  proposal: string | null;
  onPropose: () => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const edited = useRef(false);
  // The proposal fills the field until the user edits it manually.
  useEffect(() => {
    if (proposal && !edited.current) setName(proposal);
  }, [proposal]);

  return (
    <Overlay onClose={onClose}>
      <DialogHeader
        title={`New worktree in ${projectName}`}
        onClose={onClose}
      />
      <p className="text-caption text-faint">
        The name becomes the branch and the folder suffix. A naming agent
        proposes one; edit freely.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          autoFocus
          value={name}
          onChange={(event) => {
            edited.current = true;
            setName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && name.trim()) onCreate(name.trim());
          }}
          placeholder={
            proposal === null ? "Proposing a name…" : "worktree-name"
          }
          className="w-full flex-1 rounded-lg border border-line bg-surface px-3 py-2 font-mono text-body text-fg outline-none focus:border-primary"
        />
        {/* Deliberately NOT a busy control, unlike `DialogAction` below: the
            spinner reports the naming AGENT's outstanding proposal, and this
            button is the way to ask again when that agent never answers, so
            disabling it would strand the dialog on a request that will not
            arrive. It therefore carries no `aria-busy` either — the pending
            state is announced by the input's "Proposing a name…" placeholder,
            and a button that says "busy" while it is the retry would be a lie.
            One 14px slot for both glyphs so it does not resize. */}
        <button
          type="button"
          title="Propose another name"
          onClick={() => {
            edited.current = false;
            onPropose();
          }}
          className="rounded-lg border border-line p-2 text-muted-foreground hover:bg-raised hover:text-fg"
        >
          <span className="flex size-3.5 items-center justify-center">
            {proposal === null ? (
              <Spinner size="sm" />
            ) : (
              <RefreshCw size={14} />
            )}
          </span>
        </button>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <DialogCancelButton onClick={onClose} />
        <DialogAction
          disabled={!name.trim()}
          onClick={() => onCreate(name.trim())}
        >
          Create worktree
        </DialogAction>
      </div>
    </Overlay>
  );
}

/* ---------------------------------- commit ---------------------------------- */

export function CommitWorktreeDialog({
  status,
  busy,
  error,
  onCommit,
  onClose,
  scopeLabel = "this worktree",
}: {
  status?: WorktreeGitStatus;
  busy: boolean;
  error: string | null;
  onCommit: (message: string) => void;
  onClose: () => void;
  /** What is being committed, as the sentence names it. */
  scopeLabel?: string;
}) {
  const [message, setMessage] = useState("");
  const fileCount = (status?.filesChanged ?? 0) + (status?.untracked ?? 0);
  const canCommit = Boolean(message.trim()) && !busy;

  return (
    <Overlay onClose={busy ? () => undefined : onClose}>
      <DialogHeader title="Commit changes" onClose={onClose} />
      <p className="text-caption text-faint">
        Commits{" "}
        {fileCount > 0
          ? `all ${fileCount} changed file${fileCount === 1 ? "" : "s"}`
          : "everything changed"}{" "}
        in {scopeLabel} with your git identity.
      </p>
      <textarea
        autoFocus
        rows={3}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            canCommit
          )
            onCommit(message.trim());
        }}
        placeholder="Commit message"
        className="mt-3 w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-body text-fg outline-none focus:border-primary"
      />
      {error ? <ErrorNote message={error} className="mt-2" /> : null}
      <div className="mt-3 flex justify-end gap-2">
        <DialogCancelButton disabled={busy} onClick={onClose} />
        <DialogAction
          busy={busy}
          disabled={!canCommit}
          onClick={() => onCommit(message.trim())}
        >
          Commit
        </DialogAction>
      </div>
    </Overlay>
  );
}

export function AutoCommitResultDialog({
  result,
  busy,
  onForce,
  onClose,
}: {
  result: CommitDisplay;
  busy: boolean;
  onForce: () => void;
  onClose: () => void;
}) {
  return (
    <Overlay onClose={busy ? () => undefined : onClose}>
      <DialogHeader
        title={
          result.status === "blocked"
            ? "Auto commit blocked"
            : "Auto commit failed"
        }
        onClose={onClose}
      />
      {result.commitMessage ? (
        <div className="mt-2 rounded-lg border border-line bg-surface px-3 py-2">
          <p className="mb-1 text-micro font-semibold uppercase tracking-wide text-faint">
            Generated message
          </p>
          <pre className="whitespace-pre-wrap font-sans text-caption text-fg">
            {result.commitMessage}
          </pre>
        </div>
      ) : null}
      {result.blockers.length ? (
        <div className="mt-3">
          <p className="text-caption font-semibold text-danger">Blockers</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-caption text-muted-foreground">
            {result.blockers.map((blocker, index) => (
              <li key={`${blocker.kind}:${index}`}>
                {blocker.file ? `${blocker.file}: ` : ""}
                {blocker.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.warnings.length ? (
        <div className="mt-3">
          <p className="text-caption font-semibold text-amber-400">Warnings</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-caption text-muted-foreground">
            {result.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.error ? (
        <ErrorNote message={result.error} className="mt-3" />
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <DialogCancelButton disabled={busy} onClick={onClose}>
          Close
        </DialogCancelButton>
        {result.status === "blocked" ? (
          <DialogAction danger busy={busy} onClick={onForce}>
            Commit anyway
          </DialogAction>
        ) : null}
      </div>
    </Overlay>
  );
}

export function CleanWorktreeDialog({
  status,
  busy,
  error,
  onClean,
  onClose,
}: {
  status: WorktreeGitStatus;
  busy: boolean;
  error: string | null;
  onClean: () => void;
  onClose: () => void;
}) {
  const fileCount = status.filesChanged + status.untracked;
  return (
    <ConfirmDialog
      title="Clean worktree"
      danger
      confirmLabel="Clean"
      busy={busy}
      error={error}
      onConfirm={onClean}
      onCancel={onClose}
      body={
        <>
          Permanently discard uncommitted changes in {fileCount} file
          {fileCount === 1 ? "" : "s"}. Tracked files reset to{" "}
          <span className="font-mono text-fg">HEAD</span> and ordinary untracked
          files are removed. Commits and ignored files are preserved.
        </>
      }
    />
  );
}

/* --------------------------------- create PR -------------------------------- */

export function CreatePullRequestDialog({
  worktree,
  busy,
  error,
  onCreate,
  onClose,
}: {
  worktree: WorktreeRecord;
  busy: boolean;
  error: string | null;
  onCreate: (title: string, body: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(worktree.branch);
  const [body, setBody] = useState("");
  const canCreate = Boolean(title.trim()) && !busy;

  return (
    <Overlay onClose={busy ? () => undefined : onClose}>
      <DialogHeader title="Create pull request" onClose={onClose} />
      <p className="text-caption text-faint">
        <span className="font-mono">{worktree.branch}</span> →{" "}
        <span className="font-mono">{worktree.baseBranch}</span>. Push your
        commits first — the PR is created from the remote branch.
      </p>
      <input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Title"
        className="mt-3 w-full rounded-lg border border-line bg-surface px-3 py-2 text-body text-fg outline-none focus:border-primary"
      />
      <textarea
        rows={4}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Description (optional)"
        className="mt-2 w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-body text-fg outline-none focus:border-primary"
      />
      {error ? <ErrorNote message={error} className="mt-2" /> : null}
      <div className="mt-3 flex justify-end gap-2">
        <DialogCancelButton disabled={busy} onClick={onClose} />
        <DialogAction
          busy={busy}
          disabled={!canCreate}
          onClick={() => onCreate(title.trim(), body.trim())}
        >
          Create PR
        </DialogAction>
      </div>
    </Overlay>
  );
}

/* -------------------------------- merge PR --------------------------------- */

const MERGE_METHOD_LABELS: Record<PullRequestMergeMethod, string> = {
  squash: "Squash — one commit on the base branch",
  merge: "Merge commit — keep individual commits",
  rebase: "Rebase — replay the commits onto the base",
};

/**
 * Merge the branch's PULL REQUEST on the hosting provider — not the local
 * `MergeWorktreeDialog` below, which merges the branch in your checkout. The
 * method is picked here, per merge, and the remote branch goes with it; the
 * provider's own refusal (branch protection, required checks) comes back as the
 * error, so nothing is pre-judged here.
 */
export function MergePullRequestDialog({
  worktree,
  prNumber,
  supportedMethods,
  defaultMethod,
  busy,
  error,
  onMerge,
  onClose,
}: {
  worktree: WorktreeRecord;
  prNumber: number;
  /**
   * Merge methods the repository currently allows. `undefined` means the
   * provider could not be asked: nothing is offered rather than a method the
   * backend would refuse.
   */
  supportedMethods?: readonly PullRequestMergeMethod[] | undefined;
  defaultMethod?: PullRequestMergeMethod | undefined;
  busy: boolean;
  error: string | null;
  onMerge: (options: {
    method: PullRequestMergeMethod;
    deleteBranch: boolean;
  }) => void;
  onClose: () => void;
}) {
  const offered = PULL_REQUEST_MERGE_METHODS.filter((id) =>
    supportedMethods?.includes(id),
  );
  const [method, setMethod] = useState<PullRequestMergeMethod | undefined>(
    undefined,
  );
  // A capability change while the dialog is open invalidates a stale choice
  // rather than sending it.
  const selected =
    method && offered.includes(method)
      ? method
      : defaultMethod && offered.includes(defaultMethod)
        ? defaultMethod
        : offered[0];
  // Deleting the remote branch is the default; the checkbox below is the
  // per-merge opt-out, and the sentence above the buttons says which of the two
  // this click will do.
  const [deleteBranch, setDeleteBranch] = useState(true);
  return (
    <Overlay onClose={busy ? () => undefined : onClose}>
      <DialogHeader
        title={`Merge pull request #${prNumber}`}
        onClose={onClose}
      />
      <p className="text-caption text-faint">
        <span className="font-mono">{worktree.branch}</span> →{" "}
        <span className="font-mono">{worktree.baseBranch}</span>.{" "}
        {deleteBranch
          ? "The remote branch is deleted with the merge"
          : "The remote branch is kept"}
        ; this worktree stays until you clean it up.
      </p>
      <div className="mt-3 flex flex-col gap-1">
        {offered.length === 0 ? (
          <p className="text-caption text-faint">
            {supportedMethods
              ? "This repository allows no merge method for pull requests."
              : "The merge methods this repository allows could not be read; nothing can be chosen."}
          </p>
        ) : null}
        {offered.map((id) => (
          <label
            key={id}
            className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-caption ${selected === id ? "border-primary bg-accent text-fg" : "border-line text-muted-foreground hover:bg-raised"}`}
          >
            <input
              type="radio"
              name="pr-merge-method"
              checked={selected === id}
              onChange={() => setMethod(id)}
            />
            {MERGE_METHOD_LABELS[id]}
          </label>
        ))}
      </div>
      <label className="mt-2 flex cursor-pointer items-center gap-2 text-caption text-fg">
        <input
          type="checkbox"
          checked={deleteBranch}
          disabled={busy}
          onChange={(event) => setDeleteBranch(event.target.checked)}
        />
        Delete the remote branch{" "}
        <span className="font-mono text-caption">{worktree.branch}</span>
      </label>
      {error ? <ErrorNote message={error} className="mt-2" /> : null}
      <div className="mt-3 flex justify-end gap-2">
        <DialogCancelButton disabled={busy} onClick={onClose} />
        <DialogAction
          busy={busy}
          disabled={!selected}
          icon={<GitMerge size={13} />}
          onClick={() =>
            selected && onMerge({ method: selected, deleteBranch })
          }
        >
          Merge pull request
        </DialogAction>
      </div>
    </Overlay>
  );
}

/* ---------------------------------- merge ---------------------------------- */

const STRATEGY_LABELS: Record<WorktreeMergeStrategy, string> = {
  squash: "Squash — one commit on the base branch",
  merge: "Merge commit — keep individual commits",
  rebase: "Rebase + fast-forward — linear history",
};

const PHASE_LABELS: Record<WorktreeMergePhase, string> = {
  idle: "",
  merging: "Merging…",
  conflicts: "Conflicts need resolution",
  agent_resolving: "Merge agent is resolving conflicts…",
  done: "Merged.",
  failed: "Merge failed.",
};

export function MergeWorktreeDialog({
  worktree,
  status,
  defaultStrategy,
  merge,
  onMerge,
  onOpenSession,
  onClose,
}: {
  worktree: WorktreeRecord;
  status?: WorktreeGitStatus | undefined;
  defaultStrategy: WorktreeMergeStrategy;
  /** Live merge progress from state (survives closing the dialog). */
  merge?:
    | {
        phase: WorktreeMergePhase;
        message?: string;
        conflictPaths?: string[];
        agentSessionId?: string;
      }
    | undefined;
  onMerge: (strategy: WorktreeMergeStrategy) => void;
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
}) {
  const [strategy, setStrategy] =
    useState<WorktreeMergeStrategy>(defaultStrategy);
  const phase = merge?.phase ?? "idle";
  const busy = phase === "merging" || phase === "agent_resolving";

  const warnings = useMemo(() => {
    const list: string[] = [];
    if (status?.dirty)
      list.push("The worktree has uncommitted changes — commit them first.");
    if (status && status.ahead === 0)
      list.push(
        "Nothing to merge: the branch has no commits ahead of its base.",
      );
    if (status && status.behind > 0)
      list.push(
        `The base branch moved on (${status.behind} commit${status.behind === 1 ? "" : "s"}); conflicts are possible.`,
      );
    return list;
  }, [status]);

  return (
    <Overlay onClose={onClose}>
      <DialogHeader
        title={`Merge ${worktree.branch} into ${worktree.baseBranch}`}
        onClose={onClose}
      />
      {phase === "idle" || phase === "failed" ? (
        <>
          {warnings.map((warning) => (
            <p
              key={warning}
              className="mb-1.5 flex items-start gap-1.5 text-caption text-amber-500"
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {warning}
            </p>
          ))}
          {phase === "failed" && merge?.message ? (
            <ErrorNote message={merge.message} className="mb-2" />
          ) : null}
          <div className="mt-1 flex flex-col gap-1">
            {(Object.keys(STRATEGY_LABELS) as WorktreeMergeStrategy[]).map(
              (id) => (
                <label
                  key={id}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-caption ${strategy === id ? "border-primary bg-accent text-fg" : "border-line text-muted-foreground hover:bg-raised"}`}
                >
                  <input
                    type="radio"
                    name="merge-strategy"
                    checked={strategy === id}
                    onChange={() => setStrategy(id)}
                  />
                  {STRATEGY_LABELS[id]}
                </label>
              ),
            )}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <DialogCancelButton onClick={onClose} />
            <DialogAction
              disabled={Boolean(status?.dirty)}
              icon={<GitMerge size={13} />}
              onClick={() => onMerge(strategy)}
            >
              Merge
            </DialogAction>
          </div>
        </>
      ) : (
        <div className="mt-1">
          {/* The merge runs on the server and survives this dialog, so the
              progress line is a status region, not a busy control. */}
          <p
            role="status"
            className="flex items-center gap-2 text-caption text-fg"
          >
            {busy ? <Spinner size="sm" className="text-primary" /> : null}
            {PHASE_LABELS[phase]}
          </p>
          {merge?.message ? (
            <p className="mt-1 text-caption text-muted-foreground">
              {merge.message}
            </p>
          ) : null}
          {merge?.conflictPaths?.length ? (
            <ul className="mt-2 max-h-24 overflow-y-auto rounded-lg border border-line p-2 font-mono text-caption text-muted-foreground">
              {merge.conflictPaths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          ) : null}
          {merge?.agentSessionId &&
          (phase === "agent_resolving" || phase === "conflicts") ? (
            <button
              type="button"
              onClick={() => onOpenSession(merge.agentSessionId!)}
              className="mt-2 text-caption text-primary hover:underline"
            >
              Open the merge agent's session →
            </button>
          ) : null}
          <div className="mt-3 flex justify-end">
            <DialogCancelButton onClick={onClose}>
              {phase === "done" ? "Close" : "Hide (keeps running)"}
            </DialogCancelButton>
          </div>
        </div>
      )}
    </Overlay>
  );
}

/* ---------------------------------- remove --------------------------------- */

export function RemoveWorktreeDialog({
  worktree,
  status,
  onRemove,
  onClose,
  retire,
  busy = false,
  error,
}: {
  worktree: WorktreeRecord;
  status?: WorktreeGitStatus | undefined;
  onRemove: (options: { deleteBranch: boolean; force: boolean }) => void;
  onClose: () => void;
  /**
   * The full retire flow, rather than inspector-only removal.
   *
   * `refusal` is what the LAST retirement of this worktree refused with, and
   * only when `force` can answer it. Retirement verifies delivery by fetching
   * the base and comparing against that exact commit — a check no local status
   * can stand in for — so this refusal is the only thing that establishes the
   * verification failed, and therefore the only thing consent may escalate
   * from. A session gate is never carried here: force does not override those.
   */
  retire?: {
    /**
     * How many linked sessions this will settle. OMITTED when the browser's
     * session list is not authoritative for the current socket episode — a
     * count off a stale list is a NUMBER IN CONSENT TEXT that the run then
     * contradicts ("settles 0 sessions" while the server settles four), so the
     * sentence goes generic instead of guessing.
     */
    sessionCount?: number | undefined;
    merged: boolean;
    refusal?: string;
  };
  /** The retirement is running; this dialog owns its busy state (R5). */
  busy?: boolean;
  /**
   * What the last attempt from THIS dialog answered with — a refusal or a
   * transport failure. It belongs here rather than in a toast: the object is
   * still on screen and this is the control that retries it
   * (`docs/messaging.md`).
   */
  error?: string | undefined;
}) {
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [confirmForce, setConfirmForce] = useState(false);
  const losesDirty = Boolean(status?.dirty);
  // Commits are only at stake when the branch goes with the checkout: keeping it
  // keeps them, which is what the server's containment guard now says too.
  //
  // A just-merged/squash-merged PR can still look ahead of the stale local base
  // until Retire refreshes the exact merge target. Do not demand force there:
  // that would skip the containment verification this flow exists to perform.
  const losesUnmerged = Boolean(
    deleteBranch &&
    status &&
    !status.merged &&
    status.ahead > 0 &&
    !retire?.merged,
  );
  // A base branch that resolves to no local commit answers containment neither
  // way, and the counts above are only zero because nothing could be compared —
  // so the decision has to be offered rather than hidden behind them. On THIS
  // surface: Remove never fetches, so the missing local ref is its final answer
  // and its containment guard will refuse without consent.
  //
  // Retire is the opposite case. Its answer comes from fetching the base and
  // comparing against that exact commit, and no local ref can pre-empt it —
  // absent locally does not mean absent from the remote, so forcing on that
  // guess would skip a verification that was about to succeed. There, consent
  // is only ever the answer to the refusal that verification actually produced.
  const unverifiable = Boolean(
    deleteBranch &&
    (retire ? retire.refusal !== undefined : status?.baseUnresolved),
  );
  const losesWork = losesDirty || losesUnmerged;
  const lostWork = [
    ...(losesDirty ? ["uncommitted changes"] : []),
    ...(losesUnmerged ? ["unmerged commits"] : []),
  ].join(" and ");
  const lostWorkSentence = `${lostWork.charAt(0).toUpperCase()}${lostWork.slice(1)}`;
  const needsForce = losesWork || unverifiable;
  // One force covers every risk stated below, so the consent names all of them.
  const consent = [
    ...(losesWork ? ["discard this work"] : []),
    ...(unverifiable
      ? [retire ? "retire anyway" : "delete the branch unverified"]
      : []),
  ].join(" and ");

  return (
    <ConfirmDialog
      title={`${retire ? "Retire" : "Remove"} worktree ${worktree.branch}`}
      confirmLabel={retire ? "Retire worktree" : "Remove worktree"}
      danger
      // The body describes what removal does; the block below is the only alarm,
      // and only when this actually loses work.
      bodyTone="plain"
      busy={busy}
      {...(error !== undefined ? { error } : {})}
      confirmDisabled={needsForce && !confirmForce}
      onConfirm={() => onRemove({ deleteBranch, force: needsForce })}
      onCancel={onClose}
      body={
        retire ? (
          <>
            Refreshes the merge target for{" "}
            <span className="font-mono">{worktree.baseBranch}</span>, verifies
            this branch is delivered, then removes the folder{" "}
            <span className="font-mono">{worktree.path}</span>. It settles{" "}
            {retire.sessionCount === undefined ? (
              <>the sessions working here</>
            ) : (
              <>
                {retire.sessionCount}{" "}
                {retire.sessionCount === 1 ? "session" : "sessions"}
              </>
            )}{" "}
            out of the inbox; one that is running, or waiting on an answer or
            approval, refuses retirement instead.
          </>
        ) : (
          <>
            Removes the folder{" "}
            <span className="font-mono text-caption">{worktree.path}</span>. The
            sessions still working here are settled out of the inbox with it;
            one that is running, or waiting on an answer or approval, refuses
            the removal instead.
          </>
        )
      }
    >
      <label className="mt-2 flex cursor-pointer items-center gap-2 text-caption text-fg">
        <input
          type="checkbox"
          checked={deleteBranch}
          onChange={(event) => setDeleteBranch(event.target.checked)}
        />
        Also delete the branch{" "}
        <span className="font-mono text-caption">{worktree.branch}</span>
      </label>
      {needsForce ? (
        <div className="mt-2 rounded-lg border border-red-400/40 bg-red-500/10 p-2.5">
          {/* One force covers every risk below, so every risk it covers is
              stated: a dirty tree used to speak for an unverifiable branch too,
              and the consent then bought more than the sentence admitted. */}
          {losesWork ? (
            <p className="flex items-start gap-1.5 text-caption text-red-400">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {retire ? (
                <>
                  {lostWorkSentence} will be LOST. Force retirement also permits
                  removing the branch if delivery verification finds it is not
                  contained in {worktree.baseBranch}; those commits will be lost
                  too.
                </>
              ) : (
                <>
                  {lostWorkSentence} will be LOST
                  {losesUnmerged ? (
                    <> — the branch is not merged into {worktree.baseBranch}</>
                  ) : null}
                  .
                </>
              )}
            </p>
          ) : null}
          {unverifiable ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-caption text-red-400">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {retire ? (
                // The server's own words: this consent answers the refusal that
                // its refreshed verification actually produced, so quoting it is
                // what makes the answer match the question.
                <>
                  The last retirement was refused: {retire.refusal} Retiring
                  anyway may LOSE every commit on{" "}
                  <span className="font-mono">{worktree.branch}</span>.
                </>
              ) : (
                <>
                  The base branch{" "}
                  <span className="font-mono">{worktree.baseBranch}</span> does
                  not exist locally and Remove never fetches it, so whether{" "}
                  <span className="font-mono">{worktree.branch}</span> was
                  delivered cannot be checked here. Deleting the branch may LOSE
                  every commit on it — or keep the branch and remove only the
                  folder.
                </>
              )}
            </p>
          ) : null}
          <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-caption text-fg">
            <input
              type="checkbox"
              checked={confirmForce}
              onChange={(event) => setConfirmForce(event.target.checked)}
            />
            I understand, {consent}
          </label>
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
