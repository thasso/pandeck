/**
 * @component PullRequestDetailPage
 * @purpose Main-pane page for ONE pull request: what the provider says about
 * it, and what it is joined to on this machine.
 * @useWhen The route is `/pull-requests/:projectId/:number`.
 * @avoidWhen Listing pull requests — that is `PullRequestBrowser`, the
 * section's sidebar browser.
 * @intent The page a decision is made on, so every claim it makes is sourced
 * and an unknown is shown as unknown: absence on the wire means the provider
 * was not reached, and `mergeable: null` means "ask again", never "conflicts".
 * It says why the pull request is in your list, and offers each act WHERE it
 * states what the act would change — Create worktree beside "no worktree",
 * Clean up beside a merged pull request's leftover checkout — through the same
 * `PullRequestActionsProvider` the object panel reads, so the two never hold
 * two busy states or two dialogs. Its facts come from the app's one inventory
 * (`hooks/usePullRequestInventory.ts`), so the list and the page cannot
 * disagree; the description, conversation and individual checks are a second,
 * on-demand read (`conversation`), each block with its own load state.
 * @related PullRequestBrowser, PullRequestInspector, PullRequestActions,
 * PullRequestConversation, pullRequestInbox (lib), WorktreeDetailPage
 */
import { useMemo, useState, type ReactNode } from "react";
import {
  CircleDot,
  ClipboardList,
  ExternalLink,
  FolderKanban,
  Eye,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  GitPullRequest,
  Info,
  MessageSquarePlus,
} from "lucide-react";
import type {
  ProjectRecord,
  PullRequestConversationResponse,
  PullRequestInventoryItem,
  PullRequestTimelineEntry,
  SessionListItem,
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
  type PullRequestMergeabilityTone,
  hostingProviderLabel,
  pullRequestCiState,
  pullRequestMergeability,
  pullRequestMergeBlockedReason,
  pullRequestSessionIds,
  pullRequestSessionTree,
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
import { Button } from "../ui/button.tsx";
import { usePullRequestConversation } from "../../hooks/usePullRequestConversation.ts";
import { reviewStatusOf } from "../../lib/pullRequestConversation.ts";
import { usePullRequestActions } from "./PullRequestActions.tsx";
import { SpawnedSessionLedgeRow } from "../SpawnedSessionsLedge.tsx";
import { useElapsedNow } from "../useElapsedNow.ts";
import {
  classifySessionStatus,
  tierForStatus,
  type SessionInboxCard,
} from "../../lib/sessionInbox.ts";
import { ActionRow } from "../common/ActionRow.tsx";
import {
  DateProperty,
  PropertyLabel,
  PropertyList,
  PropertyText,
} from "../common/PropertyList.tsx";
import { AppCard } from "../common/AppCard.tsx";
import {
  Block,
  BlockSkeleton,
  ChecksBlock,
  ProviderMarkdown,
  ThreadsBlock,
  TimelineBlock,
} from "./PullRequestConversation.tsx";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../ui/item.tsx";

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
  /**
   * The on-demand read of description, conversation, threads and checks. Its
   * failure is its own: the inventory's facts above stay readable.
   */
  conversation: LoadState<PullRequestConversationResponse>;
  onReloadConversation: () => void;
  onOpenWorktree: (worktreeId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenTask: (taskId: string) => void;
}

/** Mergeability as the answer to "can it be merged?". */
const MERGEABLE_ANSWER: Record<PullRequestMergeabilityTone, string> = {
  mergeable: "Yes",
  conflicts: "No — conflicts with the base branch",
  checking: "Checking…",
  unknown: "Unknown",
  "not-applicable": "—",
};

/**
 * The Review fact: where review STANDS — changes requested, approved, or
 * unreviewed — from the conversation's verdicts once it is read
 * (`reviewStatusOf`), and from the inventory's summary until then. Unresolved
 * threads are added when the provider counted any.
 */
function reviewStatusText(
  timeline: PullRequestTimelineEntry[] | undefined,
  review: PullRequestInventoryItem["review"],
  reviewRequested: boolean,
): { text: string; className: string } {
  const threads = review?.unresolvedThreads ?? 0;
  const suffix =
    threads > 0
      ? ` · ${threads} unresolved ${threads === 1 ? "thread" : "threads"}`
      : "";
  if (timeline) {
    const status = reviewStatusOf(timeline);
    if (status.kind === "changes-requested")
      return {
        text: `Changes requested by ${status.by.join(", ")}${suffix}`,
        className: "text-destructive",
      };
    if (status.kind === "approved")
      return {
        text: `Approved by ${status.by.join(", ")}${suffix}`,
        className: "text-success",
      };
    return {
      text: `${reviewRequested ? "Unreviewed — your review is requested" : "Unreviewed"}${suffix}`,
      className: "",
    };
  }
  if (review?.changesRequested)
    return {
      text: `Changes requested${suffix}`,
      className: "text-destructive",
    };
  return { text: review ? `Not yet known${suffix}` : "Unknown", className: "" };
}

/** A part of "On this machine": its name, and the acts that add to it. */
function SubHeading({
  title,
  actions,
  first = false,
}: {
  title: string;
  actions?: ReactNode;
  first?: boolean;
}) {
  return (
    <div
      className={`mb-1 flex min-h-6 items-center gap-2 ${first ? "" : "mt-3"}`}
    >
      <h3 className="flex-1 text-xs font-medium text-muted-foreground">
        {title}
      </h3>
      {actions ? (
        <span className="flex shrink-0 items-center gap-3">{actions}</span>
      ) : null}
    </div>
  );
}

/** An act inline in a heading: a link-weight control, not a button block. */
function InlineAction({
  icon,
  label,
  busy = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="link"
      size="xs"
      // The page's quiet act colour — the same as Merge & clean up's — so
      // every act on the page reads alike: muted until pointed at.
      className="h-auto px-0 text-xs text-muted-foreground hover:text-foreground"
      busy={busy}
      onClick={onClick}
    >
      {icon}
      {label}
    </Button>
  );
}

/** Rows of the session tree shown before "Show N more". */
const SESSIONS_SHOWN = 5;

/**
 * The pull request's sessions as the app lists sessions elsewhere: the
 * inspector's expandable rows (`SpawnedSessionLedgeRow` — agent, model,
 * worktree, age and Open under the chevron), each linked session inside its
 * whole spawn tree (`pullRequestSessionTree`), so the coordinator and the
 * peers around it are there too. A long tree shows its first rows and the
 * rest behind "Show N more".
 *
 * The join's answers still hold: no ids is the only "none", an id the list
 * has not answered for reserves a row, and only a FRESH list may say an id is
 * not in it (an archived session).
 */
function SessionTreeGroup({
  item,
  source,
  actions,
  onOpenSession,
}: {
  item: Pick<PullRequestInventoryItem, "worktreeId" | "sessionIds">;
  source: JoinSource<SessionListItem>;
  actions?: ReactNode;
  onOpenSession: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const sessions = source.rows;
  const { worktreeId, sessionIds } = item;
  const ids = useMemo(
    () => pullRequestSessionIds({ worktreeId, sessionIds }, sessions),
    [worktreeId, sessionIds, sessions],
  );
  const joined = resolveJoinRows(ids, source, (row) => row.id);
  const pending = joined.filter((row) => row.kind === "pending");
  const absent = joined.filter((row) => row.kind === "absent");
  const cards = useMemo(
    () =>
      sessions
        ? pullRequestSessionTree(sessions, ids).map((row) => {
            const status = classifySessionStatus(row.session);
            const card: SessionInboxCard = {
              session: row.session,
              status,
              tier: tierForStatus(status),
              depth: row.depth,
            };
            return {
              card,
              facts: row.linked
                ? [{ label: "Pull request", value: "Linked to this one" }]
                : undefined,
            };
          })
        : [],
    [sessions, ids],
  );
  const now = useElapsedNow(
    cards.some(({ card }) => card.status === "running"),
  );
  const shown = showAll ? cards : cards.slice(0, SESSIONS_SHOWN);
  const hidden = cards.length - shown.length;
  return (
    <>
      <SubHeading title="Sessions" actions={actions} />
      {ids.length > 0 && source.error ? (
        <ErrorNote className="mb-1" message={source.error} />
      ) : null}
      {ids.length === 0 ? (
        <p className="py-1 text-sm text-muted-foreground">
          No sessions are linked to it.
        </p>
      ) : (
        <>
          {shown.length > 0 ? (
            <ul className="divide-y border-y border-border/60">
              {shown.map(({ card, facts }) => (
                <SpawnedSessionLedgeRow
                  key={card.session.id}
                  card={card}
                  facts={facts}
                  now={now}
                  onOpen={onOpenSession}
                />
              ))}
            </ul>
          ) : null}
          {absent.map((row) => (
            <p key={row.id} className="py-1 text-sm text-muted-foreground">
              {row.id} — {NOT_IN_LIST}
            </p>
          ))}
          {pending.length > 0 ? (
            <div
              role="status"
              aria-label="Loading sessions"
              className="flex flex-col gap-px"
            >
              {pending.map((row) => (
                <Skeleton key={row.id} className="h-8" />
              ))}
            </div>
          ) : null}
          {hidden > 0 || showAll ? (
            <Button
              variant="link"
              size="xs"
              className="mt-1 h-auto px-0 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? "Show fewer" : `Show ${hidden} more`}
            </Button>
          ) : null}
        </>
      )}
    </>
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
    <Item
      size="xs"
      render={<button type="button" />}
      onClick={onOpen}
      className="flex-nowrap text-left"
    >
      <ItemMedia variant="icon" aria-hidden>
        {icon}
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full">
          <span className="truncate">{label}</span>
        </ItemTitle>
      </ItemContent>
      {detail ? <ItemDescription>{detail}</ItemDescription> : null}
    </Item>
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
  actions,
}: {
  /** The acts that add to this group, inline at the heading's right. */
  actions?: ReactNode;
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
      <SubHeading title={title} actions={actions} />
      {/* R2: the retained rows below stay, and the failure sits beside them. */}
      {ids.length > 0 && source.error ? (
        <ErrorNote className="mb-1" message={source.error} />
      ) : null}
      {ids.length === 0 ? (
        <p className="py-1 text-sm text-muted-foreground">{emptyLabel}</p>
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
  conversation,
  onReloadConversation,
  onOpenWorktree,
  onOpenSession,
  onOpenTask,
}: Props) {
  const item = dataOf(state) ?? null;
  const error = errorOf(state);
  const acts = usePullRequestActions(item);

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
            This pull request is not in your inventory. It is listed while you
            opened it, are assigned, or are asked to review it (yourself or
            through a team), or while a local worktree still holds its branch.
          </EmptyBox>
        ) : null}
      </Shell>
    );
  }

  const project = projects.find((candidate) => candidate.id === item.projectId);
  const ci = pullRequestCiState(item);
  const mergeability = pullRequestMergeability(item);
  const pullRequestState = pullRequestStateLabel(item);
  const mergeBlocked = pullRequestMergeBlockedReason(item);
  const open = item.state === "open";
  const providerLabel = hostingProviderLabel(item.provider);
  // The worktree join runs through the SAME three answers as the groups below,
  // so a stale list cannot report a checkout gone.
  const [worktreeRow] = resolveJoinRows(
    item.worktreeId ? [item.worktreeId] : [],
    joins.worktrees,
    (row) => row.id,
  );
  const talk = dataOf(conversation);
  const talkPending = talk === undefined && !errorOf(conversation);
  const talkError = errorOf(conversation);

  /** The Task page's quiet action-row button: ghost, small, muted. */
  const quiet = "text-muted-foreground";
  const mergeLabel = acts?.merge.suspended
    ? "Check again"
    : open
      ? "Merge & clean up…"
      : "Clean up…";
  const mergeAvailable = Boolean(acts && (open || item.worktreeId));
  const mergeDisabled = Boolean(mergeBlocked) && !acts?.merge.suspended;
  const worktreeActions =
    acts && open && !item.worktreeId ? (
      <InlineAction
        icon={<GitBranchPlus />}
        label="Create worktree"
        busy={acts.checkout.busy}
        onClick={acts.checkout.start}
      />
    ) : null;
  const sessionActions =
    acts && (item.worktreeId || open) ? (
      <>
        {item.worktreeId ? (
          <InlineAction
            icon={<MessageSquarePlus />}
            label="Start session"
            onClick={() => acts.startSession(item.worktreeId!)}
          />
        ) : null}
        {open ? (
          <InlineAction
            icon={<Eye />}
            label="Review in a session"
            busy={acts.review.busy}
            onClick={acts.review.start}
          />
        ) : null}
      </>
    ) : null;

  const ciClass =
    ci.tone === "success"
      ? "text-success"
      : ci.tone === "failure" || ci.tone === "error"
        ? "text-destructive"
        : ci.tone === "pending"
          ? "text-primary"
          : "";
  const reviewStatus = reviewStatusText(
    talk?.timeline,
    item.review,
    item.reviewRequested,
  );
  const reviewers = talk?.requestedReviewers
    ? [
        ...talk.requestedReviewers.users,
        ...talk.requestedReviewers.teams.map((team) => `@${team}`),
      ]
    : [];

  return (
    <Shell
      back={back}
      title={
        <span className="min-w-0 truncate font-mono text-sm text-muted-foreground">
          {item.repositoryKey}#{item.number}
        </span>
      }
      actions={
        <>
          {/* R2: a poll keeps the page and marks it, never blanks it. */}
          {isPending(state) ? (
            <RefreshIndicator label="Refreshing pull request" />
          ) : null}
        </>
      }
    >
      {/* R2: a refresh that failed keeps everything below and adds this. */}
      {error ? <ErrorNote message={error} onRetry={onReload} /> : null}

      {/* Identity, as the Task page has it: the full title, then ONE line of
          essentials — where it stands, where it lives, whether CI is green,
          and the way to the provider. The rest is the Details list below. */}
      <div className="flex flex-col gap-1.5">
        <h1 className="text-lg font-semibold text-foreground">{item.title}</h1>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <GitPullRequest size={14} aria-hidden />
            {pullRequestState.label}
          </span>
          {project ? (
            <span
              className="inline-flex items-center gap-1.5"
              title={project.name}
            >
              <FolderKanban size={14} aria-hidden />
              {projectDisplayKey(project)}
            </span>
          ) : null}
          {open ? (
            <span className={`inline-flex items-center gap-1.5 ${ciClass}`}>
              <CircleDot size={14} aria-hidden />
              {ci.label}
            </span>
          ) : null}
          {/* The way to the provider, read as a fact like a Task's ticket:
              most of what is not on this page is one click away there. */}
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 text-foreground underline underline-offset-3 hover:text-primary"
          >
            <ExternalLink size={14} aria-hidden />
            {providerLabel}
          </a>
        </div>
        {/* Why Merge is disabled, as TEXT on the page: a disabled control's
            tooltip reaches neither a keyboard nor a phone. */}
        {open && mergeBlocked ? (
          <p className="text-sm text-warning">{mergeBlocked}</p>
        ) : null}
      </div>

      {/* A finished pull request is listed for ONE reason — its checkout —
          so the way to end that is a decision card, as the Task page asks
          for its decisions. */}
      {!open && item.worktreeId ? (
        <AppCard
          role="status"
          tone="info"
          icon={<GitMerge />}
          label="Cleanup"
          actions={
            mergeAvailable && acts ? (
              <Button
                size="xs"
                busy={acts.merge.busy}
                disabled={mergeDisabled}
                onClick={acts.merge.open}
              >
                <GitMerge />
                {mergeLabel}
              </Button>
            ) : null
          }
        >
          <p>
            {item.state === "merged" ? "Merged" : "Closed without merging"}. The
            local worktree on{" "}
            <span className="font-mono">{item.headBranch}</span> is all that
            keeps it in your list.
          </p>
        </AppCard>
      ) : null}

      {/* The description IS the page's body, as on a Task: no heading. */}
      <section aria-label="Description">
        {talk?.errors?.conversation ? (
          <ErrorNote
            message={talk.errors.conversation}
            onRetry={onReloadConversation}
          />
        ) : null}
        {talkError ? (
          <ErrorNote
            message={`The description and conversation could not be read: ${talkError}`}
            onRetry={onReloadConversation}
          />
        ) : null}
        <div className="min-h-16 py-1">
          {talk?.body === undefined ? (
            talkPending ? (
              <BlockSkeleton label="Loading the description" />
            ) : null
          ) : talk.body.trim() ? (
            <ProviderMarkdown text={talk.body} />
          ) : (
            <span className="text-sm text-muted-foreground">
              No description provided.
            </span>
          )}
        </div>
        {open && mergeAvailable && acts ? (
          <ActionRow>
            <Button
              variant="ghost"
              size="xs"
              className={quiet}
              busy={acts.merge.busy}
              // Asking what happened is never the blocked thing.
              disabled={mergeDisabled}
              onClick={acts.merge.open}
            >
              <GitMerge />
              {mergeLabel}
            </Button>
          </ActionRow>
        ) : null}
      </section>

      <Block
        title="Details"
        icon={<Info size={13} />}
        // The description's action row above already draws the line.
        rule={!(open && mergeAvailable)}
      >
        <PropertyList align="start">
          <PropertyLabel>Branches</PropertyLabel>
          <PropertyText className="font-mono text-xs">
            {item.baseBranch} ← {item.headBranch}
          </PropertyText>
          {item.author ? (
            <>
              <PropertyLabel>Author</PropertyLabel>
              <PropertyText>{item.author}</PropertyText>
            </>
          ) : null}
          {talk?.assignees?.length ? (
            <>
              <PropertyLabel>Assignees</PropertyLabel>
              <PropertyText>{talk.assignees.join(", ")}</PropertyText>
            </>
          ) : null}
          {reviewers.length > 0 ? (
            <>
              <PropertyLabel>Reviewers</PropertyLabel>
              <PropertyText>{reviewers.join(", ")}</PropertyText>
            </>
          ) : null}
          {open ? (
            <>
              <PropertyLabel>Checks</PropertyLabel>
              <PropertyText className={ciClass}>
                {ci.label}
                {item.ci?.url ? (
                  <>
                    {" · "}
                    <a
                      href={item.ci.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-muted-foreground underline underline-offset-3 hover:text-primary"
                    >
                      inspect
                    </a>
                  </>
                ) : null}
              </PropertyText>
              <PropertyLabel>Review</PropertyLabel>
              <PropertyText className={reviewStatus.className}>
                {reviewStatus.text}
              </PropertyText>
              <PropertyLabel>Mergeable</PropertyLabel>
              <PropertyText
                className={
                  mergeability.tone === "conflicts" ? "text-destructive" : ""
                }
              >
                {MERGEABLE_ANSWER[mergeability.tone]}
              </PropertyText>
            </>
          ) : null}
          {item.headSha ? (
            <>
              <PropertyLabel>Head</PropertyLabel>
              <PropertyText className="font-mono text-xs" title={item.headSha}>
                {item.headSha.slice(0, 12)}
              </PropertyText>
            </>
          ) : null}
          {talk?.createdAt ? (
            <>
              <PropertyLabel>Opened</PropertyLabel>
              <DateProperty date={{ ms: talk.createdAt, dateOnly: false }} />
            </>
          ) : null}
          {item.updatedAt ? (
            <>
              <PropertyLabel>Updated</PropertyLabel>
              <DateProperty date={{ ms: item.updatedAt, dateOnly: false }} />
            </>
          ) : null}
        </PropertyList>
      </Block>

      <Block title="On this machine" icon={<GitBranch size={13} />}>
        {/* The worktree join, on the same answers as the groups below: no id
            at all is the authoritative none, an id whose list is cold, stale or
            failed reserves, and only a FRESH list may say it is not there. */}
        <SubHeading title="Worktree" actions={worktreeActions} first />
        {joins.worktrees.error && item.worktreeId ? (
          <ErrorNote className="mb-1" message={joins.worktrees.error} />
        ) : null}
        {!worktreeRow ? (
          <p className="py-1 text-sm text-muted-foreground">
            No local worktree holds {item.headBranch}.
          </p>
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

        <SessionTreeGroup
          item={item}
          source={joins.sessions}
          actions={sessionActions}
          onOpenSession={onOpenSession}
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

      <ChecksBlock
        checks={talk?.checks}
        error={talk?.errors?.checks}
        pending={talkPending}
        onRetry={onReloadConversation}
      />
      <TimelineBlock
        timeline={talk?.timeline}
        truncated={talk?.timelineTruncated === true}
        pending={talkPending}
        url={item.url}
      />
      <ThreadsBlock
        threads={talk?.threads}
        total={talk?.threadsTotal}
        pending={talkPending}
        url={item.url}
      />
    </Shell>
  );
}

/**
 * The route's page: the page above plus its own conversation read, which only
 * a mounted detail page performs. Stories render `PullRequestDetailPage` with
 * a fixture instead.
 */
export function PullRequestDetailRoute(
  props: Omit<Props, "conversation" | "onReloadConversation">,
) {
  const conversation = usePullRequestConversation(
    props.target,
    dataOf(props.state) ?? null,
  );
  return (
    <PullRequestDetailPage
      {...props}
      conversation={conversation.state}
      onReloadConversation={conversation.reload}
    />
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
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PageHeader
        back={back}
        density="compact"
        icon={<GitPullRequest size={16} />}
        title={title}
        subtitle={subtitle}
        actions={actions}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-6">
          {children}
        </div>
      </div>
    </div>
  );
}
