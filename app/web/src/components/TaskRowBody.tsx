import type { ReactNode } from "react";
import { Badge } from "./ui/badge.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import {
  CalendarCheck,
  Flag,
  FolderKanban,
  GitBranch,
  GitPullRequest,
  MessageSquare,
  Workflow,
} from "lucide-react";
import type { ProjectRecord } from "@assistant/shared";
import { TaskIdBadge } from "./TaskIdBadge.tsx";
import { TaskBlockedIndicator } from "./TaskBlockedIndicator.tsx";
import { Spinner } from "./common/load.tsx";
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
import { projectColor, resolveProjectDisplay } from "../lib/projectDisplay.ts";

/**
 * A neutral fact on line 2, as plain muted text rather than a pill — the
 * session cards' meta line. Only what needs the user keeps a badge's chrome.
 */
const PLAIN_META =
  "h-auto rounded-none border-0 bg-transparent px-0 py-0 font-normal text-muted-foreground";

/** Priority is shown only when it is NOT the default — a row that says
 *  "normal" spends its second line restating the absence of information. */
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

const DELIVERY_VARIANT: Record<
  HostingAttention,
  "destructive" | "warning" | "success" | "secondary"
> = {
  "ci-failed": "destructive",
  "review-requested": "warning",
  merged: "success",
  "ci-pending": "secondary",
  open: "secondary",
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
  // Dropped BEFORE the emptiness question, so a Task whose only signal was that
  // session falls back to status + age rather than saying nothing but its id.
  const line2 =
    meta && sessionShownElsewhere && !meta.working
      ? { ...meta, session: null }
      : meta;
  return (
    <>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <TaskRowTitle
          task={task}
          selected={selected}
          dimmed={dimmed}
          onOpenTask={onOpenTask}
        />
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
            line 1 — the one shape where it shares the title's line. Being
            blocked rides with it as a glyph and its count: line 2's chip is
            not there to say it, and it is the one fact a row must not hide. */}
        {!line2 && task.openBlockerCount ? (
          <TaskBlockedIndicator
            openBlockers={task.openBlockerCount}
            size={12}
            className="self-center text-xs"
          />
        ) : null}
        {line2 ? null : <TaskIdBadge id={task.id} onNavigate={onNavigate} />}
      </span>
      {line2 ? (
        // One line that drops what does not fit WHOLE, never half an item: it
        // wraps, but is one line tall, so a wrapped item goes below the clip
        // (the session cards' signal row does the same).
        <span className="mt-0.5 flex h-5 min-w-0 flex-wrap items-center gap-x-1.5 gap-y-4 overflow-hidden whitespace-nowrap text-xs">
          <TaskRowDetails
            task={task}
            meta={line2}
            projectsById={projectsById}
            onNavigate={onNavigate}
          />
        </span>
      ) : null}
    </>
  );
}

/** The Task title, including its real link and completed/context-only tone. */
export function TaskRowTitle({
  task,
  selected,
  dimmed = false,
  onOpenTask,
}: {
  task: Task;
  selected: boolean;
  dimmed?: boolean;
  onOpenTask?: ((id: string) => void) | undefined;
}) {
  const titleClass = `min-w-0 flex-1 truncate text-sm ${task.status === "done" ? "text-muted-foreground line-through" : dimmed ? "text-muted-foreground" : selected ? "font-medium text-foreground" : "text-foreground"}`;
  return onOpenTask ? (
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
  );
}

/** Project and durable Task id for a combined Task metadata line. */
function TaskRowContext({
  task,
  meta,
  projectsById,
  onNavigate,
}: {
  task: Task;
  meta: TaskRowMeta;
  projectsById: Map<string, ProjectRecord>;
  onNavigate?: ((path: string) => void) | undefined;
}) {
  return (
    <>
      {meta.projectId ? (
        <TaskProjectMeta
          projectId={meta.projectId}
          projectsById={projectsById}
          href={projectPath(meta.projectId)}
          onNavigate={onNavigate}
        />
      ) : null}
      <TaskIdBadge id={task.id} onNavigate={onNavigate} />
    </>
  );
}

/** Shared Task metadata content; the tree or ListRow owns its line geometry. */
export function TaskRowDetails({
  task,
  meta,
  projectsById,
  onNavigate,
  showContext = true,
}: {
  task: Task;
  meta: TaskRowMeta;
  projectsById: Map<string, ProjectRecord>;
  onNavigate?: ((path: string) => void) | undefined;
  /** Off when the project and id already appear above the title. */
  showContext?: boolean;
}) {
  const empty = taskRowMetaEmpty({ ...meta, projectId: null });
  return (
    <>
      {showContext ? (
        <TaskRowContext
          task={task}
          meta={meta}
          projectsById={projectsById}
          onNavigate={onNavigate}
        />
      ) : null}
      {!empty ? <TaskMetaItems meta={meta} onNavigate={onNavigate} /> : null}
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

/** Worktree navigation and PR state remain separate, including on narrow rows. */
function TaskCodeMeta({
  meta,
  onNavigate,
}: {
  meta: TaskRowMeta;
  onNavigate?: ((path: string) => void) | undefined;
}) {
  const worktrees = meta.worktrees ?? (meta.worktreeId ? [{
    id: meta.worktreeId,
    name: null,
    delivery: meta.delivery,
    dirty: meta.dirty,
  }] : []);
  const single = worktrees.length === 1 ? worktrees[0] : undefined;
  const deliveries = [...new Map(
    (meta.worktrees ? worktrees.map((worktree) => worktree.delivery) : [meta.delivery])
      .filter((delivery): delivery is TaskRowDelivery => delivery !== null)
      .map((delivery) => [delivery.url ?? `${delivery.prNumber}:${delivery.state}`, delivery]),
  ).values()];
  return (
    <>
      {single ? (
        <span className="inline-flex shrink-0 items-center gap-1">
          <MetaLink
            href={worktreePath(single.id)}
            title={single.name ? `Worktree: ${single.name}` : "Has a worktree"}
            className="inline-flex items-center gap-1 text-muted-foreground"
            onNavigate={onNavigate}
          >
            <GitBranch size={10} aria-label="Has a worktree" />
            {single.name ? <span className="max-w-48 truncate [[data-signals-compact]_&]:hidden">{single.name}</span> : null}
          </MetaLink>
          {single.dirty ? (
            <MetaLink
              href={worktreePath(single.id, "changes")}
              title="Uncommitted changes"
              className="-m-0.5 flex shrink-0 p-0.5"
              onNavigate={onNavigate}
            >
              <span role="img" aria-label="Uncommitted changes" className="size-1.5 rounded-full bg-warning" />
            </MetaLink>
          ) : null}
        </span>
      ) : worktrees.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Badge variant="ghost" render={<button type="button" />} />}
            title={worktrees.map((worktree) => worktree.name ?? worktree.id).join(", ")}
            aria-label={`${worktrees.length} worktrees`}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            className="h-auto shrink-0 cursor-pointer border-0 px-0 py-0 font-normal text-muted-foreground"
          >
            <GitBranch aria-hidden />
            {worktrees.length} worktrees
            {worktrees.some((worktree) => worktree.dirty) ? <span role="img" aria-label="Uncommitted changes in linked worktrees" className="size-1.5 rounded-full bg-warning" /> : null}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            {worktrees.map((worktree) => (
              <DropdownMenuItem
                key={worktree.id}
                render={onNavigate ? <a href={worktreePath(worktree.id)} draggable={false} /> : <span />}
                disabled={!onNavigate}
                className="cursor-pointer touch-ui:min-h-11"
                onClick={(event) => followRowLink(event, worktreePath(worktree.id), onNavigate)}
              >
                <GitBranch aria-hidden />
                <span className="min-w-0 flex-1 truncate">{worktree.name ?? worktree.id}</span>
                {worktree.dirty ? <span role="img" aria-label="Uncommitted changes" className="size-1.5 shrink-0 rounded-full bg-warning" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {deliveries.map((delivery) => (
        <MetaLink
          key={delivery.url ?? `${delivery.prNumber}:${delivery.state}`}
          href={delivery.url ?? ""}
          external={delivery.url !== null}
          title={deliveryTitle(delivery)}
          className="inline-flex shrink-0"
        >
          <Badge variant={DELIVERY_VARIANT[delivery.state]}>
            <GitPullRequest aria-hidden="true" />
            {delivery.state === "open" && delivery.prNumber !== null
              ? `PR #${delivery.prNumber}`
              : DELIVERY_LABEL[delivery.state]}
          </Badge>
        </MetaLink>
      ))}
    </>
  );
}

/**
 * The chips after the Project and the id, in the order they survive a narrow
 * row: what is true THIS SECOND first, then what was decided about the Task.
 */
function TaskMetaItems({
  meta,
  onNavigate,
}: {
  meta: TaskRowMeta;
  onNavigate?: ((path: string) => void) | undefined;
}) {
  // The routes the chips lead to, resolved once. `working` is OBSERVED on a
  // session the browser holds, so there is always one behind it; the null case is
  // the type's, not a state a row can be in.
  const session = meta.session ? sessionPath(meta.session.id) : null;
  return (
    <>
      {/* WHAT the agent suggested, since the two kinds ask different questions
          and the glyph only says one is pending. The reason, when there is one,
          is the tooltip rather than a second line. */}
      {meta.suggestion ? (
        <Badge
          variant="warning"
          title={
            meta.suggestion.reason ??
            (meta.suggestion.to === "done"
              ? "An agent says this is finished"
              : "An agent handed this back unfinished")
          }
        >
          {meta.suggestion.to === "done" ? "says done" : "says not done"}
        </Badge>
      ) : null}
      {/* OBSERVED, not reported: a session started from this Task is streaming
          right now. It leads the line because it is the only item on it that is
          true this second. Both wordings lead to the same place — the session —
          which is what you want the moment you have read either. */}
      {meta.working ? (
        <MetaLink
          href={session ?? ""}
          title="An agent session started from this task is running now"
          className="inline-flex shrink-0 items-center gap-0.5 text-primary"
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
          className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground"
          onNavigate={onNavigate}
        >
          <MessageSquare size={10} aria-hidden />
          Session
        </MetaLink>
      ) : null}
      {/* Waiting on other Tasks: true this second, like `working`, and the
          reason a row with nothing else going on is not being picked up. */}
      {meta.blockers ? (
        <TaskBlockedIndicator openBlockers={meta.blockers} />
      ) : null}
      <TaskCodeMeta meta={meta} onNavigate={onNavigate} />
      {meta.workflow ? (
        <span
          role="img"
          className={`inline-flex shrink-0 ${meta.workflow.attention ? "text-warning" : "text-primary"}`}
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
        <Badge
          variant="secondary"
          className={PLAIN_META}
          title={`Planned for ${meta.planned.toLowerCase()}`}
        >
          <CalendarCheck aria-hidden="true" />
          {meta.planned}
        </Badge>
      ) : null}
      {meta.due ? (
        <Badge
          variant={meta.overdue ? "destructive" : "secondary"}
          className={meta.overdue ? undefined : PLAIN_META}
          title={`Due ${meta.due.toLowerCase()}`}
        >
          <Flag aria-hidden="true" />
          {meta.due}
        </Badge>
      ) : null}
      {meta.priority ? (
        <Badge
          variant={
            meta.priority === "urgent"
              ? "destructive"
              : meta.priority === "high"
                ? "warning"
                : "secondary"
          }
          className={
            meta.priority === "urgent" || meta.priority === "high"
              ? undefined
              : PLAIN_META
          }
        >
          {meta.priority}
        </Badge>
      ) : null}
    </>
  );
}

/** A Task's Project on a row's meta line: its icon in its colour and its short
 *  name, muted, leading to the Project when there is somewhere to go. */
export function TaskProjectMeta({
  projectId,
  projectsById,
  href,
  onNavigate,
}: {
  projectId: string;
  projectsById: Map<string, ProjectRecord>;
  href: string | null;
  onNavigate?: ((path: string) => void) | undefined;
}) {
  const project = projectsById.get(projectId);
  const { label, shortLabel, known } = resolveProjectDisplay(
    projectId,
    projectsById,
  );
  return (
    <MetaLink
      href={href ?? ""}
      title={known ? label : `Unknown project: ${projectId}`}
      className="inline-flex max-w-1/2 min-w-0 shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground"
      onNavigate={href ? onNavigate : undefined}
    >
      <FolderKanban
        size={11}
        className="shrink-0"
        style={
          known ? { color: projectColor(project ?? projectId).dot } : undefined
        }
        aria-hidden
      />
      <span className="truncate">{shortLabel}</span>
    </MetaLink>
  );
}
