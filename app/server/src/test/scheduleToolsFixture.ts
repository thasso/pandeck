/**
 * Sessions, settings and calls for the Schedule tool tests
 * (`src/tools/schedules/scheduleTools*.test.ts`). The tools run as the
 * catalog builds them, with only "now" fixed; the zone and the limits come
 * from the real settings file.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getDb } from "../db/index.ts";
import { scheduleStore } from "../db/scheduleStore.ts";
import { sessionStore } from "../db/sessionStore.ts";
import type { ToolCallContext, ToolResult } from "../mcp/tool.ts";
import { scheduledPromptKey } from "../schedules/scheduledPrompts.ts";
import { canonicalSessionLogPath } from "../sessionStorage.ts";
import { getSettings } from "../settings.ts";
import { saveSettings } from "../settingsService.ts";
import { scheduleTools } from "../tools/schedules/scheduleTools.ts";

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const BERLIN = "Europe/Berlin";
/** Wed 25 Nov 2026 08:00 in Berlin (UTC+01:00). */
export const NOV25_0800 = Date.parse("2026-11-25T07:00:00Z");

/** The instant the tools read as now; a test moves it. */
export const clock = { now: NOV25_0800 };

let sequence = 0;
const seeded: string[] = [];

/** A user-scope session. */
export function seedSession(): string {
  const id = `schedule-tools-${sequence++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    title: id,
    scope: "user",
  });
  seeded.push(id);
  return id;
}

/** A session `parent` spawned, owned by it unless taken over. */
export function spawnChild(
  parent: string,
  ownership: "coordinator" | "taken-over" = "coordinator",
): string {
  const child = seedSession();
  sessionStore.linkSpawned(parent, child, Date.now(), ownership);
  return child;
}

/** Written through the settings service, like every settings write. */
export async function useSettings(
  schedules: { graceWindowMinutes?: number; cardlessLimit?: number } = {},
  timeZone = BERLIN,
): Promise<void> {
  const current = getSettings();
  await saveSettings({
    profile: { ...current.profile, timeZone },
    schedules: {
      ...current.schedules,
      graceWindowMinutes: 60,
      cardlessLimit: 10,
      ...schedules,
    },
  });
}

/** Forget every Schedule, Pause all and seeded session. */
export function resetScheduleTools(): void {
  getDb().exec("DELETE FROM schedule_occurrences");
  getDb().exec("DELETE FROM schedules");
  getDb().exec("DELETE FROM schedule_pause");
  for (const id of seeded.splice(0)) sessionStore.remove(id);
  clock.now = NOV25_0800;
}

const tools = () => scheduleTools({ now: () => clock.now });

function ctx(sessionId: string): ToolCallContext {
  return {
    toolCallId: `schedule-tools-${sequence++}`,
    session: { sessionId, harness: "pi", agentType: "developer" },
  };
}

function textOf(result: ToolResult): string {
  const block = result.content[0];
  assert.equal(block?.type, "text");
  return block.type === "text" ? block.text : "";
}

/** The compact JSON text, which the details mirror. */
function answer(result: ToolResult): unknown {
  const text = textOf(result);
  assert.ok(!text.includes("\n"), "compact JSON");
  assert.deepEqual(JSON.parse(text), result.details);
  return JSON.parse(text);
}

/** A create/update/enable/disable echo. */
export interface Echo {
  id: string;
  name: string;
  enabled: boolean;
  target: { sessionId: string };
  timing: Record<string, unknown>;
  timeZone: string;
  nextOccurrences: string[];
}

/** One `schedule_manage` result row. */
export interface RowResult {
  operation?: string;
  ok: boolean;
  id?: string;
  error?: string;
  deleted?: boolean;
  schedule?: Echo;
}

/** One Schedule as `schedule_read` shows it; by id it has the last two. */
export interface ReadItem {
  id: string;
  name: string;
  state: string;
  target: { sessionId: string };
  timing: Record<string, unknown>;
  next?: string;
  lastOccurrence?: Record<string, unknown>;
  createdBy: string;
  controlledBy: string;
  cardless: boolean;
  prompt: string;
  nextOccurrences?: string[];
  history?: Array<Record<string, unknown>>;
}

export interface ReadList {
  schedules: ReadItem[];
  count: number;
  truncated: boolean;
}

/** `schedule_read` of a list. */
export async function readList(
  caller: string,
  params: Record<string, unknown> = {},
): Promise<ReadList> {
  const tool = tools().find((t) => t.name === "schedule_read")!;
  return answer(await tool.execute(params, ctx(caller))) as ReadList;
}

/** `schedule_read` of one Schedule by id. */
export async function readOne(caller: string, id: string): Promise<ReadItem> {
  const tool = tools().find((t) => t.name === "schedule_read")!;
  return answer(await tool.execute({ id }, ctx(caller))) as ReadItem;
}

/** `schedule_manage`'s results, in row order. */
export async function manage(
  caller: string,
  operations: unknown[],
): Promise<RowResult[]> {
  const tool = tools().find((t) => t.name === "schedule_manage")!;
  return (
    answer(await tool.execute({ operations }, ctx(caller))) as {
      results: RowResult[];
    }
  ).results;
}

/** The error `schedule_manage` throws for these operations. */
export async function manageThrows(
  caller: string,
  operations: unknown,
): Promise<string> {
  const tool = tools().find((t) => t.name === "schedule_manage")!;
  try {
    await tool.execute({ operations }, ctx(caller));
  } catch (err) {
    return (err as Error).message;
  }
  assert.fail("schedule_manage should have thrown");
}

/** One row that must succeed; its result. */
export async function manageOne(
  caller: string,
  operation: Record<string, unknown>,
): Promise<RowResult & { schedule: Echo }> {
  const [result] = await manage(caller, [operation]);
  assert.equal(result?.ok, true, JSON.stringify(result));
  return result as RowResult & { schedule: Echo };
}

/** A daily 09:00 Schedule into `target`, created by `caller`; its id. */
export async function createDaily(
  caller: string,
  target = caller,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const result = await manageOne(caller, {
    operation: "create",
    name: "Daily check",
    prompt: "Check CI for PR #382 in pandeck; merge if green.",
    targetSessionId: target,
    timing: { kind: "daily", time: "09:00" },
    ...extra,
  });
  return result.schedule.id;
}

/** Write a canonical log holding the admitted user entry of `occurrenceId`. */
export function logAdmitted(sessionId: string, occurrenceId: string): void {
  const path = canonicalSessionLogPath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ v: 1, sessionId, createdAt: "x" })}\n${JSON.stringify({
      type: "message",
      role: "user",
      seq: 1,
      id: "e1",
      clientRequestId: scheduledPromptKey(occurrenceId),
    })}\n`,
  );
}

export function removeLog(sessionId: string): void {
  rmSync(canonicalSessionLogPath(sessionId), { force: true });
}

export function historyStates(scheduleId: string): string[] {
  return scheduleStore
    .history(scheduleId)
    .map((o) => `${new Date(o.dueAtMs).toISOString()} ${o.state}`);
}
