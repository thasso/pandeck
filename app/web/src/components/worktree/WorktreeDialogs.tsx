/**
 * Worktree dialogs: create, manual/agent-generated commit outcomes, confirmed
 * HEAD-scoped clean, PR creation, PR merge, local merge back, and guarded
 * removal.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { IconButton } from "../common/IconButton.tsx";
import { Alert, AlertDescription } from "../ui/alert.tsx";
import { Button } from "../ui/button.tsx";
import { Checkbox } from "../ui/checkbox.tsx";
import { Field, FieldLabel } from "../ui/field.tsx";
import { Input } from "../ui/input.tsx";
import { Label } from "../ui/label.tsx";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group.tsx";
import { Textarea } from "../ui/textarea.tsx";
import {
  ConfirmDialog,
  DialogAction,
  DialogCancelButton,
  DialogHeader,
  DialogOverlay as Overlay,
} from "../common/dialogs.tsx";

/* ------------------------------ shared controls ----------------------------- */

/** A checkbox and the sentence it answers, the whole row clickable. */
export function CheckRow({
  checked,
  onChange,
  disabled = false,
  className,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Label className={className ?? "mt-2"}>
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <span>{children}</span>
    </Label>
  );
}

/** One radio card per option, labelled by its sentence. */
export function ChoiceGroup<T extends string>({
  options,
  labels,
  value,
  onChange,
  disabled = false,
}: {
  options: readonly T[];
  labels: Record<T, string>;
  value: T | undefined;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <RadioGroup
      value={value ?? null}
      disabled={disabled}
      onValueChange={(next) => onChange(next as T)}
    >
      {options.map((id) => (
        <FieldLabel key={id}>
          <Field orientation="horizontal">
            <RadioGroupItem value={id} />
            {labels[id]}
          </Field>
        </FieldLabel>
      ))}
    </RadioGroup>
  );
}

/**
 * The one alarm a destructive flow raises when it would lose work: what is at
 * stake, then the consent that unlocks the confirming button.
 */
export function ForceConsent({
  consent,
  checked,
  onChange,
  disabled = false,
  children,
}: {
  /** What the checkbox agrees to, after "I understand, ". */
  consent: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Alert variant="destructive" className="mt-2">
      <AlertTriangle />
      <AlertDescription className="flex flex-col gap-1.5">
        {children}
        <CheckRow
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          className=""
        >
          I understand, {consent}
        </CheckRow>
      </AlertDescription>
    </Alert>
  );
}

export const MERGE_METHOD_LABELS: Record<PullRequestMergeMethod, string> = {
  squash: "Squash — one commit on the base branch",
  merge: "Merge commit — keep individual commits",
  rebase: "Rebase — replay the commits onto the base",
};

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
      <p className="text-sm text-muted-foreground">
        The name becomes the branch and the folder suffix. A naming agent
        proposes one; edit freely.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Input
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
          className="flex-1 font-mono"
        />
        {/* Deliberately NOT a busy control, unlike `DialogAction` below: the
            spinner reports the naming AGENT's outstanding proposal, and this
            button is the way to ask again when that agent never answers, so
            disabling it would strand the dialog on a request that will not
            arrive. It therefore carries no `aria-busy` either — the pending
            state is announced by the input's "Proposing a name…" placeholder,
            and a button that says "busy" while it is the retry would be a lie.
            The icon button's fixed size keeps both glyphs in one slot. */}
        <IconButton
          label="Propose another name"
          variant="outline"
          size="icon"
          onClick={() => {
            edited.current = false;
            onPropose();
          }}
        >
          {proposal === null ? <Spinner size="sm" /> : <RefreshCw />}
        </IconButton>
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
      <p className="text-sm text-muted-foreground">
        Commits{" "}
        {fileCount > 0
          ? `all ${fileCount} changed file${fileCount === 1 ? "" : "s"}`
          : "everything changed"}{" "}
        in {scopeLabel} with your git identity.
      </p>
      <Textarea
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
        className="mt-3"
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
        <div className="mt-2 rounded-lg border border-border bg-background px-3 py-2">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Generated message
          </p>
          <pre className="whitespace-pre-wrap font-sans text-sm text-foreground">
            {result.commitMessage}
          </pre>
        </div>
      ) : null}
      {result.blockers.length ? (
        <div className="mt-3">
          <p className="text-sm font-semibold text-destructive">Blockers</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
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
          <p className="text-sm font-semibold text-warning">Warnings</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
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
          <span className="font-mono text-foreground">HEAD</span> and ordinary
          untracked files are removed. Commits and ignored files are preserved.
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
      <p className="text-sm text-muted-foreground">
        <span className="font-mono">{worktree.branch}</span> →{" "}
        <span className="font-mono">{worktree.baseBranch}</span>. Push your
        commits first — the PR is created from the remote branch.
      </p>
      <Input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Title"
        className="mt-3"
      />
      <Textarea
        rows={4}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Description (optional)"
        className="mt-2"
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
      <p className="text-sm text-muted-foreground">
        <span className="font-mono">{worktree.branch}</span> →{" "}
        <span className="font-mono">{worktree.baseBranch}</span>.{" "}
        {deleteBranch
          ? "The remote branch is deleted with the merge"
          : "The remote branch is kept"}
        ; this worktree stays until you clean it up.
      </p>
      <div className="mt-3">
        {offered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {supportedMethods
              ? "This repository allows no merge method for pull requests."
              : "The merge methods this repository allows could not be read; nothing can be chosen."}
          </p>
        ) : (
          <ChoiceGroup
            options={offered}
            labels={MERGE_METHOD_LABELS}
            value={selected}
            onChange={setMethod}
          />
        )}
      </div>
      <CheckRow
        checked={deleteBranch}
        disabled={busy}
        onChange={setDeleteBranch}
      >
        Delete the remote branch{" "}
        <span className="font-mono">{worktree.branch}</span>
      </CheckRow>
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
          {warnings.length > 0 ? (
            <Alert variant="warning" className="mb-2">
              <AlertTriangle />
              <AlertDescription>
                {warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </AlertDescription>
            </Alert>
          ) : null}
          {phase === "failed" && merge?.message ? (
            <ErrorNote message={merge.message} className="mb-2" />
          ) : null}
          <ChoiceGroup
            options={Object.keys(STRATEGY_LABELS) as WorktreeMergeStrategy[]}
            labels={STRATEGY_LABELS}
            value={strategy}
            onChange={setStrategy}
          />
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
            className="flex items-center gap-2 text-sm text-foreground"
          >
            {busy ? <Spinner size="sm" className="text-primary" /> : null}
            {PHASE_LABELS[phase]}
          </p>
          {merge?.message ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {merge.message}
            </p>
          ) : null}
          {merge?.conflictPaths?.length ? (
            <ul className="mt-2 max-h-24 overflow-y-auto rounded-lg border border-border p-2 font-mono text-sm text-muted-foreground">
              {merge.conflictPaths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          ) : null}
          {merge?.agentSessionId &&
          (phase === "agent_resolving" || phase === "conflicts") ? (
            <Button
              variant="link"
              className="mt-2 px-0"
              onClick={() => onOpenSession(merge.agentSessionId!)}
            >
              Open the merge agent's session →
            </Button>
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
            <span className="font-mono text-sm">{worktree.path}</span>. The
            sessions still working here are settled out of the inbox with it;
            one that is running, or waiting on an answer or approval, refuses
            the removal instead.
          </>
        )
      }
    >
      <CheckRow checked={deleteBranch} onChange={setDeleteBranch}>
        Also delete the branch{" "}
        <span className="font-mono">{worktree.branch}</span>
      </CheckRow>
      {needsForce ? (
        // One force covers every risk below, so every risk it covers is
        // stated: a dirty tree used to speak for an unverifiable branch too,
        // and the consent then bought more than the sentence admitted.
        <ForceConsent
          consent={consent}
          checked={confirmForce}
          onChange={setConfirmForce}
        >
          {losesWork ? (
            <p>
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
            <p>
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
        </ForceConsent>
      ) : null}
    </ConfirmDialog>
  );
}
