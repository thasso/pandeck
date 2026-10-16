/**
 * @component PullRequestConversation
 * @purpose The detail page's provider-side reading: the head's checks one by
 * one, the description, the conversation (comments and review verdicts) and
 * the inline review threads.
 * @useWhen Inside `PullRequestDetailPage`, fed by
 * `GET /api/pull-requests/conversation`.
 * @avoidWhen Anything the inventory already states (the CI summary, the
 * review state, mergeability): those are the page's Status block, and this read
 * is allowed to be slower and to fail on its own.
 * @intent What a decision needs from the provider without leaving for it, so
 * every block renders its own load state and failure, and an unknown stays
 * unknown: a thread whose resolution was not reported is listed as open.
 * @related PullRequestDetailPage, pullRequestConversation (lib)
 */
import { useState, type ReactNode } from "react";
import {
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  ExternalLink,
  FileCode2,
  ListChecks,
  MessageSquareText,
  MessagesSquare,
  MinusCircle,
  XCircle,
} from "lucide-react";
import type {
  PullRequestCheck,
  PullRequestCheckTone,
  PullRequestChecks,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestTimelineEntry,
} from "@assistant/shared";
import { Markdown } from "../Markdown.tsx";
import { CodeBlock } from "../common/CodeBlock.tsx";
import { EmptyBox, ErrorNote, Skeleton } from "../common/load.tsx";
import { relativeTime } from "../../lib/sessionRows.ts";
import {
  checkCounts,
  checkCountsLabel,
  hunkTail,
  orderChecks,
  REVIEW_VERDICT_LABEL,
  splitThreads,
} from "../../lib/pullRequestConversation.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { ListGroupSection } from "../ListGroupSection.tsx";

/**
 * One section of the detail page, in the Task page's flat style: a hairline,
 * a small heading with an optional trailing note or control, then the content.
 * No card — the page is one column of reading, not a dashboard.
 */
export function Block({
  title,
  icon,
  aside,
  rule = true,
  children,
}: {
  title: string;
  icon: ReactNode;
  /** Right of the title: a count, a link out, a compact action. */
  aside?: ReactNode;
  /** The hairline above; off where an action row above already draws one. */
  rule?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={rule ? "border-t border-border/60 pt-3" : ""}>
      <div className="mb-2 flex min-h-6 min-w-0 items-center gap-2">
        <h2 className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span aria-hidden className="shrink-0">
            {icon}
          </span>
          {title}
        </h2>
        {aside ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            {aside}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** A block whose read has not answered: its real shape, not a spinner. */
export function BlockSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-1.5">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  );
}

function OutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline"
    >
      {children}
      <ExternalLink size={11} aria-hidden />
    </a>
  );
}

/* --------------------------------- checks --------------------------------- */

const CHECK_ICON: Record<PullRequestCheckTone, ReactNode> = {
  failure: <XCircle size={13} className="text-destructive" />,
  pending: <CircleDashed size={13} className="text-primary" />,
  success: <CheckCircle2 size={13} className="text-success" />,
  neutral: <MinusCircle size={13} className="text-muted-foreground" />,
  skipped: <CircleSlash size={13} className="text-muted-foreground" />,
};

const CHECK_WORD: Record<PullRequestCheckTone, string> = {
  failure: "failed",
  pending: "running",
  success: "passed",
  neutral: "neutral",
  skipped: "skipped",
};

/** How many settled checks show before the rest fold away. */
const SETTLED_SHOWN = 4;

function CheckRow({ check }: { check: PullRequestCheck }) {
  const body = (
    <>
      <span aria-hidden className="mt-0.5 shrink-0">
        {CHECK_ICON[check.tone]}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">
          {check.name}
        </span>
        {check.summary && check.tone !== "success" ? (
          <span className="block truncate text-xs text-muted-foreground">
            {check.summary}
          </span>
        ) : null}
      </span>
      <span className="sr-only">{CHECK_WORD[check.tone]}</span>
      {check.url ? (
        <ExternalLink
          size={11}
          aria-hidden
          className="mt-1 shrink-0 text-muted-foreground"
        />
      ) : null}
    </>
  );
  const className = "flex items-start gap-2 rounded-md px-1.5 py-1";
  return check.url ? (
    <a
      href={check.url}
      target="_blank"
      rel="noreferrer"
      className={`${className} hover:bg-muted`}
    >
      {body}
    </a>
  ) : (
    <div className={className}>{body}</div>
  );
}

export function ChecksBlock({
  checks,
  error,
  pending,
  onRetry,
  rule,
}: {
  rule?: boolean;
  checks: PullRequestChecks | undefined;
  error: string | undefined;
  /** The read has not answered yet. */
  pending: boolean;
  onRetry: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const ordered = checks ? orderChecks(checks.items) : [];
  const counts = checkCounts(ordered);
  const attention = ordered.filter(
    (check) => check.tone === "failure" || check.tone === "pending",
  );
  const settled = ordered.filter(
    (check) => check.tone !== "failure" && check.tone !== "pending",
  );
  const shownSettled = showAll ? settled : settled.slice(0, SETTLED_SHOWN);
  const hidden = settled.length - shownSettled.length;
  return (
    <Block
      title="Checks"
      icon={<ListChecks size={13} />}
      {...(rule !== undefined ? { rule } : {})}
      aside={checks && ordered.length > 0 ? checkCountsLabel(counts) : null}
    >
      {error ? <ErrorNote message={error} onRetry={onRetry} /> : null}
      {!checks ? (
        pending ? (
          <BlockSkeleton label="Loading checks" />
        ) : null
      ) : ordered.length === 0 ? (
        <EmptyBox variant="inline">
          No checks ran on {checks.headSha.slice(0, 7)}.
        </EmptyBox>
      ) : (
        <div className="-mx-1.5 flex flex-col">
          {attention.map((check) => (
            <CheckRow key={`${check.tone}:${check.name}`} check={check} />
          ))}
          {shownSettled.map((check) => (
            <CheckRow key={`${check.tone}:${check.name}`} check={check} />
          ))}
          {hidden > 0 ? (
            <Button
              variant="ghost"
              size="xs"
              className="mt-0.5 self-start"
              onClick={() => setShowAll(true)}
            >
              Show {hidden} more
            </Button>
          ) : null}
          {checks.total !== undefined && checks.total > ordered.length ? (
            <p className="px-1.5 pt-1 text-xs text-muted-foreground">
              {checks.total - ordered.length} more not read.
            </p>
          ) : null}
        </div>
      )}
    </Block>
  );
}

/* ------------------------------ description ------------------------------- */

/**
 * Markdown written on the provider, always in full: a pull request page is
 * read top to bottom, and a fold in the middle of a comment hid exactly the
 * part a reviewer meant. The page scrolls; nothing here clips.
 */
export function ProviderMarkdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 text-foreground">
      <Markdown text={text} density="compact" />
    </div>
  );
}

/* ------------------------------ conversation ------------------------------ */

/**
 * A message's text under its band, inside the message's card
 * (`ListGroupSection`'s `card`), with more room under the last line than over
 * the first.
 */
const COMMENT_BODY = "px-3 pt-2.5 pb-4";

/** When a message was written, and the way to it on the provider: a band's
 *  right edge for every comment, review and reply. */
function EntryMeta({
  createdAt,
  url,
  compact = false,
}: {
  createdAt?: number | undefined;
  url?: string | undefined;
  compact?: boolean;
}) {
  return (
    <>
      {createdAt ? (
        <span className="text-xs opacity-70">{relativeTime(createdAt)}</span>
      ) : null}
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label="Open this on the provider"
          className={`flex items-center justify-center rounded-sm opacity-70 hover:opacity-100 ${compact ? "size-5" : "size-6"}`}
        >
          <ExternalLink size={12} aria-hidden />
        </a>
      ) : null}
    </>
  );
}

const VERDICT_ICON: Record<PullRequestReviewVerdict, typeof MessagesSquare> = {
  approved: CheckCircle2,
  "changes-requested": XCircle,
  commented: MessagesSquare,
  dismissed: CircleSlash,
};

/**
 * One comment or review, as a group of the page — the same band the review
 * threads and the lists use: who wrote it and, for a review, its verdict as
 * the glyph; when and the way to it on the provider beside the toggle; the
 * text in full under it.
 */
function TimelineItem({ entry }: { entry: PullRequestTimelineEntry }) {
  const verdict = entry.kind === "review" ? entry.verdict : undefined;
  const Icon = verdict ? VERDICT_ICON[verdict] : MessageSquareText;
  const body = entry.body.trim();
  return (
    <ListGroupSection
      id={`pr-entry:${entry.kind}:${entry.id}`}
      card
      title={entry.author ?? "unknown"}
      icon={
        <Icon
          size={14}
          aria-hidden
          className={`shrink-0 ${
            verdict === "approved"
              ? "text-success"
              : verdict === "changes-requested"
                ? "text-destructive"
                : ""
          }`}
        />
      }
      actions={
        <>
          {verdict ? (
            <Badge variant="outline">{REVIEW_VERDICT_LABEL[verdict]}</Badge>
          ) : null}
          <EntryMeta createdAt={entry.createdAt} url={entry.url} />
        </>
      }
    >
      {body || (entry.kind === "review" && entry.threadComments) ? (
        <div className={`flex min-w-0 flex-col gap-1 ${COMMENT_BODY}`}>
          {body ? <ProviderMarkdown text={body} /> : null}
          {entry.kind === "review" && entry.threadComments ? (
            <p className="text-xs text-muted-foreground">
              {entry.threadComments} inline{" "}
              {entry.threadComments === 1 ? "comment" : "comments"}, in the
              review threads below
            </p>
          ) : null}
        </div>
      ) : null}
    </ListGroupSection>
  );
}

export function TimelineBlock({
  timeline,
  truncated,
  pending,
  url,
}: {
  timeline: PullRequestTimelineEntry[] | undefined;
  truncated: boolean;
  pending: boolean;
  /** The pull request on the provider, for what was not read. */
  url: string;
}) {
  return (
    <Block
      title="Conversation"
      icon={<MessagesSquare size={13} />}
      aside={timeline && timeline.length > 0 ? `${timeline.length}` : null}
    >
      {timeline === undefined ? (
        pending ? (
          <BlockSkeleton label="Loading the conversation" />
        ) : (
          <EmptyBox variant="inline">
            The conversation could not be read.
          </EmptyBox>
        )
      ) : timeline.length === 0 ? (
        <EmptyBox variant="inline">No comments or reviews yet.</EmptyBox>
      ) : (
        <>
          {truncated ? (
            <p className="mb-1 text-xs text-muted-foreground">
              Showing the latest {timeline.length}.{" "}
              <OutLink href={url}>Earlier ones on the provider</OutLink>
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            {timeline.map((entry) => (
              <TimelineItem key={`${entry.kind}:${entry.id}`} entry={entry} />
            ))}
          </div>
        </>
      )}
    </Block>
  );
}

/* ----------------------------- review threads ----------------------------- */

/**
 * One review thread, as a group of the page: the band names where it was
 * written and how many messages it holds, folds it away, and says whether it
 * still stands; under it the code it hangs off, then its messages divided by
 * hairlines. A resolved thread starts folded — it is settled, not hidden.
 */
function ThreadSection({ thread }: { thread: PullRequestReviewThread }) {
  const location = `${thread.path}${thread.line ? `:${thread.line}` : ""}`;
  return (
    <ListGroupSection
      id={`pr-thread:${thread.id}`}
      // The whole thread is one card; its messages run flush inside it.
      card
      title={location}
      count={thread.comments.length}
      icon={<FileCode2 size={14} className="shrink-0" aria-hidden />}
      defaultOpen={thread.resolved !== true}
      actions={
        <>
          {thread.outdated ? <Badge variant="outline">outdated</Badge> : null}
          {thread.resolved ? <Badge variant="outline">resolved</Badge> : null}
          {thread.url ? (
            <a
              href={thread.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open the thread on ${location} on the provider`}
              className="flex size-6 items-center justify-center rounded-sm opacity-70 hover:opacity-100"
            >
              <ExternalLink size={12} aria-hidden />
            </a>
          ) : null}
        </>
      }
    >
      {thread.diffHunk ? (
        // Highlighted as a diff — what was added and removed, which is the
        // question a review thread hangs off — by the same cached Shiki the
        // transcript's code uses.
        // No rule under it: the reply cards that follow have their own edges,
        // and a line here read as the first card's top.
        // Edge to edge in the thread's card: the code is the card's middle,
        // not a block set inside it.
        <div className="text-xs [&_pre]:rounded-none">
          <CodeBlock code={hunkTail(thread.diffHunk)} language="diff" />
        </div>
      ) : null}
      {/* Each message is its own band, as every comment and review on this
          page is — not pinned, or it would stack under the thread's. */}
      <div className="flex flex-col">
        {thread.comments.map((comment) => (
          <ListGroupSection
            key={comment.id}
            id={`pr-thread-comment:${comment.id}`}
            title={comment.author ?? "unknown"}
            icon={
              <MessageSquareText size={12} className="shrink-0" aria-hidden />
            }
            sticky={false}
            compact
            actions={
              <EntryMeta
                createdAt={comment.createdAt}
                url={comment.url}
                compact
              />
            }
          >
            <div className={`min-w-0 ${COMMENT_BODY}`}>
              <ProviderMarkdown text={comment.body} />
            </div>
          </ListGroupSection>
        ))}
      </div>
      {thread.truncated ? (
        <p className="border-t border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
          More replies on the provider.
        </p>
      ) : null}
    </ListGroupSection>
  );
}

export function ThreadsBlock({
  threads,
  total,
  pending,
  url,
}: {
  threads: PullRequestReviewThread[] | undefined;
  total: number | undefined;
  pending: boolean;
  url: string;
}) {
  const split = threads ? splitThreads(threads) : { open: [], resolved: [] };
  return (
    <Block
      title="Review threads"
      icon={<FileCode2 size={13} />}
      aside={
        threads && threads.length > 0
          ? `${split.open.length} open · ${split.resolved.length} resolved`
          : null
      }
    >
      {threads === undefined ? (
        pending ? (
          <BlockSkeleton label="Loading review threads" />
        ) : (
          <EmptyBox variant="inline">
            The review threads could not be read.
          </EmptyBox>
        )
      ) : threads.length === 0 ? (
        <EmptyBox variant="inline">No inline review comments.</EmptyBox>
      ) : (
        <div className="flex flex-col gap-2">
          {/* Open threads first: they still want an answer. */}
          {[...split.open, ...split.resolved].map((thread) => (
            <ThreadSection key={thread.id} thread={thread} />
          ))}
          {total !== undefined && total > threads.length ? (
            <p className="pt-2 text-xs text-muted-foreground">
              {total - threads.length} more on the provider.{" "}
              <OutLink href={`${url}/files`}>Open the review</OutLink>
            </p>
          ) : null}
        </div>
      )}
    </Block>
  );
}
