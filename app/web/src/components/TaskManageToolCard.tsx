import { useState } from "react";
import { Check, ClipboardList, TriangleAlert, Undo2 } from "lucide-react";
import type {
  DisplayBlock,
  TaskStatus,
  TaskStatusSuggestion,
} from "@assistant/shared";
import {
  parseTaskManagePayload,
  type ChangedTaskPayload,
} from "@assistant/shared/toolCards";
import { pendingStatusSuggestion } from "../lib/backlogTree.ts";
import { TaskIdBadge } from "./TaskIdBadge.tsx";
import { TASK_STATUS_LABEL, TaskStatusIcon } from "./TaskStatusIcon.tsx";

type ToolBlock = Extract<DisplayBlock, { kind: "tool" }>;

/**
 * Which operation produced a `changed[]` entry. `task_manage`'s payload does not
 * say — it reports the OUTCOME — so the verb comes from the call's own
 * operations, which `changed` follows in order.
 */
export type ManageOperationKind =
  "create" | "update" | "archive" | "unarchive" | "delete" | "comment";

const OPERATION_KINDS = new Set<string>([
  "create",
  "update",
  "archive",
  "unarchive",
  "delete",
  "comment",
]);

/** `changed[]` gets an entry from these; `delete` reports `deletedIds` and a bare `comment` nothing. */
const CHANGING_OPERATIONS = new Set<ManageOperationKind>([
  "create",
  "update",
  "archive",
  "unarchive",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The operation kinds behind `changed[]`, in the same order — or `null` when the
 * call's arguments cannot be lined up with the result (a lazily summarized input,
 * or a batch that partly threw). The card then simply omits the verb.
 */
export function changedOperationKinds(
  args: unknown,
  changedCount: number,
): ManageOperationKind[] | null {
  const operations = asRecord(args)?.operations;
  if (!Array.isArray(operations)) return null;
  const kinds: ManageOperationKind[] = [];
  for (const operation of operations) {
    const kind = asRecord(operation)?.operation;
    if (typeof kind !== "string" || !OPERATION_KINDS.has(kind)) return null;
    const typed = kind as ManageOperationKind;
    if (CHANGING_OPERATIONS.has(typed)) kinds.push(typed);
  }
  return kinds.length === changedCount ? kinds : null;
}

/** The compact "what happened" suffix for one changed Task. */
export function changeSummary(
  task: ChangedTaskPayload,
  kind: ManageOperationKind | undefined,
  commented: boolean,
): string {
  const parts: string[] = [];
  // A deduped Slack import IS a create operation that changed an existing Task,
  // so the op's verb would contradict the warning riding beside it.
  if (task.deduplicated) parts.push("already imported");
  else if (kind === "create") parts.push("created");
  else if (kind === "archive") parts.push("archived");
  else if (kind === "unarchive") parts.push("restored");
  else {
    if (task.descriptionEditsApplied !== undefined)
      parts.push(
        task.descriptionEditsApplied === 1
          ? "description updated"
          : `${task.descriptionEditsApplied} description edits`,
      );
    if (task.statusSetByRequest)
      parts.push(`set ${TASK_STATUS_LABEL[task.status].toLowerCase()}`);
    if (parts.length === 0 && kind === "update") parts.push("updated");
  }
  if (commented) parts.push("comment added");
  return parts.join(" · ");
}

/**
 * @component TaskManageToolCard
 * @purpose What an agent just did to the user's Backlog, in band: the Tasks it
 *   created or changed as chips that open them, and any status it suggested with
 *   the button that answers it.
 * @intent A Task mutation is the user's data changing, so it stays visible with
 *   tool details hidden. Confirming a suggestion here is an ordinary user save
 *   (exactly what the Backlog's Focus row sends) — the session is never resumed,
 *   so answering costs no provider call.
 */
export function TaskManageToolCard({
  block,
  onOpenTask,
  onApplyTaskStatusSuggestion,
}: {
  block: ToolBlock;
  onOpenTask?: ((taskId: string) => void) | undefined;
  onApplyTaskStatusSuggestion?:
    ((task: { id: string; status: TaskStatus }) => void) | undefined;
}) {
  // Answered LOCALLY: the transcript has no live Backlog subscription, so the
  // recorded payload cannot learn that the suggestion is resolved. Re-confirming
  // after a reload is a no-op save, not a second change.
  const [confirmed, setConfirmed] = useState<Record<string, TaskStatus>>({});
  const payload = parseTaskManagePayload(block.output);
  if (!payload) return null;
  const { changed, deletedIds, commentedIds, warnings } = payload;
  if (
    changed.length === 0 &&
    deletedIds.length === 0 &&
    commentedIds.length === 0
  )
    return null;

  const kinds = changedOperationKinds(block.args, changed.length);
  const commented = new Set(commentedIds);
  const changedIds = new Set(changed.map((task) => task.id));
  // A bare comment operation changes nothing, so it has no `changed` entry — but
  // it is still something that happened to a Task the user owns.
  const commentOnly = commentedIds.filter((id) => !changedIds.has(id));

  return (
    <section className="my-2 rounded-xl border border-border bg-card/60 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ClipboardList size={11} className="text-primary" />
        <span>Tasks</span>
      </div>
      <ul className="flex flex-col gap-1">
        {changed.map((task, index) => (
          <TaskRow
            key={`${task.id}-${index}`}
            task={task}
            summary={changeSummary(
              task,
              kinds?.[index],
              commented.has(task.id),
            )}
            confirmedTo={confirmed[task.id]}
            onOpenTask={onOpenTask}
            onConfirm={
              onApplyTaskStatusSuggestion
                ? (to) => {
                    onApplyTaskStatusSuggestion({ id: task.id, status: to });
                    setConfirmed((current) => ({ ...current, [task.id]: to }));
                  }
                : undefined
            }
          />
        ))}
        {commentOnly.map((id) => (
          <li key={`comment-${id}`}>
            <TaskChip id={id} label={`Task-${id}`} onOpenTask={onOpenTask} />
            <span className="ml-1.5 text-xs text-muted-foreground">
              comment added
            </span>
          </li>
        ))}
        {deletedIds.map((id) => (
          <li key={`deleted-${id}`} className="text-sm text-muted-foreground">
            <span className="line-through">Task-{id}</span>
            <span className="ml-1.5 text-xs">deleted</span>
          </li>
        ))}
      </ul>
      {warnings.map((warning) => (
        <p
          key={warning}
          className="mt-1 flex items-start gap-1.5 text-xs text-amber-500"
        >
          <TriangleAlert size={11} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{warning}</span>
        </p>
      ))}
    </section>
  );
}

function TaskRow({
  task,
  summary,
  confirmedTo,
  onOpenTask,
  onConfirm,
}: {
  task: ChangedTaskPayload;
  summary: string;
  confirmedTo?: TaskStatus | undefined;
  onOpenTask?: ((taskId: string) => void) | undefined;
  onConfirm?: ((to: TaskStatus) => void) | undefined;
}) {
  // The ONE rule for "still waiting for an answer" (`backlogTree.ts`): a
  // suggestion the Task's status already satisfies is provenance, not a
  // question, so it gets no amber glyph and no button.
  const suggestion = pendingStatusSuggestion(task);
  const status = confirmedTo ?? task.status;
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <TaskStatusIcon
          status={status}
          size={14}
          claimed={Boolean(suggestion) && !confirmedTo}
        />
        <TaskChip id={task.id} label={task.title} onOpenTask={onOpenTask} />
        {summary ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {summary}
          </span>
        ) : null}
      </span>
      {suggestion ? (
        <SuggestionRow
          suggestion={suggestion}
          title={task.title}
          confirmed={Boolean(confirmedTo)}
          onConfirm={onConfirm}
        />
      ) : null}
    </li>
  );
}

/**
 * The suggestion, answered where it is read. Only the CONFIRM half lives here:
 * disagreeing is a judgement about the Task, which is the Backlog's Focus row.
 */
function SuggestionRow({
  suggestion,
  title,
  confirmed,
  onConfirm,
}: {
  suggestion: TaskStatusSuggestion;
  title: string;
  confirmed: boolean;
  onConfirm?: ((to: TaskStatus) => void) | undefined;
}) {
  const done = suggestion.to === "done";
  if (confirmed)
    return (
      <span className="ml-[22px] inline-flex items-center gap-1 text-xs text-emerald-500">
        <Check size={11} aria-hidden />
        {done ? "Confirmed done" : "Put back on the to-do pile"}
      </span>
    );
  return (
    <span className="ml-[22px] flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate text-xs text-amber-500">
        {done ? "says done" : "says not done"}
        {suggestion.reason ? `: ${suggestion.reason}` : ""}
      </span>
      {onConfirm ? (
        <button
          type="button"
          onClick={() => onConfirm(suggestion.to)}
          className={`inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs ${
            done
              ? "border-emerald-500/50 text-emerald-500 hover:bg-emerald-500/10"
              : "border-primary/50 text-primary hover:bg-primary/10"
          }`}
          aria-label={
            done
              ? `Confirm "${title}" is done`
              : `Put "${title}" back on the to-do pile`
          }
        >
          {done ? (
            <Check size={11} aria-hidden />
          ) : (
            <Undo2 size={11} aria-hidden />
          )}
          {done ? "Confirm done" : "Put back"}
        </button>
      ) : null}
    </span>
  );
}

function TaskChip({
  id,
  label,
  onOpenTask,
}: {
  id: string;
  label: string;
  onOpenTask?: ((taskId: string) => void) | undefined;
}) {
  const inner = (
    <>
      <span className="min-w-0 truncate">{label}</span>
      <TaskIdBadge id={id} />
    </>
  );
  const className =
    "inline-flex min-w-0 max-w-full items-baseline gap-1.5 rounded-md px-1 py-0.5 text-sm text-foreground";
  return onOpenTask ? (
    <button
      type="button"
      onClick={() => onOpenTask(id)}
      className={`${className} cursor-pointer hover:bg-muted`}
      title="Open task details"
    >
      {inner}
    </button>
  ) : (
    <span className={className}>{inner}</span>
  );
}
