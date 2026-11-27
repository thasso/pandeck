/**
 * The approved public surface of the Schedule tools (D6), character for
 * character, and the rules their prose carries (T6.10).
 *   pnpm --filter @assistant/server test src/tools/schedules/scheduleToolsSurface.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { assertPromptRules } from "../../test/promptRules.ts";
import { scheduleTools } from "./scheduleTools.ts";

const [read, manage] = scheduleTools();

test("schedule_read is exactly the approved surface", () => {
  assert.equal(read!.name, "schedule_read");
  assert.equal(read!.label, "Schedules: Read");
  assert.equal(
    read!.description,
    "List Schedules, or read one by id with its full prompt, next three occurrences and history. Every Schedule is readable, whoever created it. A list shows each Schedule's next and last occurrence with its prompt clipped.",
  );
  assert.equal(
    read!.searchHint,
    "schedule schedules timer reminder later recurring cron wall-clock occurrence",
  );
  assert.deepEqual(read!.parameters, {
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
      maxResults: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    },
  });
});

test("schedule_manage is exactly the approved surface, with typeless rows", () => {
  assert.equal(manage!.name, "schedule_manage");
  assert.equal(manage!.label, "Schedules: Manage");
  assert.equal(
    manage!.description,
    `Create, change, enable, disable or delete Schedules: a prompt delivered into a session at a wall-clock time, once or repeating (daily, weekdays, weekly or monthly; never more often than daily). A Schedule is for a time; to wait for a condition use Monitor or background work. Write the prompt so it stands on its own: by the time it arrives, compaction may have removed why it was set ("check CI for PR #382 in pandeck; merge if green", not "check it"). Without the user you may target only this session or a session you spawned and still own, change only Schedules this session controls, and keep a limited number of them. Times are in the user's time zone. Every result echoes the absolute local times of the next three occurrences.`,
  );
  assert.equal(
    manage!.searchHint,
    "schedule later remind at time tomorrow every day weekly monthly recurring prompt cron",
  );
  assert.deepEqual(manage!.parameters, {
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
        items: {
          description: "One operation.",
          properties: {
            operation: {
              description:
                "string — create, update, enable, disable or delete.",
            },
            id: {
              description:
                "string — the Schedule, for every operation but create.",
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
        },
      },
    },
  });
});

/** The rules no schema field states, pinned by pattern. */
test("Schedule tool descriptions carry their rules", () => {
  assertPromptRules({
    schedule_read: {
      text: read!.description,
      rules: {
        "universal-read": /Every Schedule is readable, whoever created it/,
        "list-clips-prompt": /prompt clipped/,
        "by-id-detail": /full prompt, next three occurrences and history/,
      },
    },
    schedule_manage: {
      text: manage!.description,
      rules: {
        "time-not-condition": /for a time; to wait for a condition use Monitor/,
        "self-contained-prompt": /stands on its own/,
        "near-targets-only":
          /target only this session or a session you spawned and still own/,
        "controls-only": /change only Schedules this session controls/,
        "limited-count": /keep a limited number of them/,
        "user-zone": /Times are in the user's time zone/,
        "echoes-next-three": /next three occurrences/,
        "at-most-daily": /never more often than daily/,
      },
    },
    "schedule_manage.timing": {
      text: JSON.stringify(manage!.parameters),
      rules: {
        "relative-day-elapsed": /1d is 24 hours/,
        "seconds-round-up": /seconds round up to the minute/,
        "month-clamp": /a shorter month uses its last day/,
        "inclusive-window": /inclusive YYYY-MM-DD dates/,
      },
    },
  });
});
