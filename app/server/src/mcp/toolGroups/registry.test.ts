/**
 * Tests for the browser tool-group registry (`registry.ts`).
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/mcp/toolGroups/registry.test.ts
 *
 * Covers: both packs' tools are ordinary, always-listed AgentTools (no
 * separate per-session enable/approval state), the artifact side-store, the
 * post-reload continuation, and session-teardown cleanup.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config.ts";
import {
  cancelPostReloadContinuation,
  consumePostReloadContinuation,
  deleteToolGroupSessionData,
  getPendingPostReloadContinuation,
  queuePostReloadContinuationTool,
  toolsForToolGroup,
} from "./registry.ts";
import { listSessionArtifacts } from "./packRuntime.ts";

const sessionsToClean: string[] = [];

afterEach(() => {
  for (const sessionId of sessionsToClean.splice(0))
    deleteToolGroupSessionData(sessionId);
  cancelPostReloadContinuation();
});

test("toolsForToolGroup returns the packs' materialized tools", () => {
  const browserNames = toolsForToolGroup("browser").map((tool) => tool.name);
  for (const expected of [
    "browser_navigate",
    "browser_snapshot",
    "browser_screenshot",
    "browser_close",
  ]) {
    assert.ok(
      browserNames.includes(expected),
      `browser pack is missing ${expected}`,
    );
  }
  const rawNames = toolsForToolGroup("browser-raw-mcp").map(
    (tool) => tool.name,
  );
  assert.deepEqual(rawNames, ["browser_mcp_call"]);
});

test("deleteToolGroupSessionData clears the artifact side-store and files", () => {
  const ID = `registry-artifacts-${Date.now()}`;
  sessionsToClean.push(ID);
  assert.deepEqual(listSessionArtifacts(ID), []);
  const file = join(DATA_DIR, "session-tool-groups", `${ID}.json`);
  deleteToolGroupSessionData(ID);
  assert.ok(!existsSync(file));
});

test("workshop_defer_after_reload queues a continuation from the tool call's own session identity", async () => {
  const ID = `registry-reload-${Date.now()}`;
  const sessionFile = join(DATA_DIR, "sessions", `${ID}.jsonl`);
  const result = await queuePostReloadContinuationTool.execute(
    { message: "Verify the change after reload.", reason: "server edit" },
    {
      toolCallId: "call-1",
      session: {
        sessionId: ID,
        harness: "pi",
        agentType: "workshop",
        sessionFile,
      },
    },
  );
  assert.match(
    (result.content[0] as { text: string }).text,
    /Post-reload continuation queued/,
  );

  const pending = getPendingPostReloadContinuation(ID);
  assert.ok(pending);
  assert.equal(pending!.message, "Verify the change after reload.");
  assert.equal(pending!.reason, "server edit");

  const consumed = consumePostReloadContinuation();
  assert.ok(consumed);
  assert.equal(consumed!.sessionId, ID);
  assert.equal(consumed!.sessionFile, sessionFile);
  assert.equal(
    getPendingPostReloadContinuation(ID),
    undefined,
    "consuming removes the pending file",
  );
});

test("workshop_defer_after_reload requires an already-persisted session", async () => {
  await assert.rejects(
    () =>
      queuePostReloadContinuationTool.execute(
        { message: "Verify later." },
        {
          toolCallId: "call-2",
          session: {
            sessionId: "unpersisted",
            harness: "pi",
            agentType: "workshop",
          },
        },
      ),
    /not persisted yet/,
  );
});

test("cancelPostReloadContinuation removes a queued continuation", async () => {
  const ID = `registry-cancel-${Date.now()}`;
  const sessionFile = join(DATA_DIR, "sessions", `${ID}.jsonl`);
  await queuePostReloadContinuationTool.execute(
    { message: "Verify." },
    {
      toolCallId: "call-3",
      session: {
        sessionId: ID,
        harness: "pi",
        agentType: "workshop",
        sessionFile,
      },
    },
  );
  cancelPostReloadContinuation();
  assert.equal(getPendingPostReloadContinuation(ID), undefined);
});
