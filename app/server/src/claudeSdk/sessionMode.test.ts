/**
 * Standalone test for the Build/Plan session-mode axis on the Claude harness
 * ([Task-329](pa://task/329)).
 *
 * Run through Vitest:
 *   `pnpm --filter @assistant/server test src/claudeSdk/sessionMode.test.ts`
 *
 * `options.test.ts` covers the tool policy a mode produces; this covers the
 * SESSION carrying it:
 *   1. A fresh session is `build`, and its turn is built with the full native set.
 *   2. Switching to Plan mid-conversation reaches the NEXT turn's query options —
 *      no `Write`/`Edit` or side-effecting app tools, while `Bash` and read-only
 *      `mcp__pa__*` tools remain — and switching back restores them.
 *   3. The mode is persisted on the record and restored from disk, so it
 *      survives a server restart (the store's rehydrate path), with the server
 *      record winning over a stale client's requested mode.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { ClaudeSdkSession } from "./ClaudeSdkSession.ts";
import type { ClaudeSdkRecord } from "./claudeSdkRecords.ts";
import { claudeSdkStore } from "./claudeSdkStore.ts";
import type { ClaudeQueryParams, ClaudeSdkSeam } from "./sdkSeam.ts";

const RESTORE_ID = `mode-restore-test-${Date.now()}`;

function recordFile(id: string): string {
  return join(DATA_DIR, "claude-sdk", `${id}.json`);
}

function cleanup(): void {
  try {
    rmSync(recordFile(RESTORE_ID), { force: true });
  } catch {
    // ignore
  }
}

/** An empty-stream seam that records the options each turn was built with. */
function capturingSeam(
  captured: ClaudeQueryParams["options"][],
): ClaudeSdkSeam {
  return {
    query(params: ClaudeQueryParams) {
      captured.push(params.options);
      return { async *[Symbol.asyncIterator]() {} };
    },
  };
}

async function main(): Promise<void> {
  cleanup();

  const captured: ClaudeQueryParams["options"][] = [];
  const session = new ClaudeSdkSession("mode-test", {
    seam: () => Promise.resolve(capturingSeam(captured)),
  });
  const adapter = session.createRuntimeAdapter();

  assert.equal(session.sessionMode, "build", "a fresh session is in Build");
  assert.equal(session.state().mode, "build", "state carries the mode");

  await adapter.prompt("build turn");
  const buildTools = captured[0]?.tools as string[];
  assert.ok(buildTools, "the first turn built query options");
  for (const t of ["Read", "Write", "Edit", "Bash"])
    assert.ok(buildTools.includes(t), `Build turn exposes ${t}`);

  // 2. Switch mid-conversation: allowed even though model/thinking are locked.
  session.setMode("plan");
  assert.equal(session.state().mode, "plan", "state reports the new mode");
  await adapter.prompt("plan turn");
  const planOptions = captured[1];
  const planTools = planOptions?.tools as string[];
  assert.ok(planTools, "the second turn built query options");
  for (const t of ["Write", "Edit"]) {
    assert.ok(
      !planTools.includes(t),
      `a session switched to Plan cannot call ${t} on the next turn`,
    );
    assert.ok(
      (planOptions?.disallowedTools as string[]).includes(t),
      `Plan disallows ${t} outright`,
    );
    const verdict = await planOptions!.canUseTool!(t, {}, {} as never);
    assert.ok(verdict, `Plan's canUseTool returns a verdict for ${t}`);
    assert.equal(verdict.behavior, "deny", `Plan's canUseTool denies ${t}`);
  }
  assert.ok(planTools.includes("Bash"), "a Plan turn still runs Bash");
  const mcpVerdict = await planOptions!.canUseTool!(
    "mcp__pa__task_read",
    {},
    {} as never,
  );
  assert.ok(
    mcpVerdict,
    "Plan's canUseTool returns a verdict for an mcp__pa__ tool",
  );
  assert.equal(
    mcpVerdict.behavior,
    "allow",
    "a Plan turn still reaches read-only mcp__pa__* tools",
  );
  const taskManageVerdict = await planOptions!.canUseTool!(
    "mcp__pa__task_manage",
    {},
    {} as never,
  );
  assert.ok(taskManageVerdict);
  assert.equal(
    taskManageVerdict.behavior,
    "allow",
    "a Plan turn permits durable Task mutations",
  );
  const mutatingMcpVerdict = await planOptions!.canUseTool!(
    "mcp__pa__kb_write_entry",
    {},
    {} as never,
  );
  assert.ok(mutatingMcpVerdict);
  assert.equal(mutatingMcpVerdict.behavior, "deny");
  assert.match(
    "message" in mutatingMcpVerdict ? (mutatingMcpVerdict.message ?? "") : "",
    /not available in Plan mode because it can make changes/,
  );

  session.setMode("build");
  await adapter.prompt("back to build");
  assert.ok(
    (captured[2]?.tools as string[]).includes("Edit"),
    "switching back to Build restores the mutating tools",
  );

  // 3. The record carries the mode…
  session.setMode("plan");
  assert.equal(
    session.toRecord().mode,
    "plan",
    "the persisted record carries the mode",
  );

  // …and a restart rehydrates it from disk. The store's acquire path is the
  // restart: a record on disk, no live instance. A stale client asking for
  // Build must not win over it.
  const record: ClaudeSdkRecord = {
    ...session.toRecord(),
    id: RESTORE_ID,
    entries: [],
  };
  mkdirSync(join(DATA_DIR, "claude-sdk"), { recursive: true });
  writeFileSync(
    recordFile(RESTORE_ID),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  const restored = claudeSdkStore.acquire(RESTORE_ID, { mode: "build" });
  assert.equal(
    restored.sessionMode,
    "plan",
    "the persisted mode survives a restart and beats a stale client's mode",
  );
  claudeSdkStore.remove(RESTORE_ID);

  session.dispose();
  console.log("claude-sdk session mode test: PASS");
}

test("carries the Build/Plan session mode into every turn and across restarts", async () => {
  try {
    await main();
  } finally {
    cleanup();
  }
});
