import type { ReactNode } from "react";
import {
  CalendarCheck,
  Flag,
  GitBranch,
  GitPullRequest,
  MessageSquare,
  Workflow,
} from "lucide-react";
import type { ProjectRecord, TaskPriority } from "@assistant/shared";
import { ProjectBadge } from "./ProjectBadge.tsx";
import { TaskIdBadge } from "./TaskIdBadge.tsx";
import { TASK_STATUS_LABEL } from "./TaskStatusIcon.tsx";
import { Spinner } from "./ui/load.tsx";
import {
  projectPath,
  taskPath,
  worktreePath,
} from "../hooks/useSessionRouting.ts";
import { sessionPath } from "../lib/sessionRoutes.ts";
import { followRowLink } from "../lib/rowLink.ts";
import type { Task } from "../lib/backlogTree.ts";
import {
  taskRowMetaEmpty,
  type TaskRowDelivery,
  type TaskRowMeta,
} from "../lib/taskRowMeta.ts";
import type { HostingAttention } from "../lib/worktreeHosting.ts";

/** Priority is shown only when it is NOT the default — a row that says
 *  "normal" spends its second line restating the absence of information. */
const PRIORITY_TONE: Partial<Record<TaskPriority, string>> = {
  urgent: "text-danger",
  high: "text-amber-500",
  low: "text-faint",
};

/**
 * The delivery chip's words and tone, per rung of the shared ladder. The words
 * are the Worktrees inbox's own badge labels (`worktreeStatusBadge`) so the two
 * surfaces name the same state the same way; a row that says "CI failed" and a
 * card that says "Checks red" about one branch is a UI that has to be learned
 * twice. `open` is the exception — a PR that asks nothing is worth stating only
 * as its NUMBER, which is also the one thing a two-word chip can carry.
 */
const DELIVERY_LABEL: Record<HostingAttention, string> = {
  "ci-failed": "CI failed",
  "review-requested": "Review",
  merged: "Merged",
  "ci-pending": "CI",
  open: "PR",
};

const DELIVERY_TONE: Record<HostingAttention, string> = {
  "ci-failed": "text-danger",
  "review-requested": "text-amber-500",
  merged: "text-emerald-500",
  "ci-pending": "text-accent",
  open: "text-muted",
};

/**
 * The sentence the chip cannot fit: what the state rests on, and which pull
 * request it is about — except on `open`, whose chip already IS the number.
 */
function deliveryTitle(delivery: TaskRowDelivery): string {
  const checks =
    delivery.checks > 0
      ? `${delivery.checks} ${delivery.checks === 1 ? "check" : "checks"}`
      : null;
  const threads =
    delivery.unresolvedThreads > 0
      ? `${delivery.unresolvedThreads} unresolved ${delivery.unresolvedThreads === 1 ? "thread" : "threads"}`
      : null;
  const parts: Array<string | null> = [];
  switch (delivery.state) {
    case "ci-failed":
      parts.push("Checks failed", checks);
      break;
    case "review-requested":
      parts.push(
        delivery.changesRequested ? "Changes requested" : "Review pending",
        threads,
      );
      break;
    case "merged":
      parts.push("Merged upstream — the branch is done");
      break;
    case "ci-pending":
      parts.push("Checks are running", checks);
      break;
    case "open":
      return "A pull request is open";
  }
  if (delivery.prNumber !== null) parts.push(`PR #${delivery.prNumber}`);
  return parts.filter(Boolean).join(" · ");
}

/**
 * @component TaskRowBody
 * @purpose The inside of a Task row, in every Backlog view: the title line
 * (title · caller-supplied fixed-width items) and the meta line that carries the
 * `#id` and answers "what is going on with this Task" from `lib/taskRowMeta.ts`.
 * @useWhen Rendering a durable Task in a list — the tree's rows
 * (`BacklogTreePane`) and the Focus rows (`BacklogFocusList`).
 * @avoidWhen The Inbox, whose three-line row is about an ARRIVAL (origin,
 * first sentence) rather than about the Task's current state.
 * @intent Shared so the views cannot drift: one order for the chips, one glyph
 * per fact, one truncation rule. A two-line row gives line 1 to the TITLE and
 * nothing else but `trailing`'s fixed-width controls, and states everything
 * else — the id first, then the chips in priority order — on line 2, which clips
 * from the right. A single-line row (`meta: null`) is the one shape where the id
 * closes line 1 instead, because there is no line 2 to lead.
 * @intent Line 2 LEADS somewhere wherever it names an object: the id to the
 * Task, the session chip to its session, the branch glyph to its worktree, the
 * dirty dot to that worktree's changes, the delivery chip to the pull request
 * itself, the project chip to the Project. What does NOT link, and why: the
 * suggestion, the plan, the deadline and the priority name no object (a date is
 * a value, not a place); the Workflow glyph names a RUN, but a run has no route
 * of its own — its card lives on the Task page, which the id already reaches,
 * and `WorkflowIndicator` carries two booleans rather than an id, so linking it
 * would mean widening that slice to reach a route that does not exist. Line 2's
 * links, plus the optional title link, are the only interactive elements in
 * here; they are plain anchors following `lib/rowLink.ts`, so they stop the
 * CLICK but never the press — the row around them is a swipe surface and a drag
 * activator (the tree) and must keep both.
 * @related lib/taskRowMeta.ts, BacklogTreePane.tsx, BacklogFocusList.tsx
 */
export function TaskRowBody({
  task,
  meta,
  whenMetaEmpty = "id-only",
  sessionShownElsewhere = false,
  projectsById,
  selected,
  dimmed = false,
  trailing,
  onNavigate,
  onOpenTask,
}: {
  task: Task;
  /** Line 2's content, or `null` for a single-line row. */
  meta: TaskRowMeta | null;
  /**
   * What else line 2 says when the meta states nothing. The id is always there,
   * so the line never goes blank; a row whose HEIGHT is a thumb target takes the
   * `fallback` — the facts a Task always has — so the list cannot alternate
   * between a one- and a two-chip line.
   */
  whenMetaEmpty?: "id-only" | "fallback";
  /**
   * The row states the Task's session somewhere ELSE — the tree's gutter action,
   * which both says it exists and leads to it. Line 2 then drops its own Session
   * chip: the line clips from the right, so saying it twice is paid for by the
   * project chip. Only that chip goes. `Working` stays because nothing else says
   * it, and the WORKTREE glyph stays because "there is code" is a different fact
   * from "work was started" — the gutter states the second, never the first.
   */
  sessionShownElsewhere?: boolean;
  projectsById: Map<string, ProjectRecord>;
  selected: boolean;
  /** An ancestor kept only as context for a filtered subtree; tone it back. */
  dimmed?: boolean;
  /**
   * Items closing line 1. Fixed- or bounded-width only: this end of the line is
   * a column, so anything that grows with the Task belongs on line 2 (the
   * `tight` row's project chip is the exception, because it has no line 2 to
   * move to).
   */
  trailing?: ReactNode;
  /**
   * How this app navigates, for the links line 2 draws. Optional: a surface that
   * passes none states the same facts as plain text — a picker, where a chip
   * that leaves the field would abandon what is being picked.
   */
  onNavigate?: ((path: string) => void) | undefined;
  /**
   * Make the TITLE the row's link to the Task. For a row whose own container is
   * a plain click surface (Focus): the anchor is what the keyboard reaches and
   * what a modifier click opens in a tab, which a `div` cannot be without
   * claiming `role="button"` — and that role makes every link inside it
   * presentational. The tree passes nothing: its row is a `treeitem` that owns
   * selection, and a title that swallowed the click would take multi-select and
   * the focus ring with it.
   */
  onOpenTask?: (id: string) => void;
}) {
  const done = task.status === "done";
  // Dropped BEFORE the emptiness question, so a Task whose only signal was that
  // session falls back to status + age rather than saying nothing but its id.
  const line2 =
    meta && sessionShownElsewhere && !meta.working
      ? { ...meta, session: null }
      : meta;
  const empty = !line2 || taskRowMetaEmpty(line2);
  const titleClass = `min-w-0 flex-1 truncate text-caption ${done ? "text-faint line-through" : dimmed ? "text-muted" : selected ? "font-medium text-fg" : "text-fg"}`;
  return (
    <>
      <span className="flex min-w-0 items-baseline gap-1.5">
        {onOpenTask ? (
          <a
            href={taskPath(task.id)}
            draggable={false}
            className={titleClass}
            onClick={(event) =>
              followRowLink(event, taskPath(task.id), () => onOpenTask(task.id))
            }
          >
            {task.title}
          </a>
        ) : (
          <span className={titleClass}>{task.title}</span>
        )}
        {/* Centred as a group rather than sitting on the title's baseline: a
            control or a chip aligned by ITS baseline hangs below the line and
            makes line 1 as tall as the control, which is how a row with an
            Archive button ends up taller than the row under it. */}
        {trailing ? (
          <span className="flex shrink-0 items-center gap-1.5 self-center">
            {trailing}
          </span>
        ) : null}
        {/* A single-line row has nowhere else to put the id, so there it closes
            line 1 — the one shape where it shares the title's line. */}
        {line2 ? null : <TaskIdBadge id={task.id} onNavigate={onNavigate} />}
      </span>
      {line2 ? (
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-micro">
          {/* The id OPENS line 2, in every two-line view: a left-hand column the
              eye scans down, and the one item on a clipping line that must never
              be the thing that clips. */}
          <TaskIdBadge id={task.id} onNavigate={onNavigate} />
          {!empty ? (
            <TaskMetaItems
              meta={line2}
              projectsById={projectsById}
              onNavigate={onNavigate}
            />
          ) : whenMetaEmpty === "fallback" ? (
            /* Nothing else to report. A row whose height is a thumb target says
               the two facts a Task always has — where it stands, and how long it
               has stood there — rather than leaving the line to the id alone. */
            <span
              className="shrink-0 text-faint"
              title={`Updated ${line2.age}`}
            >
              {TASK_STATUS_LABEL[task.status]} · {line2.age}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

/**
 * A line-2 chip that LEADS somewhere.
 *
 * A real anchor, so the target can be opened in a tab or copied, and so the
 * keyboard reaches it: `href` is the whole point, `onNavigate` only spares it a
 * full page load. It stops the CLICK — following a link must not also select the
 * row it sits in — but deliberately not the PRESS: the tree's rows are swipe
 * surfaces and drag activators, and a chip that swallowed `pointerdown` would
 * carve a dead strip out of both on the line that is half the row.
 */
function MetaLink({
  href,
  title,
  className,
  external = false,
  onNavigate,
  children,
}: {
  href: string;
  title: string;
  className: string;
  /** Off-site (a pull request): a new tab, and the app does not navigate. */
  external?: boolean;
  onNavigate?: ((path: string) => void) | undefined;
  children: ReactNode;
}) {
  // An in-app target with no navigator stays TEXT rather than becoming an anchor
  // that would leave through a full page load.
  if (!external && !onNavigate)
    return (
      <span className={className} title={title}>
        {children}
      </span>
    );
  return (
    <a
      href={href}
      title={title}
      draggable={false}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className={`${className} hover:underline`}
      onClick={(event) =>
        followRowLink(event, href, external ? undefined : onNavigate)
      }
    >
      {children}
    </a>
  );
}

/**
 * The chips, in the order they survive a narrow row: what is true THIS SECOND
 * first, then what was decided about the Task, then where it belongs.
 */
function TaskMetaItems({
  meta,
  projectsById,
  onNavigate,
}: {
  meta: TaskRowMeta;
  projectsById: Map<string, ProjectRecord>;
  onNavigate?: ((path: string) => void) | undefined;
}) {
  // The routes the chips lead to, resolved once. `working` is OBSERVED on a
  // session the browser holds, so there is always one behind it; the null case is
  // the type's, not a state a row can be in.
  const session = meta.session ? sessionPath(meta.session.id) : null;
  const worktree = meta.worktreeId ? worktreePath(meta.worktreeId) : null;
  const worktreeChanges = meta.worktreeId
    ? worktreePath(meta.worktreeId, "changes")
    : null;
  const project = meta.projectId ? projectPath(meta.projectId) : null;
  return (
    <>
      {/* WHAT the agent suggested, since the two kinds ask different questions
          and the glyph only says one is pending. The reason, when there is one,
          is the tooltip rather than a second line. */}
      {meta.suggestion ? (
        <span
          className="shrink-0 text-amber-500"
          title={
            meta.suggestion.reason ??
            (meta.suggestion.to === "done"
              ? "An agent says this is finished"
              : "An agent handed this back unfinished")
          }
        >
          {meta.suggestion.to === "done" ? "says done" : "says not done"}
        </span>
      ) : null}
      {/* OBSERVED, not reported: a session started from this Task is streaming
          right now. It leads the line because it is the only item on it that is
          true this second. Both wordings lead to the same place — the session —
          which is what you want the moment you have read either. */}
      {meta.working ? (
        <MetaLink
          href={session ?? ""}
          title="An agent session started from this task is running now"
          className="inline-flex shrink-0 items-center gap-0.5 text-accent"
          onNavigate={session ? onNavigate : undefined}
        >
          <Spinner size="sm" />
          Working
        </MetaLink>
      ) : meta.session ? (
        /* No session TITLE here: the Backlog reads a copy of the session list
           gated on what a row shows (`lib/sessionRows.ts`), and a title is
           exactly what that gate lets go stale. */
        <MetaLink
          href={session ?? ""}
          title="An agent session was started from this task"
          className="inline-flex shrink-0 items-center gap-0.5 text-muted"
          onNavigate={onNavigate}
        >
          <MessageSquare size={10} aria-hidden />
          Session
        </MetaLink>
      ) : null}
      {/* The code, and what has become of it. One group, because the dirty dot
          marks whichever chip stands for "there is code" — and either chip may
          be the one that survives a narrow row. */}
      {meta.delivery || meta.worktreeId ? (
        <span className="inline-flex shrink-0 items-center gap-1">
          {/* Where the branch stands with its PR and its checks — the one fact
              on this line that neither the Task nor its session can tell you,
              and the one most likely to be what the row is waiting on. It
              REPLACES the worktree glyph rather than joining it: a PR is a
              stronger statement of "there is code" than a branch, and the line
              clips from the right. The glyph stays for a branch whose hosting
              says nothing (or is not known — an absent projection is unknown,
              never clean). */}
          {meta.delivery ? (
            /* The chip leads to where the state can be INSPECTED — the pull
               request, or the checks' own page — which is off-site, so it opens
               in a new tab. A projection that named neither states the same words
               without a link rather than aiming somewhere it has not been told
               about. */
            <MetaLink
              href={meta.delivery.url ?? ""}
              external={meta.delivery.url !== null}
              title={deliveryTitle(meta.delivery)}
              className={`inline-flex items-center gap-0.5 ${DELIVERY_TONE[meta.delivery.state]}`}
            >
              <GitPullRequest size={10} aria-hidden />
              {meta.delivery.state === "open" && meta.delivery.prNumber !== null
                ? `PR #${meta.delivery.prNumber}`
                : DELIVERY_LABEL[meta.delivery.state]}
            </MetaLink>
          ) : (
            /* A glyph alone: the worktree RECORDS (and so its branch name) are
               not in the Backlog's state slice. That there is code for this
               Task is still worth one character of width — and the glyph is the
               way to the worktree it stands for. */
            <MetaLink
              href={worktree ?? ""}
              title="Has a worktree"
              className="inline-flex items-center text-faint"
              onNavigate={worktree ? onNavigate : undefined}
            >
              <GitBranch size={10} aria-label="Has a worktree" />
            </MetaLink>
          )}
          {/* Uncommitted changes, as a DOT rather than the inbox's
              "Uncommitted" badge: this fact subsumes nothing — a branch can
              have an open PR and unsaved work at once — so it has to fit
              beside whatever chip is already there, and the words go in the
              tooltip. Warning-toned, the same tier the Worktrees inbox gives a
              dirty tree. It leads to the worktree's CHANGES, which is the one
              place the dot's claim can be read — and the only route to that
              worktree at all on a row whose branch glyph a PR chip took. The
              negative margin buys the 6px dot a hittable box without moving
              anything on the line. */}
          {meta.dirty ? (
            <MetaLink
              href={worktreeChanges ?? ""}
              title="Uncommitted changes"
              className="-m-0.5 flex shrink-0 p-0.5"
              onNavigate={worktreeChanges ? onNavigate : undefined}
            >
              <span
                role="img"
                aria-label="Uncommitted changes"
                className="size-1.5 rounded-full bg-warning"
              />
            </MetaLink>
          ) : null}
        </span>
      ) : null}
      {meta.workflow ? (
        <span
          role="img"
          className={`inline-flex shrink-0 ${meta.workflow.attention ? "text-warning" : "text-accent"}`}
          aria-label={
            meta.workflow.attention
              ? "Workflow run needs attention"
              : "Workflow run is active"
          }
          title={
            meta.workflow.attention
              ? "Workflow run needs attention"
              : "Workflow run is active"
          }
        >
          <Workflow size={10} aria-hidden />
        </span>
      ) : null}
      {meta.planned ? (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 text-muted"
          title={`Planned for ${meta.planned.toLowerCase()}`}
        >
          <CalendarCheck size={10} aria-hidden />
          {meta.planned}
        </span>
      ) : null}
      {meta.due ? (
        <span
          className={`inline-flex shrink-0 items-center gap-0.5 ${meta.overdue ? "text-danger" : "text-muted"}`}
          title={`Due ${meta.due.toLowerCase()}`}
        >
          <Flag size={10} aria-hidden />
          {meta.due}
        </span>
      ) : null}
      {meta.priority ? (
        <span className={PRIORITY_TONE[meta.priority] ?? "text-muted"}>
          {meta.priority}
        </span>
      ) : null}
      {/* The chip keeps its own tooltip (the Project's full name), so the link
          around it carries none and adds no underline: it is a badge, and a
          dotted line under a coloured pill reads as damage rather than as an
          affordance. */}
      {meta.projectId ? (
        project && onNavigate ? (
          <a
            href={project}
            draggable={false}
            className="flex min-w-0 shrink-0"
            onClick={(event) => followRowLink(event, project, onNavigate)}
          >
            <ProjectBadge
              projectId={meta.projectId}
              projectsById={projectsById}
              size="sm"
            />
          </a>
        ) : (
          <ProjectBadge
            projectId={meta.projectId}
            projectsById={projectsById}
            size="sm"
          />
        )
      ) : null}
    </>
  );
}
