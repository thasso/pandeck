/**
 * @component useWorktreeDelivery / WorktreeDeliverySection
 * @purpose The worktree's DELIVERY state and the actions on it: where the work
 *   stands (files, lines, ahead/behind, published, CI, PR) as one panel section,
 *   and what you can do about it (commit, push, sync, PR, clean) as
 *   `InspectorAction`s the panel shows in its ONE Actions section.
 * @useWhen In the worktree object panel — which on a phone is the dock sheet, i.e.
 *   the object's action home.
 * @avoidWhen Anywhere on the page itself. This deliberately replaced the toolbar's
 *   status cluster: delivery state was scattered across header chips, a sidebar
 *   counter, toolbar glyphs and panel facts, while its actions hid in a twelve-item
 *   `⋯` menu wedged between navigation and rendering controls. State you check at a
 *   glance and actions you take on it belong together, in the panel, at the thumb
 *   edge.
 * @intent A panel has ONE list of actions: delivery used to grow a second one
 *   under its facts, so the same reader had two places to look for "what can I
 *   do". The hook hands its actions to the panel, which orders them routine
 *   first and irreversible last, next to the lifecycle actions (start session,
 *   merge back, remove). Everything that needs a decision confirms in a dialog —
 *   the merge METHOD is per-merge, and the remote branch goes with it — and the
 *   dialogs travel with the actions.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  CircleCheck,
  CircleX,
  Download,
  Eraser,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Pencil,
  RefreshCw,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import type {
  CommitDisplay,
  PullRequestMergeMethod,
  WorktreeGitStatus,
  WorktreeHostingStatusResponse,
  WorktreeRecord,
  WorktreeSyncOperation,
} from "@assistant/shared";
import {
  InspectorFacts,
  InspectorSection,
  type InspectorAction,
} from "../shell/Inspector.tsx";
import { Spinner } from "../common/load.tsx";
import {
  autoCommitWorktree,
  cleanWorktree,
  commitWorktree,
  createWorktreePr,
  fetchWorktreeHosting,
  fetchWorktreeStatus,
  mergeWorktreePr,
  pushWorktree,
  syncWorktree,
} from "../../lib/worktrees.ts";
import { showToast, TOAST_DWELL_MS } from "../../lib/toast.ts";
import {
  AutoCommitResultDialog,
  CleanWorktreeDialog,
  CommitWorktreeDialog,
  CreatePullRequestDialog,
  MergePullRequestDialog,
} from "./WorktreeDialogs.tsx";

const CI_POLL_MS = 60_000;

const CI_DISPLAY = {
  success: { className: "text-emerald-400", label: "passing" },
  pending: { className: "text-amber-400", label: "running" },
  failure: { className: "text-red-400", label: "failing" },
  error: { className: "text-red-400", label: "errored" },
} as const;

function ciIcon(state: string) {
  if (state === "success") return <CircleCheck size={13} />;
  // Checks that are still running are the app's one spinner, like every other
  // "this is happening now" glyph; the row's tone says whose state it is.
  if (state === "pending") return <Spinner size="sm" />;
  return <CircleX size={13} />;
}

/** What the hook hands its host: the state to show, the actions, the dialogs. */
export interface WorktreeDelivery {
  /** Freshest git status — the pushed one or our own refetch, newest wins. */
  status?: WorktreeGitStatus;
  hosting: WorktreeHostingStatusResponse | null;
  /** Delivery actions for the panel's single Actions section, routine first. */
  actions: InspectorAction[];
  /** The confirmations those actions open; render once, anywhere. */
  dialogs: ReactNode;
}

export function useWorktreeDelivery({
  worktree,
  status: pushedStatus,
}: {
  /** Undefined while the panel's object is still loading: the hook runs anyway
   *  (hooks are unconditional) and simply has nothing to offer yet. */
  worktree: WorktreeRecord | undefined;
  /** Watcher-pushed git status; a mutation here refetches so the row updates now. */
  status?: WorktreeGitStatus;
}): WorktreeDelivery {
  const [fetchedStatus, setFetchedStatus] = useState<
    WorktreeGitStatus | undefined
  >(undefined);
  // Newest wins, the same rule the page uses: the watcher push and our own refetch
  // race, and either may be the fresher one.
  const status =
    pushedStatus &&
    (!fetchedStatus || pushedStatus.updatedAt >= fetchedStatus.updatedAt)
      ? pushedStatus
      : fetchedStatus;

  const [commitOpen, setCommitOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [autoCommitting, setAutoCommitting] = useState(false);
  const [autoResult, setAutoResult] = useState<CommitDisplay | null>(null);
  const [pushing, setPushing] = useState(false);
  const [syncing, setSyncing] = useState<WorktreeSyncOperation | null>(null);
  const [hosting, setHosting] = useState<WorktreeHostingStatusResponse | null>(
    null,
  );
  const [prOpen, setPrOpen] = useState(false);
  const [creatingPr, setCreatingPr] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [mergePrOpen, setMergePrOpen] = useState(false);
  const [mergingPr, setMergingPr] = useState(false);
  const [mergePrError, setMergePrError] = useState<string | null>(null);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanError, setCleanError] = useState<string | null>(null);

  const worktreeId = worktree?.id;

  const onDidMutate = () => {
    if (!worktreeId) return;
    fetchWorktreeStatus(worktreeId)
      .then(setFetchedStatus)
      .catch(() => undefined);
  };

  const head = status?.head;
  const ciPending = hosting?.ci?.state === "pending";
  useEffect(() => {
    if (!worktreeId) return;
    let cancelled = false;
    const load = () => {
      fetchWorktreeHosting(worktreeId)
        .then((payload) => {
          if (!cancelled && payload.worktreeId === worktreeId)
            setHosting(payload);
        })
        .catch(() => {
          if (!cancelled) setHosting(null);
        });
    };
    load();
    // Poll only while CI is actually running; HEAD moving refetches anyway.
    const timer = ciPending ? window.setInterval(load, CI_POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [worktreeId, head, ciPending]);

  const hostingForThis =
    hosting && hosting.worktreeId === worktreeId ? hosting : null;
  const pushable =
    Boolean(status?.head) && (!status?.upstream || status.upstream.ahead > 0);
  const canCreatePr =
    Boolean(hostingForThis?.provider) &&
    !worktree?.isMain &&
    !hostingForThis?.pr &&
    Boolean(status?.upstream);
  // Only an OPEN pull request can be merged, and only from its own worktree.
  const mergeablePr =
    !worktree?.isMain && hostingForThis?.pr?.state === "open"
      ? hostingForThis.pr
      : undefined;

  const doManualCommit = async (message: string) => {
    setCommitting(true);
    setCommitError(null);
    try {
      const result = await commitWorktree(worktreeId!, { message });
      showToast(
        result.status === "nothing-to-commit"
          ? "Nothing to commit."
          : `Committed ${result.commitHash ?? "changes"}.`,
        { tone: result.status === "committed" ? "success" : "default" },
      );
      setCommitOpen(false);
      onDidMutate();
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  };

  const doAutoCommit = async (force = false) => {
    setAutoCommitting(true);
    try {
      const response = await autoCommitWorktree(worktreeId!, { force });
      if (response.result.status === "committed") {
        setAutoResult(null);
        showToast(`Committed ${response.result.commitHash ?? "changes"}.`, {
          tone: "success",
        });
        onDidMutate();
      } else {
        setAutoResult(response.result);
      }
    } catch (err) {
      setAutoResult({
        status: "failed",
        dryRun: false,
        forced: force,
        blockers: [],
        warnings: [],
        files: [],
        totals: { files: 0, additions: 0, deletions: 0 },
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setAutoCommitting(false);
    }
  };

  // Where a failure lands, per the model's inline-or-toast rule: an act that
  // confirms in a DIALOG reports into that dialog's `ErrorNote`, because the
  // dialog is still open and holds the retry. A row act has no such home — this
  // section is the dock SHEET on a phone, dismissed the moment the row is
  // tapped — so its outcome, good or bad, travels as a toast.
  const doPush = async (force = false) => {
    setPushing(true);
    try {
      const result = await pushWorktree(worktreeId!, { force });
      if (result.status === "failed")
        showToast(result.error || "Push failed.", {
          tone: "error",
          durationMs: TOAST_DWELL_MS,
        });
      else if (result.status === "up-to-date")
        showToast("Everything up to date.");
      else
        showToast(
          `Pushed ${result.branch ?? worktree?.branch} → ${result.remote ?? "origin"}${result.setUpstream ? " (upstream set)" : ""}.`,
          { tone: "success" },
        );
      onDidMutate();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), {
        tone: "error",
        durationMs: TOAST_DWELL_MS,
      });
    } finally {
      setPushing(false);
    }
  };

  const doSync = async (operation: WorktreeSyncOperation) => {
    setSyncing(operation);
    try {
      const result = await syncWorktree(worktreeId!, operation);
      const action =
        operation === "pull-rebase"
          ? "Pull from origin"
          : `Pull from ${worktree?.baseBranch ?? "main"}`;
      showToast(
        result.status === "up-to-date"
          ? `${action}: already up to date.`
          : `${action} completed.`,
        { tone: result.status === "updated" ? "success" : "default" },
      );
      onDidMutate();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), {
        tone: "error",
        durationMs: TOAST_DWELL_MS,
      });
      onDidMutate();
    } finally {
      setSyncing(null);
    }
  };

  const doMergePr = async ({
    method,
    deleteBranch,
  }: {
    method: PullRequestMergeMethod;
    deleteBranch: boolean;
  }) => {
    setMergingPr(true);
    setMergePrError(null);
    try {
      const result = await mergeWorktreePr(worktreeId!, {
        method,
        // Deleting is the default, so only the opt-out is sent.
        ...(deleteBranch ? {} : { deleteBranch: false }),
      });
      setMergePrOpen(false);
      setHosting((current) =>
        current && current.worktreeId === worktreeId
          ? { ...current, pr: result.pr }
          : current,
      );
      const deletionRefused = deleteBranch && !result.branchDeleted;
      showToast(
        // What actually happened to the branch, not what was asked for: a
        // deletion the provider refused must not be reported as done.
        `Merged PR #${result.pr.number}${
          result.branchDeleted
            ? " and deleted the remote branch"
            : deleteBranch
              ? "; the remote branch was NOT deleted"
              : " and kept the remote branch"
        }.`,
        {
          tone: "success",
          ...(deletionRefused ? { durationMs: TOAST_DWELL_MS } : {}),
        },
      );
      onDidMutate();
    } catch (err) {
      setMergePrError(err instanceof Error ? err.message : String(err));
    } finally {
      setMergingPr(false);
    }
  };

  const doClean = async () => {
    setCleaning(true);
    setCleanError(null);
    try {
      const result = await cleanWorktree(worktreeId!);
      showToast(
        result.status === "cleaned"
          ? `Discarded changes in ${result.filesDiscarded} file${result.filesDiscarded === 1 ? "" : "s"}.`
          : "Worktree is already clean.",
        { tone: result.status === "cleaned" ? "success" : "default" },
      );
      setCleanOpen(false);
      onDidMutate();
    } catch (err) {
      setCleanError(err instanceof Error ? err.message : String(err));
    } finally {
      setCleaning(false);
    }
  };

  const doCreatePr = async (title: string, body: string) => {
    setCreatingPr(true);
    setPrError(null);
    try {
      const result = await createWorktreePr(worktreeId!, {
        title,
        ...(body ? { body } : {}),
      });
      setPrOpen(false);
      setHosting((current) =>
        current && current.worktreeId === worktreeId
          ? { ...current, pr: result.pr }
          : current,
      );
      showToast(`Created PR #${result.pr.number}.`, {
        tone: "success",
        durationMs: TOAST_DWELL_MS,
        action: {
          label: "Open",
          onClick: () => window.open(result.pr.url, "_blank", "noreferrer"),
        },
      });
    } catch (err) {
      setPrError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingPr(false);
    }
  };

  // Only what the state allows: no "Push" on a branch with nothing to push, and
  // no force-push unless the remote has actually diverged. A row's own detail —
  // how many commits, which PR — is its `hint`, so the label stays the act.
  const actions: InspectorAction[] = !worktree
    ? []
    : [
        ...(status?.dirty
          ? [
              {
                key: "auto-commit",
                icon: (
                  <span className="relative">
                    <GitCommitHorizontal size={14} />
                    <Sparkles size={6} className="absolute -right-1 -top-1" />
                  </span>
                ),
                label: "Auto commit",
                busy: autoCommitting,
                disabled: syncing !== null,
                // Its OUTCOME can be a dialog (blockers, or a failure), and
                // that dialog is mounted from this hook — see "commit" below.
                keepOpen: true,
                onRun: () => void doAutoCommit(),
              },
              {
                key: "commit",
                icon: <Pencil size={14} />,
                label: "Commit with message…",
                disabled: committing || syncing !== null,
                // Opens a DIALOG, and the dialog — like this hook's state —
                // lives in the dock sheet's body, which a collapse unmounts.
                // Collapsing on act would destroy the very dialog the act just
                // opened (`keepOpen` on every dialog-opening row here).
                keepOpen: true,
                onRun: () => {
                  setCommitError(null);
                  setCommitOpen(true);
                },
              },
            ]
          : []),
        ...(pushable
          ? [
              {
                key: "push",
                icon: <UploadCloud size={14} />,
                label: "Push",
                hint: status?.upstream
                  ? `${status.upstream.ahead} commit${status.upstream.ahead === 1 ? "" : "s"}`
                  : "new branch",
                busy: pushing,
                disabled: syncing !== null,
                onRun: () => void doPush(),
              },
            ]
          : []),
        ...(status?.upstream &&
        (status.upstream.ahead > 0 || status.upstream.behind > 0)
          ? [
              {
                key: "force-push",
                icon: <UploadCloud size={14} />,
                label: "Force push",
                hint: "with lease",
                disabled: pushing || syncing !== null,
                onRun: () => void doPush(true),
              },
            ]
          : []),
        {
          key: "pull",
          icon: <Download size={14} />,
          label: "Pull from origin",
          busy: syncing === "pull-rebase",
          // Nothing to pull FROM until the branch is published: pulling would only
          // report a missing upstream.
          disabled: syncing !== null || !status?.upstream,
          ...(status?.upstream
            ? {}
            : { disabledReason: "Push the branch first" }),
          onRun: () => void doSync("pull-rebase"),
        },
        ...(worktree.isMain
          ? []
          : [
              {
                key: "rebase-main",
                icon: <RefreshCw size={14} />,
                // What it does, and onto WHICH base: the remote's, fetched
                // first. Rebasing onto whatever this machine's main checkout
                // happened to be at was the ambiguity, not the rebase. And
                // there is no fast-forward-main row: landing the branch on main
                // is "Merge back…", which says so and offers the strategy.
                label: `Pull from ${worktree.baseBranch}`,
                // Which REMOTE carries the base branch is the server's
                // resolution (a configured `branch.<base>.remote`, else
                // `origin`, else a sole remote), so the hint says "the
                // remote's" rather than naming one this client cannot know.
                hint: `rebase onto remote ${worktree.baseBranch}`,
                busy: syncing === "rebase-main",
                disabled: syncing !== null,
                onRun: () => void doSync("rebase-main"),
              },
            ]),
        ...(mergeablePr
          ? [
              {
                key: "merge-pr",
                icon: <GitMerge size={14} />,
                label: "Merge pull request…",
                hint: `#${mergeablePr.number}`,
                keepOpen: true,
                busy: mergingPr,
                disabled: syncing !== null,
                onRun: () => {
                  setMergePrError(null);
                  setMergePrOpen(true);
                },
              },
            ]
          : []),
        ...(canCreatePr
          ? [
              {
                key: "create-pr",
                icon: <GitPullRequest size={14} />,
                label: "Create pull request…",
                keepOpen: true,
                onRun: () => {
                  setPrError(null);
                  setPrOpen(true);
                },
              },
            ]
          : []),
        ...(status?.dirty
          ? [
              {
                key: "clean",
                icon: <Eraser size={14} />,
                label: "Clean worktree…",
                busy: cleaning,
                keepOpen: true,
                disabled: syncing !== null,
                onRun: () => {
                  setCleanError(null);
                  setCleanOpen(true);
                },
              },
            ]
          : []),
      ];

  const dialogs = !worktree ? null : (
    <>
      {commitOpen && status ? (
        <CommitWorktreeDialog
          status={status}
          busy={committing}
          error={commitError}
          onCommit={(message) => void doManualCommit(message)}
          onClose={() => {
            if (!committing) setCommitOpen(false);
          }}
        />
      ) : null}
      {autoResult ? (
        <AutoCommitResultDialog
          result={autoResult}
          busy={autoCommitting}
          onForce={() => void doAutoCommit(true)}
          onClose={() => {
            if (!autoCommitting) setAutoResult(null);
          }}
        />
      ) : null}
      {cleanOpen && status ? (
        <CleanWorktreeDialog
          status={status}
          busy={cleaning}
          error={cleanError}
          onClean={() => void doClean()}
          onClose={() => {
            if (!cleaning) setCleanOpen(false);
          }}
        />
      ) : null}
      {mergePrOpen && mergeablePr ? (
        <MergePullRequestDialog
          worktree={worktree}
          prNumber={mergeablePr.number}
          // Only what the provider says this repository allows may be offered.
          supportedMethods={hostingForThis?.capabilities?.mergeMethods}
          defaultMethod={hostingForThis?.capabilities?.defaultMergeMethod}
          busy={mergingPr}
          error={mergePrError}
          onMerge={(options) => void doMergePr(options)}
          onClose={() => {
            if (!mergingPr) setMergePrOpen(false);
          }}
        />
      ) : null}
      {prOpen ? (
        <CreatePullRequestDialog
          worktree={worktree}
          busy={creatingPr}
          error={prError}
          onCreate={(title, body) => void doCreatePr(title, body)}
          onClose={() => {
            if (!creatingPr) setPrOpen(false);
          }}
        />
      ) : null}
    </>
  );

  return {
    ...(status !== undefined ? { status } : {}),
    hosting: hostingForThis,
    actions,
    dialogs,
  };
}

/** The delivery FACTS: where the work stands, with the acts up in Actions. */
export function WorktreeDeliverySection({
  worktree,
  delivery,
  storageScope,
}: {
  worktree: WorktreeRecord;
  delivery: WorktreeDelivery;
  storageScope: string;
}) {
  const { status, hosting } = delivery;
  const ci = hosting?.ci;
  const ciDisplay = ci
    ? (CI_DISPLAY[ci.state as keyof typeof CI_DISPLAY] ?? CI_DISPLAY.error)
    : undefined;

  // What the section says with the panel closed: the one thing you would look for.
  const summary = status
    ? status.dirty
      ? `${status.filesChanged + status.untracked} uncommitted`
      : status.upstream && status.upstream.ahead > 0
        ? `${status.upstream.ahead} to push`
        : !status.upstream && status.head
          ? "unpublished"
          : "clean"
    : undefined;

  return (
    <InspectorSection
      id="delivery"
      storageScope={storageScope}
      title="Delivery"
      icon={<UploadCloud size={13} />}
      summary={summary}
    >
      {status ? (
        <InspectorFacts
          facts={[
            {
              label: "Working tree",
              value: status.dirty ? (
                <>
                  {status.filesChanged + status.untracked} files{" "}
                  <span className="text-emerald-400">+{status.additions}</span>{" "}
                  <span className="text-red-400">−{status.deletions}</span>
                </>
              ) : (
                "clean"
              ),
              mono: true,
            },
            {
              // Against the tracked REMOTE when there is one, so "2 to push" and
              // "not published" are distinguishable at a glance.
              label: "Remote",
              value: status.upstream
                ? `↑${status.upstream.ahead} ↓${status.upstream.behind}`
                : status.head
                  ? "not published"
                  : "no commits",
              mono: true,
            },
            ...(worktree.isMain
              ? []
              : [
                  {
                    label: `vs ${worktree.baseBranch}`,
                    value: `↑${status.ahead} ↓${status.behind}`,
                    mono: true,
                  },
                ]),
            ...(status.head
              ? [{ label: "HEAD", value: status.head, mono: true }]
              : []),
            ...(ci && ciDisplay
              ? [
                  {
                    label: "CI",
                    value: (
                      <span
                        className={`inline-flex items-center gap-1 ${ciDisplay.className}`}
                      >
                        {ciIcon(ci.state)}
                        {ci.url ? (
                          <a
                            href={ci.url}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:underline"
                          >
                            {ciDisplay.label}
                          </a>
                        ) : (
                          ciDisplay.label
                        )}
                        <span className="text-faint">
                          · {ci.total} check{ci.total === 1 ? "" : "s"}
                        </span>
                      </span>
                    ),
                  },
                ]
              : []),
            ...(hosting?.pr
              ? [
                  {
                    label: "PR",
                    value: (
                      <a
                        href={hosting.pr.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <GitPullRequest size={12} /> #{hosting.pr.number}
                      </a>
                    ),
                  },
                ]
              : []),
          ]}
        />
      ) : (
        <p className="px-1 text-caption text-faint">Loading git status…</p>
      )}
    </InspectorSection>
  );
}
