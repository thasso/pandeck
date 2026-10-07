/**
 * @component PullRequestDetailPage
 * @purpose Main-pane page for ONE pull request: what the provider says about
 * it, and what it is joined to on this machine.
 * @useWhen The route is `/pull-requests/:projectId/:number`.
 * @avoidWhen Listing pull requests — that is `PullRequestBrowser`, the
 * section's sidebar browser. Acting on one — the acts (review, create the
 * checkout, merge & clean up, open on the provider) are the object panel's
 * (`PullRequestInspector`), in the one Actions list every object type has.
 * @intent The page a decision is made on, so every claim it makes is sourced
 * and an unknown is shown as unknown: absence on the wire means the provider
 * was not reached, and `mergeable: null` means "ask again", never "conflicts".
 * It performs no fetch of its own — the app polls one inventory
 * (`hooks/usePullRequestInventory.ts`) and this page reads the same projection,
 * so the list and the page can never disagree about the same pull request.
 * @related PullRequestBrowser, PullRequestInspector, pullRequestInbox (lib),
 * WorktreeDetailPage
 */
import type { ReactNode } from "react";
import {
  CircleDot,
  GitBranch,
  GitPullRequest,
  ClipboardList,
  MessagesSquare,
} from "lucide-react";
import type {
  ProjectRecord,
  PullRequestInventoryItem,
  WorktreeGitStatus,
} from "@assistant/shared";
import { PageHeader, type PageHeaderBack } from "../PageHeader.tsx";
import {
  EmptyBox,
  ErrorNote,
  RefreshIndicator,
  Skeleton,
} from "../common/load.tsx";
import {
  resolveJoinRows,
  type JoinRowState,
  type JoinSource,
  type PullRequestJoinSources,
  pullRequestCiState,
  pullRequestMergeability,
  pullRequestMergeBlockedReason,
  pullRequestReviewState,
  pullRequestStateLabel,
  type PullRequestTarget,
} from "../../lib/pullRequestInbox.ts";
import {
  dataOf,
  errorOf,
  isPending,
  type LoadState,
} from "../../lib/loadState.ts";
import { projectDisplayKey } from "../../lib/projectDisplay.ts";

interface Props {
  back?: PageHeaderBack | undefined;
  /** Which pull request the route addresses; the page is keyed by it. */
  target: PullRequestTarget;
  /**
   * This pull request out of the app's inventory. `ready(null)` is the
   * authoritative "the inventory does not hold it"; `loading` is the inventory
   * not having answered, and the two must never render alike (R1).
   */
  state: LoadState<PullRequestInventoryItem | null>;
  onReload: () => void;
  projects: ProjectRecord[];
  /**
   * The three lists the inventory's join IDS are resolved against, each with
   * what is known about its currency (`lib/pullRequestInbox.ts`). The ids are
   * authoritative and these lists are not: a cold, stale or failed one must
   * never be quoted as evidence that a pull request has no Task (R1), and
   * `?? []` on the way in is the whole bug class.
   */
  joins: PullRequestJoinSources;
  /** LIVE git status for the joined worktree; the page states dirt and drift. */
  status?: WorktreeGitStatus | undefined;
  onOpenWorktree: (worktreeId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenTask: (taskId: string) => void;
}

function Block({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-panel/40 p-3">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
        <span className="text-faint" aria-hidden>
          {icon}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 py-0.5">
      <span className="w-28 shrink-0 text-xs uppercase tracking-wide text-faint">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-sm text-fg">{children}</span>
    </div>
  );
}

/** One relation row; the whole row opens the object it names. */
function RelationRow({
  icon,
  label,
  detail,
  onOpen,
}: {
  icon: ReactNode;
  label: string;
  detail?: ReactNode;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <span className="shrink-0 text-faint" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-fg">{label}</span>
      {detail ? (
        <span className="shrink-0 text-xs text-faint">{detail}</span>
      ) : null}
    </button>
  );
}

/**
 * What a row says when a FRESH list does not hold its id — an archived session
 * or Task, say. It is a statement, not a placeholder: nothing is coming for it.
 */
const NOT_IN_LIST = "not in this list";

/**
 * One group of join ids, rendered against the list that resolves them.
 *
 * FOUR answers, and collapsing any two of them is a lie the page tells
 * confidently. Zero ids is the only authoritative empty — the inventory itself
 * said so. A resolved id renders even from a STALE list, because retained data
 * stays readable. An unresolved id whose list is cold, stale or failed reserves
 * its row, because that list is exactly what a just-linked object is missing
 * from. Only a FRESH list may say an id is not in it. `resolveJoinRows` decides
 * which is which; this renders the answer.
 */
function JoinGroup<T>({
  title,
  ids,
  source,
  identify,
  icon,
  emptyLabel,
  render,
  onOpen,
}: {
  title: string;
  ids: string[];
  source: JoinSource<T>;
  identify: (row: T) => string;
  icon: ReactNode;
  emptyLabel: string;
  render: (row: T) => { label: string; detail?: string };
  onOpen: (id: string) => void;
}) {
  const rows = resolveJoinRows(ids, source, identify);
  const pending = rows.filter((row) => row.kind === "pending");
  return (
    <>
      <h3 className="mb-1 mt-3 text-xs uppercase tracking-wide text-faint">
        {title}
      </h3>
      {/* R2: the retained rows below stay, and the failure sits beside them. */}
      {ids.length > 0 && source.error ? (
        <ErrorNote className="mb-1" message={source.error} />
      ) : null}
      {ids.length === 0 ? (
        <EmptyBox variant="inline">{emptyLabel}</EmptyBox>
      ) : (
        <>
          {rows.map((row) =>
            row.kind === "pending" ? null : (
              <RelationRow
                key={row.id}
                icon={icon}
                {...joinRowParts(row, render)}
                onOpen={() => onOpen(row.id)}
              />
            ),
          )}
          {/* One announcing region for however many rows are still unknown,
              at their real height, rather than one per row. */}
          {pending.length > 0 ? (
            <div
              role="status"
              aria-label={`Loading ${title.toLowerCase()}`}
              className="flex flex-col gap-px"
            >
              {pending.map((row) => (
                <Skeleton key={row.id} className="h-8" />
              ))}
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

/** The label and detail for a row that is not pending. */
function joinRowParts<T>(
  row: Extract<JoinRowState<T>, { kind: "resolved" | "absent" }>,
  render: (value: T) => { label: string; detail?: string },
): { label: string; detail?: string } {
  if (row.kind === "absent") return { label: row.id, detail: NOT_IN_LIST };
  // A RESOLVED row with nothing to add carries no detail of its own.
  const parts = render(row.row);
  return {
    label: parts.label,
    ...(parts.detail !== undefined ? { detail: parts.detail } : {}),
  };
}

/**
 * The worktree's drift, in the three numbers this page can state honestly. An
 * ABSENT status is not a clean one: the watcher may simply not have reported.
 */
function worktreeDetail(status: WorktreeGitStatus | undefined): string {
  if (!status) return "status unknown";
  const parts: string[] = [];
  if (status.dirty) {
    const files = (status.filesChanged ?? 0) + (status.untracked ?? 0);
    parts.push(`${files} uncommitted ${files === 1 ? "file" : "files"}`);
  }
  const ahead = status.upstream?.ahead ?? 0;
  const behind = status.upstream?.behind ?? 0;
  if (ahead > 0) parts.push(`${ahead} to push`);
  if (behind > 0) parts.push(`${behind} to pull`);
  if (!status.upstream) parts.push("never pushed");
  return parts.length > 0 ? parts.join(" · ") : "clean and in sync";
}

export function PullRequestDetailPage({
  back,
  target,
  state,
  onReload,
  projects,
  joins,
  status,
  onOpenWorktree,
  onOpenSession,
  onOpenTask,
}: Props) {
  const item = dataOf(state) ?? null;
  const error = errorOf(state);

  // R1/R4: nothing has answered yet, so reserve the page rather than claiming
  // this pull request does not exist.
  if (item === null && state.status === "loading") {
    return (
      <Shell back={back} title={`Pull request #${target.number}`}>
        {/* One announcement for the whole page, on the region that reserves
            the blocks' height — never a second one nested inside it. */}
        <div
          role="status"
          aria-label="Loading pull request"
          className="space-y-3"
        >
          <Skeleton className="h-24" />
          <Skeleton className="h-32" />
        </div>
      </Shell>
    );
  }

  if (item === null) {
    return (
      <Shell back={back} title={`Pull request #${target.number}`}>
        {error ? <ErrorNote message={error} onRetry={onReload} /> : null}
        {!error ? (
          <EmptyBox>
            This pull request is not in your inventory. It is listed while it is
            yours, while your review is requested, or while a local worktree
            still holds its branch.
          </EmptyBox>
        ) : null}
      </Shell>
    );
  }

  const project = projects.find((candidate) => candidate.id === item.projectId);
  const ci = pullRequestCiState(item);
  const review = pullRequestReviewState(item);
  const mergeability = pullRequestMergeability(item);
  const pullRequestState = pullRequestStateLabel(item);
  const mergeBlocked = pullRequestMergeBlockedReason(item);
  // The worktree join runs through the SAME three answers as the groups below,
  // so a stale list cannot report a checkout gone.
  const [worktreeRow] = resolveJoinRows(
    item.worktreeId ? [item.worktreeId] : [],
    joins.worktrees,
    (row) => row.id,
  );

  return (
    <Shell
      back={back}
      title={item.title}
      subtitle={
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="font-mono tabular-nums">#{item.number}</span>
          <span aria-hidden>·</span>
          <span>{pullRequestState.label}</span>
          {project ? (
            <>
              <span aria-hidden>·</span>
              <span title={project.name}>{projectDisplayKey(project)}</span>
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate font-mono">
            {item.baseBranch} ← {item.headBranch}
          </span>
        </span>
      }
      actions={
        // R2: a poll keeps the page and marks it, never blanks it.
        isPending(state) ? (
          <RefreshIndicator label="Refreshing pull request" />
        ) : null
      }
    >
      {/* R2: a refresh that failed keeps everything below and adds this. */}
      {error ? <ErrorNote message={error} onRetry={onReload} /> : null}

      <Block title="Status" icon={<CircleDot size={13} />}>
        <Fact label="Checks">
          <span className="flex items-center gap-1.5">
            <CircleDot size={12} aria-hidden className="text-faint" />
            {ci.label}
            {item.ci?.url ? (
              <a
                href={item.ci.url}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline underline-offset-2"
              >
                inspect
              </a>
            ) : null}
          </span>
        </Fact>
        <Fact label="Review">{review.label}</Fact>
        <Fact label="Mergeable">{mergeability.label}</Fact>
        <Fact label="Head">
          <span className="font-mono">
            {item.headSha ? item.headSha.slice(0, 12) : "unknown"}
          </span>
        </Fact>
        {item.author ? <Fact label="Author">{item.author}</Fact> : null}
        {/* Why the panel's Merge is disabled, as TEXT on the page: a disabled
            menu row's tooltip reaches neither a keyboard nor a phone. */}
        {mergeBlocked ? (
          <p className="mt-1 text-sm text-amber-500">{mergeBlocked}</p>
        ) : null}
      </Block>

      <Block title="On this machine" icon={<GitBranch size={13} />}>
        {/* The worktree join, on the same answers as the groups below: no id
            at all is the authoritative none, an id whose list is cold, stale or
            failed reserves, and only a FRESH list may say it is not there. */}
        {joins.worktrees.error && item.worktreeId ? (
          <ErrorNote className="mb-1" message={joins.worktrees.error} />
        ) : null}
        {!worktreeRow ? (
          <EmptyBox variant="inline">
            No local worktree holds {item.headBranch}.
          </EmptyBox>
        ) : worktreeRow.kind === "pending" ? (
          <div role="status" aria-label="Loading the local worktree">
            <Skeleton className="h-8" />
          </div>
        ) : (
          <RelationRow
            icon={<GitBranch size={13} />}
            label={
              worktreeRow.kind === "resolved"
                ? worktreeRow.row.branch
                : item.headBranch
            }
            detail={
              worktreeRow.kind === "resolved"
                ? worktreeDetail(status)
                : NOT_IN_LIST
            }
            onOpen={() => onOpenWorktree(worktreeRow.id)}
          />
        )}

        <JoinGroup
          title="Sessions"
          ids={item.sessionIds}
          source={joins.sessions}
          identify={(session) => session.id}
          icon={<MessagesSquare size={13} />}
          emptyLabel="No sessions are linked to it."
          render={(session) => ({
            label: session.title || "Unlabeled Session",
            ...(session.isStreaming ? { detail: "running" } : {}),
          })}
          onOpen={onOpenSession}
        />

        <JoinGroup
          title="Tasks"
          ids={item.taskIds}
          source={joins.tasks}
          identify={(task) => task.id}
          icon={<ClipboardList size={13} />}
          emptyLabel="No Tasks are linked to it."
          render={(task) => ({ label: task.title, detail: `Task-${task.id}` })}
          onOpen={onOpenTask}
        />
      </Block>
    </Shell>
  );
}

function Shell({
  back,
  title,
  subtitle,
  actions,
  children,
}: {
  back?: PageHeaderBack | undefined;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <PageHeader
        back={back}
        icon={<GitPullRequest size={16} />}
        title={title}
        subtitle={subtitle}
        actions={actions}
      />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {children}
      </div>
    </div>
  );
}
