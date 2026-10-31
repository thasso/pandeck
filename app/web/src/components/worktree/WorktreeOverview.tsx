import { useMemo, type ReactNode } from "react";
import {
  ArrowUpRight,
  CircleCheck,
  CircleDot,
  CircleX,
  CloudOff,
  FileDiff,
  FolderKanban,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestClosed,
  Trash2,
  TriangleAlert,
  GitPullRequest,
  House,
  Upload,
} from "lucide-react";
import type {
  ProjectRecord,
  SessionListItem,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import { Item } from "../ui/item.tsx";
import { Button } from "../ui/button.tsx";
import { AppCard } from "../common/AppCard.tsx";
import type { WorktreeRetire } from "./useWorktreeRetire.tsx";
import { IconButton } from "../common/IconButton.tsx";
import { SessionRowContent } from "../SessionRow.tsx";
import { sessionPath } from "../../lib/sessionRoutes.ts";
import { projectColor } from "../../lib/projectDisplay.ts";
import { projectPath } from "../../hooks/useSessionRouting.ts";
import type { WorktreeDelivery } from "./WorktreeDelivery.tsx";

/**
 * @component WorktreeOverview
 * @purpose What opening a worktree shows before any file, in the Task page's
 * shape: the branch as the page's title, where the work stands as one line of
 * plain muted facts under it, then who is working there.
 * @intent The sidebar's Projects tree browses the worktree's files and change
 * sets, so this page is the worktree's home rather than a navigator. Its acts
 * are the header's: the menu, and the panel's actions.
 */
export function WorktreeOverview({
  worktree,
  status,
  delivery,
  retire,
  onRemove,
  project,
  sessions,
  navigate,
  toolbar,
}: {
  worktree: WorktreeRecord;
  status: WorktreeGitStatus | undefined;
  delivery: WorktreeDelivery;
  /** Ends the worktree once its work is delivered: the notice's answer. */
  retire: WorktreeRetire;
  /** Opens the Remove dialog: the answer to work that was not delivered. */
  onRemove?: ((id: string) => void) | undefined;
  project?: ProjectRecord | undefined;
  sessions?: readonly SessionListItem[] | undefined;
  navigate: (path: string) => void;
  toolbar: ReactNode;
}) {
  const live = delivery.status ?? status;
  const working = useMemo(
    () =>
      (sessions ?? [])
        .filter(
          (session) =>
            session.worktreeId === worktree.id &&
            (session.isStreaming || !session.archived),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, worktree.id],
  );
  const branch = live?.branch ?? worktree.branch;
  // Delivered: the branch is in its base, or its pull request was merged. The
  // worktree has done its job, and Retire is the way it ends.
  const prMerged = delivery.hosting?.pr?.state === "merged";
  const integrated = Boolean(live?.merged && live.ahead > 0);
  const delivered = !worktree.isMain && (prMerged || integrated);
  // Closed unmerged: abandoned, unless it is reopened. Removing the worktree
  // (and, as its dialog offers, the branch) is the way it ends.
  const prClosed =
    !worktree.isMain && !delivered && delivery.hosting?.pr?.state === "closed";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toolbar}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-5 py-6">
          <div className="mb-6 flex flex-col gap-1.5">
            <h1 className="text-lg font-semibold wrap-anywhere text-foreground">
              {branch}
            </h1>
            {delivered ? (
              // A state that asks for a decision, as the Task page's notices:
              // what happened, and the answer in the footer.
              <AppCard
                role="status"
                tone="success"
                icon={<GitMerge />}
                label={
                  prMerged
                    ? "Pull request merged"
                    : `Merged into ${worktree.baseBranch}`
                }
                actions={
                  <Button size="xs" busy={retire.busy} onClick={retire.open}>
                    <Trash2 />
                    Retire worktree…
                  </Button>
                }
              >
                <p>
                  Its work is in {worktree.baseBranch}. Retiring verifies that,
                  settles the sessions working here, and removes the checkout
                  and its branch.
                </p>
              </AppCard>
            ) : null}
            {prClosed ? (
              <AppCard
                role="status"
                tone="neutral"
                icon={<GitPullRequestClosed />}
                label="Pull request closed"
                {...(onRemove
                  ? {
                      actions: (
                        <Button size="xs" onClick={() => onRemove(worktree.id)}>
                          <Trash2 />
                          Remove worktree…
                        </Button>
                      ),
                    }
                  : {})}
              >
                <p>
                  Closed without being merged. If the work is not coming back,
                  remove the worktree.
                </p>
              </AppCard>
            ) : null}
            {!worktree.isMain && live?.baseUnresolved ? (
              <AppCard
                role="status"
                tone="warning"
                icon={<TriangleAlert />}
                label={`${worktree.baseBranch} not found`}
              >
                <p>
                  The base branch is not in this repository, so how far the
                  branch is ahead or behind it is unknown — not zero.
                </p>
              </AppCard>
            ) : null}
            <WorktreeFacts
              worktree={worktree}
              status={live}
              delivery={delivery}
              project={project}
              navigate={navigate}
            />
          </div>
          <section aria-label="Sessions" className="mb-6">
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              Sessions
            </p>
            {working.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No sessions are working here.
              </p>
            ) : (
              <ul className="flex flex-col">
                {working.map((session) => (
                  <li key={session.id}>
                    <Item
                      variant="list"
                      size="list"
                      render={<button type="button" />}
                      className="-mx-2 w-[calc(100%+1rem)] min-w-0 rounded-md"
                      onClick={() => navigate(sessionPath(session.id))}
                    >
                      <SessionRowContent session={session} density="tight" />
                    </Item>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

const CI_FACT = {
  success: { icon: CircleCheck, label: "CI passing", className: "" },
  pending: { icon: CircleDot, label: "CI running", className: "text-warning" },
  failure: {
    icon: CircleX,
    label: "CI failing",
    className: "text-destructive",
  },
  error: { icon: CircleX, label: "CI errored", className: "text-destructive" },
} as const;

/**
 * Where the worktree stands, as the Task page's facts line: plain muted facts
 * with their glyphs, links where a fact has a home of its own.
 */
function WorktreeFacts({
  worktree,
  status,
  delivery,
  project,
  navigate,
}: {
  worktree: WorktreeRecord;
  status: WorktreeGitStatus | undefined;
  delivery: WorktreeDelivery;
  project: ProjectRecord | undefined;
  navigate: (path: string) => void;
}) {
  const pr = delivery.hosting?.pr;
  const ci = delivery.hosting?.ci;
  const ciFact = ci ? CI_FACT[ci.state] : undefined;
  const upstream = status?.upstream;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      {project ? (
        <span className="inline-flex min-w-0 items-center gap-0.5">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <FolderKanban
              size={14}
              aria-hidden
              className="shrink-0"
              style={{ color: projectColor(project).dot }}
            />
            <span className="truncate">{project.name}</span>
          </span>
          <IconButton
            label="Open project"
            size="icon-xs"
            className="size-5 text-muted-foreground hover:text-foreground"
            onClick={() => navigate(projectPath(project.id))}
          >
            <ArrowUpRight />
          </IconButton>
        </span>
      ) : null}
      {worktree.isMain ? (
        <span className="inline-flex items-center gap-1.5">
          <House size={14} aria-hidden />
          Main checkout
        </span>
      ) : status && !status.baseUnresolved ? (
        <span
          className="inline-flex items-center gap-1.5 font-mono text-xs"
          title={`Against ${worktree.baseBranch}: ${status.ahead} ahead, ${status.behind} behind`}
        >
          {worktree.baseBranch}
          <span className={status.ahead > 0 ? "text-success" : ""}>
            ↑{status.ahead}
          </span>
          <span className={status.behind > 0 ? "text-warning" : ""}>
            ↓{status.behind}
          </span>
        </span>
      ) : null}
      {status ? (
        upstream ? (
          <span
            className="inline-flex items-center gap-1.5 font-mono text-xs"
            title={`Against ${upstream.name ?? "its upstream"}: ${upstream.ahead} to push, ${upstream.behind} to pull`}
          >
            <Upload size={14} aria-hidden />
            {upstream.name ?? "upstream"}
            <span className={upstream.ahead > 0 ? "text-success" : ""}>
              ↑{upstream.ahead}
            </span>
            <span className={upstream.behind > 0 ? "text-warning" : ""}>
              ↓{upstream.behind}
            </span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <CloudOff size={14} aria-hidden />
            Unpublished
          </span>
        )
      ) : null}
      {status?.dirty ? (
        <span className="inline-flex items-center gap-1.5">
          <FileDiff size={14} aria-hidden />
          {status.filesChanged + status.untracked} uncommitted
          <span className="font-mono text-xs">
            <span className="text-success">+{status.additions}</span>{" "}
            <span className="text-destructive">−{status.deletions}</span>
          </span>
        </span>
      ) : null}
      {pr ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <GitPullRequest size={14} aria-hidden className="shrink-0" />
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer noopener"
            title={pr.title}
            className="truncate text-foreground underline underline-offset-3 hover:text-primary"
          >
            #{pr.number}
          </a>
          {pr.state !== "open" ? <span>{pr.state}</span> : null}
        </span>
      ) : null}
      {ciFact ? (
        <span
          className={`inline-flex items-center gap-1.5 ${ciFact.className}`}
        >
          <ciFact.icon size={14} aria-hidden />
          {ci?.url ? (
            <a
              href={ci.url}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-3 hover:text-primary"
            >
              {ciFact.label}
            </a>
          ) : (
            ciFact.label
          )}
        </span>
      ) : null}
      {status?.head ? (
        <span className="inline-flex items-center gap-1.5 font-mono text-xs">
          <GitCommitHorizontal size={14} aria-hidden />
          {status.head}
        </span>
      ) : null}
    </div>
  );
}
