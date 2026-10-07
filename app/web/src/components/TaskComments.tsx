import { useState } from "react";
import { Bot, ChevronDown, MessageSquare, User } from "lucide-react";
import { Badge } from "./ui/badge.tsx";
import { Card } from "./ui/card.tsx";
import { Separator } from "./ui/separator.tsx";
import { IconButton } from "./common/IconButton.tsx";
import type { TaskComment, TaskCommentAuthorKind } from "@assistant/shared";
import { sessionPath } from "../lib/sessionRoutes.ts";
import { CommentBody } from "./common/CommentBody.tsx";
import { CommentComposer } from "./common/CommentComposer.tsx";
import { ErrorNote, RefreshIndicator, Skeleton } from "./common/load.tsx";
import {
  dataOf,
  errorOf,
  idle,
  isPending,
  type LoadState,
} from "../lib/loadState.ts";

/**
 * @component TaskComments
 * @purpose Render a Task's append-only, chronological activity trace (comments
 * left by the user and agents) and a composer to add a new comment.
 * @useWhen Showing `UIState.taskComments[taskId]` in the Task detail surface.
 * @avoidWhen Owning protocol state — comments arrive as authoritative
 * `taskComments` broadcasts and are added via a `useAssistant` action.
 * @intent Presentational and flat: oldest-first list, author kind badge, no
 * threading/resolve/edit/delete (an auditable trace). The composer is the shared
 * `common/CommentComposer` — the same one row a document's comment tray uses.
 * @related TaskManagementPage, DocumentComments.
 */
export function TaskComments({
  state,
  mutation,
  onRetry,
  onAddComment,
}: {
  state: LoadState<TaskComment[]>;
  mutation?: LoadState<true> | undefined;
  onRetry: () => void;
  onAddComment: (body: string) => void;
}) {
  const comments = dataOf(state);
  const error = errorOf(state);
  return (
    <div className="flex flex-col gap-3">
      {state.status === "loading" || state.status === "idle" ? (
        <div
          role="status"
          aria-label="Loading Task activity"
          className="flex flex-col gap-3"
        >
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : null}
      {state.status === "refreshing" ? (
        <RefreshIndicator label="Refreshing Task activity" />
      ) : null}
      {error ? <ErrorNote message={error} onRetry={onRetry} /> : null}
      {comments ? (
        comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No activity yet. Add the first comment below.
          </p>
        ) : (
          <ul>
            {comments.map((comment) => (
              <li key={comment.id}>
                <CommentCard comment={comment} />
              </li>
            ))}
          </ul>
        )
      ) : null}
      <CommentComposer
        onSubmit={onAddComment}
        ariaLabel="Add a Task comment"
        busy={isPending(mutation ?? idle())}
        error={errorOf(mutation ?? idle())}
        deferUntilSettled
      />
    </div>
  );
}

/** Count for the section header summary. */
export function taskCommentCount(comments: TaskComment[] | undefined): number {
  return comments?.length ?? 0;
}

function CommentCard({ comment }: { comment: TaskComment }) {
  const [collapsed, setCollapsed] = useState(false);
  const bodyId = `task-comment-body-${comment.id}`;

  return (
    <Card className="mb-2 gap-2 p-3">
      <Separator />
      <div className="flex min-w-0 items-center gap-1.5">
        <AuthorBadge kind={comment.author.kind} />
        {comment.author.kind === "agent" && comment.author.sessionId ? (
          <a
            href={sessionPath(comment.author.sessionId)}
            className="min-w-0 truncate text-sm font-medium text-primary hover:underline"
            title={`Open ${comment.author.name}'s session`}
          >
            {comment.author.name}
          </a>
        ) : (
          <span className="truncate text-sm font-medium text-foreground">
            {comment.author.name}
          </span>
        )}
        <time
          className="ml-auto shrink-0 text-xs text-muted-foreground"
          dateTime={dateTimeWhen(comment.createdAt)}
        >
          {formatWhen(comment.createdAt)}
        </time>
        <IconButton
          label={collapsed ? "Expand comment" : "Collapse comment"}
          size="icon-xs"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ChevronDown className={collapsed ? "-rotate-90" : ""} />
        </IconButton>
      </div>
      {!collapsed ? (
        <CommentBody
          id={bodyId}
          body={comment.body}
          className="mt-3 text-muted-foreground"
        />
      ) : null}
    </Card>
  );
}

const AUTHOR_BADGES: Record<
  TaskCommentAuthorKind,
  {
    label: string;
    icon: typeof User;
    variant: "default" | "warning" | "secondary";
  }
> = {
  user: { label: "You", icon: User, variant: "default" },
  agent: { label: "Agent", icon: Bot, variant: "warning" },
  system: { label: "System", icon: MessageSquare, variant: "secondary" },
};

function AuthorBadge({ kind }: { kind: TaskCommentAuthorKind }) {
  const badge = AUTHOR_BADGES[kind];
  const Icon = badge.icon;
  return (
    <Badge variant={badge.variant} title={badge.label} aria-label={badge.label}>
      <Icon />
      {badge.label}
    </Badge>
  );
}

function dateTimeWhen(ms: number): string | undefined {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function formatWhen(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
