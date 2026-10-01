/**
 * Pure shaping for the Backlog's **Focus** view (no React, no sockets): the
 * when-based bucketing, the ordering inside each bucket, and the short due
 * label a row shows.
 *
 * Focus answers "what should I work on", so it groups on TIME and only sorts on
 * priority inside a group. A `high` task due next month must not outrank an
 * ordinary one that is late today — the deadline is the fact, the priority is
 * the opinion, and grouping the fact keeps the opinion from overruling it.
 *
 * Everything here is deterministic over the task list plus an explicit `today`
 * (a YYYY-MM-DD string), so the caller can drive it from one shared clock and
 * the rules stay testable without freezing time.
 */
import type { TaskPriority } from "@assistant/shared";
import { pendingStatusSuggestion, type Task } from "./backlogTree.ts";
import { addDays, isoWeekday } from "../components/calendar/calendarDates.ts";

/**
 * The buckets, in the order Focus renders them.
 *
 * `review` is the one that is NOT about time: an agent has suggested where a
 * Task should stand — finished, or handed back unfinished — and is waiting on
 * you. It leads because it is the cheapest thing on the list to resolve — a yes
 * or a no — and because leaving it buried is how a Task ends up neither done
 * nor being worked on.
 */
export type FocusBucketId =
  | "review"
  | "overdue"
  | "today"
  | "tomorrow"
  | "week"
  | "later"
  | "unscheduled";

export interface FocusBucket {
  id: FocusBucketId;
  label: string;
  tasks: Task[];
}

const BUCKET_ORDER: FocusBucketId[] = [
  "review",
  "overdue",
  "today",
  "tomorrow",
  "week",
  "later",
  "unscheduled",
];

const BUCKET_LABEL: Record<FocusBucketId, string> = {
  // Not "Finished?" any more: the bucket holds both kinds of suggestion, and
  // each row says which one it is.
  review: "Confirm?",
  overdue: "Overdue",
  today: "Today",
  tomorrow: "Tomorrow",
  week: "This week",
  later: "Later",
  unscheduled: "No date",
};

/**
 * Priority rank, lowest first. A MISSING priority is `normal` — the wire field
 * is optional and most Tasks never had one set, so treating absence as anything
 * else would sort the untouched majority to one end of every bucket.
 */
const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export function priorityRank(priority: TaskPriority | undefined): number {
  return PRIORITY_RANK[priority ?? "normal"];
}

/** The Sunday closing the ISO week that contains `today`. */
function endOfWeek(today: string): string {
  return addDays(today, 7 - isoWeekday(today));
}

/**
 * The date a Task is BUCKETED by: whichever of the plan and the deadline comes
 * first.
 *
 * A Task carries two dates that mean different things — `scheduledFor` is when
 * you (or an agent planning for you) decided to work on it, `dueDate` is when
 * the outside world needs it — and Focus has to answer with ONE position. The
 * earlier of the two is the only rule that never hides work: a Task you planned
 * for today surfaces today even though it is not due for a fortnight, and a
 * Task due today surfaces today even though you planned to start it on Friday.
 * Taking the plan alone would let a near deadline sit silently under "Later";
 * taking the deadline alone would make planning your day change nothing.
 */
export function effectiveFocusDate(task: Task): string | undefined {
  const planned = task.scheduledFor;
  const due = task.dueDate;
  if (planned && due) return planned < due ? planned : due;
  return planned ?? due;
}

/**
 * Which bucket a Task falls in. A pending status suggestion wins over every
 * date: whatever this Task was scheduled for, the useful thing to do with it
 * now is answer the question.
 */
export function focusBucketFor(task: Task, today: string): FocusBucketId {
  if (pendingStatusSuggestion(task)) return "review";
  const date = effectiveFocusDate(task);
  if (!date) return "unscheduled";
  if (date < today) return "overdue";
  if (date === today) return "today";
  const tomorrow = addDays(today, 1);
  if (date === tomorrow) return "tomorrow";
  return date <= endOfWeek(today) ? "week" : "later";
}

/**
 * Order inside a bucket: priority first, then the nearer date, then the most
 * recently touched. `updatedAt` is the last tiebreak rather than the Backlog's
 * manual `sortOrder` — a hand-arranged order is what the Backlog view is for,
 * and carrying it here would make two rows swap places for a reason this list
 * gives no way to see.
 */
function compareFocusTasks(a: Task, b: Task): number {
  // Inside the review bucket, the OLDEST suggestion leads: something an agent
  // said was finished a week ago is the one that has been ignored longest.
  const suggestedA = pendingStatusSuggestion(a);
  const suggestedB = pendingStatusSuggestion(b);
  if (suggestedA && suggestedB) return suggestedA.at - suggestedB.at;
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
  if (byPriority !== 0) return byPriority;
  const dateA = effectiveFocusDate(a) ?? "";
  const dateB = effectiveFocusDate(b) ?? "";
  if (dateA !== dateB) {
    if (!dateA) return 1;
    if (!dateB) return -1;
    return dateA < dateB ? -1 : 1;
  }
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

/**
 * Group the given Tasks into the when-buckets, ordered, with EMPTY buckets
 * dropped: a heading over nothing is a row of chrome claiming there is work
 * where there is none.
 *
 * The list is FLAT — subtasks stand on their own here. Focus is a list of what
 * to do next, and a subtask due today is due today whether or not its parent is
 * on the list; hiding it under a parent that falls in another bucket would take
 * it off the day it belongs to.
 */
export function buildFocusBuckets(tasks: Task[], today: string): FocusBucket[] {
  const byBucket = new Map<FocusBucketId, Task[]>();
  for (const task of tasks) {
    const id = focusBucketFor(task, today);
    const list = byBucket.get(id);
    if (list) list.push(task);
    else byBucket.set(id, [task]);
  }
  const buckets: FocusBucket[] = [];
  for (const id of BUCKET_ORDER) {
    const list = byBucket.get(id);
    if (!list?.length) continue;
    buckets.push({
      id,
      label: BUCKET_LABEL[id],
      tasks: list.sort(compareFocusTasks),
    });
  }
  return buckets;
}

// Fixed tables rather than `Intl.DateTimeFormat`: these sit in a tight metadata
// line where a uniform three characters keeps the column steady (ICU's own
// en-GB short forms are not — September is "Sept"), and a hardcoded table
// cannot shift under an ICU version change.
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * The short label for one date on a row. It is deliberately RELATIVE near today
 * ("Today", "Fri") and absolute further out: within the week you plan by
 * distance, beyond it you plan by date. A date in the PAST reports its
 * distance, since how long something has been sitting there is the point.
 */
export function focusDateLabel(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  if (date < today) {
    const days = daysBetween(date, today);
    return `${days}d ago`;
  }
  if (date <= endOfWeek(today)) return WEEKDAYS[isoWeekday(date) - 1]!;
  const [, month, day] = date.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]}`;
}

/**
 * The row's DUE chip. Overdue reads as "late" rather than "ago" — a missed
 * deadline is a different fact from a plan that slipped, and the row tones it
 * differently for the same reason.
 *
 * Returns `null` when there is no deadline, so the chip is absent rather than
 * empty.
 */
export function dueLabel(task: Task, today: string): string | null {
  const due = task.dueDate;
  if (!due) return null;
  if (due < today) {
    const days = daysBetween(due, today);
    return `${days}d late`;
  }
  return focusDateLabel(due, today);
}

/**
 * The row's PLANNED chip, shown only when it says something the due chip does
 * not: a plan identical to the deadline is one fact, and printing it twice
 * spends the row's second line restating itself.
 */
export function scheduledLabel(task: Task, today: string): string | null {
  const planned = task.scheduledFor;
  if (!planned || planned === task.dueDate) return null;
  return focusDateLabel(planned, today);
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. Negative when `to` is earlier. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
