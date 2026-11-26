/**
 * `schedule_manage` rows at pi's entry (T6.12). pi validates and coerces a
 * call against the tool's schema BEFORE `execute`, and a schema failure there
 * refuses the whole call, so one malformed row would fail its siblings. The
 * row schema is typeless so that pi passes every row through untouched; this
 * holds that against pi-ai's real validator.
 *   pnpm --filter @assistant/server test src/piSdk/scheduleManageBoundary.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { scheduleStore } from "../db/scheduleStore.ts";
import {
  resetScheduleTools,
  seedSession,
  useSettings,
} from "../test/scheduleToolsFixture.ts";
import { agentToolsFor } from "../tools/catalog.ts";
import { toPiToolDefinitions } from "./agentToolAdapter.ts";

beforeEach(() => useSettings());
afterEach(() => resetScheduleTools());

describe("schedule_manage rows at pi's boundary", () => {
  it("pi's validator passes every row through unchanged, and execute isolates the bad ones", async () => {
    const me = seedSession();
    const tool = agentToolsFor("developer").find(
      (candidate) => candidate.name === "schedule_manage",
    )!;
    const [definition] = toPiToolDefinitions([tool], {
      session: () => ({
        sessionId: me,
        harness: "pi",
        agentType: "developer",
      }),
    });
    const create = {
      operation: "create",
      name: "Check",
      prompt: "Check CI for PR #382 in pandeck; merge if green.",
      targetSessionId: me,
      timing: { kind: "once", at: "in 45m" },
    };
    const operations: unknown[] = [
      create,
      "not a row",
      null,
      { ...create, enabled: "true" },
      { ...create, timing: { kind: "once", at: 1700000000000 } },
      { operation: "disable", id: 12 },
      { ...create, name: 5 },
      create,
    ];
    const validated = validateToolArguments(
      {
        name: definition!.name,
        description: definition!.description,
        parameters: definition!.parameters,
      } as never,
      {
        type: "toolCall",
        id: "call-1",
        name: definition!.name,
        arguments: { operations: structuredClone(operations) },
      } as never,
    );
    // Nothing coerced ("true" stays a string, 12 a number), no null dropped.
    assert.deepEqual(validated, { operations });
    const result = await definition!.execute(
      "call-1",
      validated as never,
      undefined,
      undefined,
      undefined as never,
    );
    const results = (
      result.details as { results: Array<{ ok: boolean; error?: string }> }
    ).results;
    assert.deepEqual(
      results.map((r) => r.error ?? "ok"),
      [
        "ok",
        "An operation must be an object.",
        "An operation must be an object.",
        "enabled must be a boolean.",
        'timing.at must be a local date-time ("2026-11-25 15:45"), an ISO time with offset, or a relative time ("in 45m", "in 2h", "in 1d").',
        "id must be a string.",
        "Schedule name must be a non-empty string",
        "ok",
      ],
    );
    assert.equal(scheduleStore.list().length, 2);
  });
});
