import { useEffect, useState } from "react";
import { Check, ClipboardList, Undo2 } from "lucide-react";
import type {
  DisplayBlock,
  TaskStatus,
  TaskStatusSuggestion,
  TaskSummary,
} from "@assistant/shared";
import {
  parseTaskManagePayload,
  type ChangedTaskPayload,
} from "@assistant/shared/toolCards";
import { pendingStatusSuggestion } from "../lib/backlogTree.ts";
import type { TaskStatusRecord } from "../hooks/useAssistant.ts";
import { useTaskLiveSource } from "./TaskLiveState.tsx";
import { Markdown } from "./Markdown.tsx";
import { TaskIdBadge } from "./TaskIdBadge.tsx";
import { TASK_STATUS_LABEL, TaskStatusIcon } from "./TaskStatusIcon.tsx";
import { NoticeList } from "./tools/NoticeList.tsx";
import { Button } from "@/components/ui/button";
import { AppCard } from "./common/AppCard.tsx";

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
 * Where the suggestion this card RECORDED stands now, given the Task's live
 * state: `unknown` until that state arrives (the card shows what it recorded),
 * `pending` while the Task still waits for the same answer, `accepted` once its
 * status is where the suggestion pointed, and `settled` when it was dismissed,
 * overtaken, or the Task is gone — no longer a question this card can answer.
 *
 * "The same answer" is the same CLAIM, not just the same target: a later agent
 * saying `done` again is a new question with its own reason, and answering it
 * from this card would answer something the user never read here. `at` tells
 * the two apart (a retried write keeps it); a payload without one matches on
 * the target alone.
 */
export function recordedSuggestionState(
  recorded: TaskStatusSuggestion,
  live: LiveTask | null | undefined,
): "unknown" | "pending" | "accepted" | "settled" {
  if (live === undefined) return "unknown";
  if (live === null) return "settled";
  const pending = pendingStatusSuggestion(live);
  if (
    pending?.to === recorded.to &&
    (recorded.at === 0 || pending.at === recorded.at)
  )
    return "pending";
  return live.status === recorded.to ? "accepted" : "settled";
}

type LiveTask = Pick<TaskSummary, "status" | "statusSuggestion">;

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
  // Answered locally FIRST, so the button turns over on the click rather than
  // on the server's reply; after a reload the row learns the answer from the
  // Task's live state (`TaskLiveState.tsx`).
  const [confirmed, setConfirmed] = useState<Record<string, TaskStatus>>({});
  const payload = parseTaskManagePayload(block.output);
  if (!payload) return null;
  const { changed, deletedIds, warnings } = payload;
  if (changed.length === 0 && deletedIds.length === 0) return null;

  const kinds = changedOperationKinds(block.args, changed.length);

  const count = changed.length + deletedIds.length;
  return (
    <AppCard icon={<ClipboardList />} label="Tasks" status={`${count} changed`}>
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
    </AppCard>
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
  const recorded = pendingStatusSuggestion(task);
  const live = useLiveTask(task.id, recorded);
  const answer = recorded ? recordedSuggestionState(recorded, live) : "settled";
  const suggestion = answer === "settled" ? undefined : recorded;
  const answeredTo =
    confirmedTo ?? (answer === "accepted" ? recorded?.to : undefined);
  const status = confirmedTo ?? live?.status ?? task.status;
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <TaskStatusIcon
          status={status}
          size={14}
          claimed={Boolean(suggestion) && !answeredTo}
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
          confirmed={Boolean(answeredTo)}
          onConfirm={onConfirm}
        />
      ) : null}
    </li>
  );
}

/**
 * The Task's current state while this row has a recorded question to settle:
 * the newest of what this tab last read and the summaries it holds, ignoring
 * any copy older than the claim itself — that copy predates the question and
 * cannot have answered it.
 *
 * A record is a last-known value, so the row reads the Task once per mount and
 * once per connection, and again whenever its record is dropped (the Task left
 * the live projection). Reads are deduped in flight; a refused one waits for the next
 * connection rather than retrying in a loop, and no record is ever evicted, so
 * nothing can read in a ring.
 */
function useLiveTask(
  taskId: string,
  recorded: TaskStatusSuggestion | undefined,
): LiveTask | null | undefined {
  const source = useTaskLiveSource();
  const wanted = recorded !== undefined;
  const record = wanted ? source?.statuses[taskId] : undefined;
  const known = record !== undefined;
  const listed = wanted ? source?.listed.get(taskId) : undefined;
  const connected = source?.connected ?? false;
  const request = source?.request;
  useEffect(() => {
    if (wanted && connected && request) request(taskId);
  }, [wanted, connected, request, taskId]);
  useEffect(() => {
    if (wanted && connected && !known && request) request(taskId);
  }, [wanted, connected, known, request, taskId]);
  if (record === null) return null;
  const notBefore = recorded?.at ?? 0;
  const candidates = [record, listed].filter(
    (copy): copy is TaskStatusRecord =>
      copy !== undefined && copy.updatedAt >= notBefore,
  );
  return candidates.reduce<TaskStatusRecord | undefined>(
    (newest, copy) =>
      !newest || copy.updatedAt > newest.updatedAt ? copy : newest,
    undefined,
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
        {suggestion.reason ? (
          <>
            : <Markdown text={suggestion.reason} inline />
          </>
        ) : null}
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
      <span className="min-w-0 truncate">
        <Markdown text={label} inline />
      </span>
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
