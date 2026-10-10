import { useState } from "react";
import { Check, ClipboardList, Undo2 } from "lucide-react";
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
import { NoticeList } from "./tools/NoticeList.tsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type ToolBlock = Extract<DisplayBlock, { kind: "tool" }>;

/**
 * Which operation produced a `changed[]` entry. `task_manage`'s payload does not
 * say — it reports the OUTCOME — so the verb comes from the call's own
 * operations, which `changed` follows in order.
 */
export type ManageOperationKind =
  "create" | "update" | "archive" | "unarchive" | "delete";

const OPERATION_KINDS = new Set<string>([
  "create",
  "update",
  "archive",
  "unarchive",
  "delete",
]);

/** `changed[]` gets an entry from these; `delete` reports `deletedIds`. */
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
  const { changed, deletedIds, warnings } = payload;
  if (changed.length === 0 && deletedIds.length === 0) return null;

  const kinds = changedOperationKinds(block.args, changed.length);

  return (
    <Card size="sm" className="my-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <ClipboardList className="size-3.5 text-primary" />
          Tasks
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <ul className="flex flex-col gap-1">
          {changed.map((task, index) => (
            <TaskRow
              key={`${task.id}-${index}`}
              task={task}
              summary={changeSummary(task, kinds?.[index])}
              confirmedTo={confirmed[task.id]}
              onOpenTask={onOpenTask}
              onConfirm={
                onApplyTaskStatusSuggestion
                  ? (to) => {
                      onApplyTaskStatusSuggestion({ id: task.id, status: to });
                      setConfirmed((current) => ({
                        ...current,
                        [task.id]: to,
                      }));
                    }
                  : undefined
              }
            />
          ))}
          {deletedIds.map((id) => (
            <li key={`deleted-${id}`} className="text-muted-foreground">
              <span className="line-through">Task-{id}</span>
              <span className="ml-1.5 text-xs">deleted</span>
            </li>
          ))}
        </ul>
        <NoticeList items={warnings} />
      </CardContent>
    </Card>
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
      <span className="ml-5 inline-flex items-center gap-1 text-xs text-success">
        <Check className="size-3" aria-hidden />
        {done ? "Confirmed done" : "Put back on the to-do pile"}
      </span>
    );
  return (
    <span className="ml-5 flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate text-xs text-warning">
        {done ? "says done" : "says not done"}
        {suggestion.reason ? `: ${suggestion.reason}` : ""}
      </span>
      {onConfirm ? (
        <Button
          variant="outline"
          size="xs"
          onClick={() => onConfirm(suggestion.to)}
          aria-label={
            done
              ? `Confirm "${title}" is done`
              : `Put "${title}" back on the to-do pile`
          }
        >
          {done ? <Check aria-hidden /> : <Undo2 aria-hidden />}
          {done ? "Confirm done" : "Put back"}
        </Button>
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
  return onOpenTask ? (
    <Button
      variant="ghost"
      size="xs"
      className="min-w-0 max-w-full"
      onClick={() => onOpenTask(id)}
      title="Open task details"
    >
      {inner}
    </Button>
  ) : (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1.5 px-2">
      {inner}
    </span>
  );
}
