/**
 * `schedule_read` and `schedule_manage` (`docs/schedules.md`, Agent tools):
 * an agent reads every Schedule and, without a card, manages the ones it
 * created for a NEAR target, its own session or a direct child it spawned and
 * still owns, within its cardless limit.
 *
 * Every manage row is authorized and written in one synchronous block, with
 * no await between reading the stored Schedule and the store call. Authority
 * is never read from the row: a create is always the calling session's own,
 * cardless, in the user's current zone. The store owns the cutovers, the
 * cardless capacity and the admission-aware ending of claimed occurrences;
 * this module only passes it the current settings.
 *
 * Rows are independent: each one is written whole or not at all and reports
 * its own result, so a call throws only for a bad top level or when every row
 * failed. The row schema is typeless (`tools/CLAUDE.md`); `execute` checks it.
 */
// The admission resolver registers when this module loads, so a store end of
// an attempted occurrence this tool triggers never runs without it.
import "../../schedules/scheduledPrompts.ts";
import {
  nextOccurrencesAfter,
  formatScheduleInstant,
  scheduleTimingError,
  scheduleTimingFutureError,
  type ScheduleActor,
  type ScheduleOccurrenceSummary,
  type ScheduleSummary,
  type ScheduleTiming,
} from "@assistant/shared/schedules";
import {
  ScheduleCardlessLimitError,
  scheduleStore,
  type ScheduleUpdate,
} from "../../db/scheduleStore.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import { getSettings } from "../../settings.ts";
import { userTimeZone } from "../../userProfile.ts";
import {
  defineAgentTool,
  type AgentTool,
  type ToolResult,
} from "../../mcp/tool.ts";
import { parseOnceAt } from "./timingInput.ts";

const READ_DEFAULT = 50;
const READ_MAX = 100;
const MANAGE_MAX_ROWS = 20;
const LIST_PROMPT_CHARS = 200;
const HISTORY_MAX = 50;
const NEXT_OCCURRENCES = 3;
const MINUTE_MS = 60_000;

const OPERATIONS = ["create", "update", "enable", "disable", "delete"] as const;
type Operation = (typeof OPERATIONS)[number];

/** The fields each operation takes, `operation` aside. */
const ROW_FIELDS: Record<Operation, readonly string[]> = {
  create: ["name", "prompt", "targetSessionId", "timing", "enabled"],
  update: ["id", "name", "prompt", "targetSessionId", "timing"],
  enable: ["id"],
  disable: ["id"],
  delete: ["id"],
};

const ONCE_FIELDS = ["kind", "at"];
const REPEAT_FIELDS = ["kind", "time", "days", "day", "startsOn", "endsOn"];

interface ScheduleToolsOptions {
  /** The instant a call treats as now; the wall clock in production. */
  now?: () => number;
}

export function scheduleTools(options: ScheduleToolsOptions = {}): AgentTool[] {
  const now = options.now ?? Date.now;
  return [readTool(now), manageTool(now)];
}

/* ---------------------------------- read ---------------------------------- */

const READ_STATES = ["enabled", "disabled", "done"] as const;
type ReadState = (typeof READ_STATES)[number];

function readTool(now: () => number) {
  return defineAgentTool<{
    id?: unknown;
    targetSessionId?: unknown;
    createdBy?: unknown;
    state?: unknown;
    maxResults?: unknown;
  }>({
    name: "schedule_read",
    label: "Schedules: Read",
    description:
      "List Schedules, or read one by id with its full prompt, next three occurrences and history. Every Schedule is readable, whoever created it. A list shows each Schedule's next and last occurrence with its prompt clipped.",
    searchHint:
      "schedule schedules timer reminder later recurring cron wall-clock occurrence",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "One Schedule by id, e.g. sch_12." },
        targetSessionId: {
          type: "string",
          description: "Only Schedules that deliver into this session.",
        },
        createdBy: {
          type: "string",
          description: 'Only Schedules created by this session id, or "user".',
        },
        state: { type: "string", enum: ["enabled", "disabled", "done"] },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 50,
        },
      },
    },
    async execute(params) {
      const id = optionalString(params.id, "id");
      if (id !== undefined) {
        const schedule = scheduleStore.get(id);
        if (!schedule) throw new Error(`Schedule not found: ${id}`);
        return compact(detailOf(schedule, now()));
      }
      const target = optionalString(params.targetSessionId, "targetSessionId");
      const createdBy = optionalString(params.createdBy, "createdBy");
      const state = params.state;
      if (
        state !== undefined &&
        !(READ_STATES as readonly unknown[]).includes(state)
      )
        throw new Error("state must be enabled, disabled or done.");
      const max = params.maxResults ?? READ_DEFAULT;
      if (
        typeof max !== "number" ||
        !Number.isInteger(max) ||
        max < 1 ||
        max > READ_MAX
      )
        throw new Error(
          `maxResults must be a whole number from 1 to ${READ_MAX}.`,
        );
      const matched = scheduleStore
        .list()
        .filter(
          (schedule) =>
            (target === undefined || schedule.target.sessionId === target) &&
            (createdBy === undefined ||
              actorText(schedule.createdBy) === createdBy) &&
            (state === undefined || stateOf(schedule) === state),
        );
      const kept = matched.slice(0, max);
      return compact({
        schedules: kept.map(listItemOf),
        count: kept.length,
        truncated: matched.length > kept.length,
      });
    },
  });
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function stateOf(schedule: ScheduleSummary): ReadState {
  if (schedule.doneAtMs !== undefined) return "done";
  return schedule.enabled ? "enabled" : "disabled";
}

/** An actor as the read's `createdBy` filter names it. */
function actorText(actor: ScheduleActor): string {
  return actor.kind === "user" ? "user" : actor.sessionId;
}

function instant(ms: number, schedule: ScheduleSummary): string {
  return formatScheduleInstant(ms, schedule.timing.timeZone);
}

/** The read fields a list and a read by id share, prompt aside. */
function headOf(schedule: ScheduleSummary) {
  const last = schedule.lastOccurrence;
  return {
    id: schedule.id,
    name: schedule.name,
    state: stateOf(schedule),
    target: { sessionId: schedule.target.sessionId },
    timing: schedule.timing,
    ...(schedule.nextDueAtMs !== undefined
      ? { next: instant(schedule.nextDueAtMs, schedule) }
      : {}),
    ...(last
      ? {
          lastOccurrence: {
            state: last.state,
            due: instant(last.dueAtMs, schedule),
            ...(last.error !== undefined ? { error: last.error } : {}),
            ...(last.sessionId !== undefined
              ? { sessionId: last.sessionId }
              : {}),
          },
        }
      : {}),
    createdBy: actorText(schedule.createdBy),
    controlledBy: actorText(schedule.controlledBy),
    cardless: schedule.cardless,
  };
}

function listItemOf(schedule: ScheduleSummary) {
  return { ...headOf(schedule), prompt: clipPrompt(schedule.prompt) };
}

function clipPrompt(prompt: string): string {
  const chars = Array.from(prompt);
  return chars.length <= LIST_PROMPT_CHARS
    ? prompt
    : `${chars.slice(0, LIST_PROMPT_CHARS).join("")}…`;
}

function detailOf(schedule: ScheduleSummary, nowMs: number) {
  return {
    ...headOf(schedule),
    prompt: schedule.prompt,
    nextOccurrences: nextOccurrencesOf(schedule, nowMs),
    history: scheduleStore
      .history(schedule.id)
      .slice(0, HISTORY_MAX)
      .map((occurrence) => historyItemOf(occurrence, schedule)),
  };
}

function historyItemOf(
  occurrence: ScheduleOccurrenceSummary,
  schedule: ScheduleSummary,
) {
  return {
    id: occurrence.id,
    state: occurrence.state,
    due: instant(occurrence.dueAtMs, schedule),
    ...(occurrence.claimedAtMs !== undefined
      ? { claimed: instant(occurrence.claimedAtMs, schedule) }
      : {}),
    ...(occurrence.endedAtMs !== undefined
      ? { ended: instant(occurrence.endedAtMs, schedule) }
      : {}),
    ...(occurrence.sessionId !== undefined
      ? { sessionId: occurrence.sessionId }
      : {}),
    ...(occurrence.error !== undefined ? { error: occurrence.error } : {}),
  };
}

/** The next three occurrences after `nowMs`; none for a disabled or done Schedule. */
function nextOccurrencesOf(schedule: ScheduleSummary, nowMs: number): string[] {
  if (!schedule.enabled || schedule.doneAtMs !== undefined) return [];
  return nextOccurrencesAfter(schedule.timing, nowMs, NEXT_OCCURRENCES).map(
    (ms) => instant(ms, schedule),
  );
}

/** A compact JSON answer: the text is the payload, also kept as details. */
function compact(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}

/* --------------------------------- manage --------------------------------- */

/*
 * The row schema is deliberately TYPELESS, as `session_send_prompt`'s is: pi
 * validates a call against the schema before `execute` and refuses the WHOLE
 * call on a failure, so one malformed row would fail its siblings. The types
 * live in the descriptions; `execute` checks each row.
 */
const ROW = {
  description: "One operation.",
  properties: {
    operation: {
      description: "string — create, update, enable, disable or delete.",
    },
    id: {
      description: "string — the Schedule, for every operation but create.",
    },
    name: {
      description:
        "string — create (required), update. A short label; the target sees it in the prompt's header.",
    },
    prompt: {
      description:
        "string — create (required), update. Plain Markdown; no attachments, /skill commands or placeholders.",
    },
    targetSessionId: {
      description:
        "string — create (required), update. This session's id, or a session it spawned and still owns.",
    },
    timing: {
      description:
        'object — create (required), update (replaces the whole timing). {kind:"once", at} where at is a local date-time "2026-11-25 15:45", an ISO time with offset "2026-11-25T15:45+01:00", or a relative "in 45m", "in 2h", "in 1d" (1d is 24 hours); seconds round up to the minute. Repeating: {kind:"daily"|"weekdays", time:"HH:MM"}, {kind:"weekly", days:["mon",…], time}, {kind:"monthly", day:1–31, time} (a shorter month uses its last day); each may add startsOn and endsOn, inclusive YYYY-MM-DD dates.',
    },
    enabled: { description: "boolean — create only; default true." },
  },
} as const;

type RowResult =
  | { operation: string; ok: true; schedule: ScheduleEcho }
  | { operation: "delete"; ok: true; id: string; deleted: true }
  | { operation?: string; ok: false; id?: string; error: string };

interface ScheduleEcho {
  id: string;
  name: string;
  enabled: boolean;
  target: { sessionId: string };
  timing: ScheduleTiming;
  timeZone: string;
  nextOccurrences: string[];
}

function manageTool(now: () => number) {
  return defineAgentTool<{ operations?: unknown }>({
    name: "schedule_manage",
    label: "Schedules: Manage",
    description:
      'Create, change, enable, disable or delete Schedules: a prompt delivered into a session at a wall-clock time, once or repeating (daily, weekdays, weekly or monthly; never more often than daily). A Schedule is for a time; to wait for a condition use Monitor or background work. Write the prompt so it stands on its own: by the time it arrives, compaction may have removed why it was set ("check CI for PR #382 in pandeck; merge if green", not "check it"). Without the user you may target only this session or a session you spawned and still own, change only Schedules this session controls, and keep a limited number of them. Times are in the user\'s time zone. Every result echoes the absolute local times of the next three occurrences.',
    searchHint:
      "schedule later remind at time tomorrow every day weekly monthly recurring prompt cron",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["operations"],
      properties: {
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          description:
            "Applied in order; each one is written whole or not at all, and fails alone.",
          items: ROW,
        },
      },
    },
    async execute(params, ctx) {
      const rows = topLevelRows(params);
      const caller = ctx.session.sessionId;
      const results = rows.map((raw) => runRow(raw, caller, now()));
      const failed = results.find((result) => !result.ok);
      if (failed && results.every((result) => !result.ok))
        throw new Error(failed.error);
      return compact({ results });
    },
  });
}

function topLevelRows(params: Record<string, unknown>): unknown[] {
  const stray = Object.keys(params).filter(
    (key) => key !== "operations" && params[key] !== undefined,
  );
  if (stray.length > 0)
    throw new Error(
      `schedule_manage takes only operations; got ${stray.join(", ")}.`,
    );
  const rows = params.operations;
  if (!Array.isArray(rows))
    throw new Error("operations must be an array of operation objects.");
  if (rows.length === 0 || rows.length > MANAGE_MAX_ROWS)
    throw new Error(
      `operations takes 1 to ${MANAGE_MAX_ROWS} operations; got ${rows.length}.`,
    );
  return rows;
}

/** One row, checked, authorized and written with no await in between. */
function runRow(raw: unknown, caller: string, nowMs: number): RowResult {
  const row =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const operation =
    typeof row?.operation === "string" ? row.operation : undefined;
  const id = typeof row?.id === "string" ? row.id : undefined;
  try {
    if (!row) throw new Error("An operation must be an object.");
    if (!(OPERATIONS as readonly unknown[]).includes(operation))
      throw new Error(
        "operation must be create, update, enable, disable or delete.",
      );
    const op = operation as Operation;
    const unknown = Object.keys(row).filter(
      (key) =>
        key !== "operation" &&
        row[key] !== undefined &&
        !ROW_FIELDS[op].includes(key),
    );
    if (unknown.length > 0)
      throw new Error(
        `${anOperation(op)} does not take ${unknown.join(", ")}.`,
      );
    if (op === "create") return createRow(row, caller, nowMs);
    if (row.id === undefined) throw new Error(`${anOperation(op)} needs id.`);
    if (typeof row.id !== "string") throw new Error("id must be a string.");
    return changeRow(op, row.id, row, caller, nowMs);
  } catch (err) {
    return {
      ...(operation !== undefined ? { operation } : {}),
      ok: false,
      ...(id !== undefined ? { id } : {}),
      error: rowError(err),
    };
  }
}

function anOperation(op: Operation): string {
  return `${/^[aeiou]/.test(op) ? "An" : "A"} ${op} operation`;
}

function rowError(err: unknown): string {
  if (err instanceof ScheduleCardlessLimitError)
    return `This session already controls ${err.count} Schedules it created (limit ${err.limit}, disabled ones included); delete one or ask the user.`;
  return err instanceof Error ? err.message : String(err);
}

function writePolicy() {
  const settings = getSettings().schedules;
  return {
    graceMs: settings.graceWindowMinutes * MINUTE_MS,
    cardlessLimit: settings.cardlessLimit,
  };
}

function createRow(
  row: Record<string, unknown>,
  caller: string,
  nowMs: number,
): RowResult {
  const targetSessionId = targetOf(row.targetSessionId);
  if (row.enabled !== undefined && typeof row.enabled !== "boolean")
    throw new Error("enabled must be a boolean.");
  const timing = timingOf(row.timing, userTimeZone(), nowMs);
  assertNear(caller, targetSessionId);
  const self: ScheduleActor = { kind: "session", sessionId: caller };
  const schedule = scheduleStore.create(
    {
      name: row.name as string,
      prompt: row.prompt as string,
      timing,
      target: { kind: "session", sessionId: targetSessionId },
      createdBy: self,
      controlledBy: self,
      cardless: true,
      ...(row.enabled !== undefined ? { enabled: row.enabled as boolean } : {}),
    },
    nowMs,
    { cardlessLimit: writePolicy().cardlessLimit },
  );
  return { operation: "create", ok: true, schedule: echoOf(schedule, nowMs) };
}

function changeRow(
  op: Exclude<Operation, "create">,
  id: string,
  row: Record<string, unknown>,
  caller: string,
  nowMs: number,
): RowResult {
  const stored = scheduleStore.get(id);
  if (!stored) throw new Error(`Schedule not found: ${id}`);
  const controller = stored.controlledBy;
  if (controller.kind !== "session" || controller.sessionId !== caller)
    throw new Error(
      `Schedule ${id} is controlled by ${controller.kind === "user" ? "the user" : `session ${controller.sessionId}`}; ask the user to change it.`,
    );
  assertNear(caller, stored.target.sessionId);
  if (op === "delete") {
    if (!scheduleStore.delete(id, nowMs))
      throw new Error(`Schedule not found: ${id}`);
    return { operation: "delete", ok: true, id, deleted: true };
  }
  const policy = writePolicy();
  let schedule: ScheduleSummary | undefined;
  if (op === "update") {
    const patch: ScheduleUpdate = {};
    if (row.name !== undefined) patch.name = row.name as string;
    if (row.prompt !== undefined) patch.prompt = row.prompt as string;
    if (row.targetSessionId !== undefined) {
      const target = targetOf(row.targetSessionId);
      if (target !== stored.target.sessionId) assertNear(caller, target);
      patch.target = { kind: "session", sessionId: target };
    }
    if (row.timing !== undefined)
      patch.timing = timingOf(row.timing, stored.timing.timeZone, nowMs);
    schedule = scheduleStore.update(id, patch, policy, nowMs);
  } else
    schedule = scheduleStore.setEnabled(id, op === "enable", nowMs, policy);
  if (!schedule) throw new Error(`Schedule not found: ${id}`);
  return { operation: op, ok: true, schedule: echoOf(schedule, nowMs) };
}

function targetOf(value: unknown): string {
  if (value === undefined)
    throw new Error("A create operation needs targetSessionId.");
  if (typeof value !== "string")
    throw new Error("targetSessionId must be a string.");
  return value;
}

/**
 * Refuse a target that is not near the caller: its own session, or a direct
 * child with a `spawned` edge from it that it still owns. The target must
 * exist and not be deleted; an archived one is near (delivery unarchives it).
 */
function assertNear(caller: string, targetId: string): void {
  if (!sessionStore.get(targetId))
    throw new Error(`Session not found: ${targetId}`);
  if (targetId === caller) return;
  const spawn = sessionStore.spawnedParentsByChildIds([targetId]).get(targetId);
  if (spawn?.parentSessionId === caller && spawn.ownership === "coordinator")
    return;
  throw new Error(
    `Session ${targetId} is neither this session nor a session it spawned and still owns; ask the user to schedule into it.`,
  );
}

/**
 * A row's timing in the stored shape, in `timeZone`: the profile zone on
 * create, the Schedule's stored zone on update. A row never names a zone.
 * Every supplied timing needs a future occurrence, checked before any write:
 * the store would take a spent one on update, cutting over the old dues and
 * leaving the Schedule done, and an agent ends a Schedule by disabling or
 * deleting it instead.
 */
function timingOf(
  value: unknown,
  timeZone: string,
  nowMs: number,
): ScheduleTiming {
  const timing = suppliedTiming(value, timeZone, nowMs);
  // The store's own validation message, for a timing it would refuse anyway.
  const reason =
    scheduleTimingError(timing) ?? scheduleTimingFutureError(timing, nowMs);
  if (reason) throw new Error(reason);
  return timing;
}

function suppliedTiming(
  value: unknown,
  timeZone: string,
  nowMs: number,
): ScheduleTiming {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("timing must be an object");
  const timing = value as Record<string, unknown>;
  const fields = timing.kind === "once" ? ONCE_FIELDS : REPEAT_FIELDS;
  const unknown = Object.keys(timing).filter(
    (key) => timing[key] !== undefined && !fields.includes(key),
  );
  if (unknown.length > 0)
    throw new Error(`timing does not take ${unknown.join(", ")}.`);
  if (timing.kind === "once")
    return {
      kind: "once",
      ...parseOnceAt(timing.at, timeZone, nowMs),
      timeZone,
    };
  // The store validates the repeating shape and gives its own message.
  return { ...timing, timeZone } as ScheduleTiming;
}

function echoOf(schedule: ScheduleSummary, nowMs: number): ScheduleEcho {
  return {
    id: schedule.id,
    name: schedule.name,
    enabled: schedule.enabled,
    target: { sessionId: schedule.target.sessionId },
    timing: schedule.timing,
    timeZone: schedule.timing.timeZone,
    nextOccurrences: nextOccurrencesOf(schedule, nowMs),
  };
}
