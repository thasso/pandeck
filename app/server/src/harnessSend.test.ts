/**
 * Standalone unit test for the unified `harnessSend` wire message (refactor
 * sub-stage Stage2-A).
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/harnessSend.test.ts
 *
 * Two things are asserted, MECHANICS-ONLY (no live model / SDK / dev server):
 *   1. `validateHarnessSend` accepts a well-formed sdk message and rejects
 *      messages missing the required `harness`/`agentType`/`id`/`text`.
 *   2. The `Connection.handle` dispatch for `harnessSend` routes to the
 *      harness-specific create-on-first-prompt paths. We stub the private
 *      helpers so no real session or SDK/pi query is created — only the branch
 *      decision is exercised.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Root the data dir at an isolated temp dir BEFORE importing the connection/hub.
const tmp = mkdtempSync(join(tmpdir(), "harness-send-test-"));
process.env.ASSISTANT_CWD = tmp;

const { validateClientMessage } = await import("./validateClientMessage.ts");
const { Connection } = await import("./connection.ts");

/* --------------------------- 1. validation --------------------------- */

function wellFormed(harness: string) {
  return {
    type: "harnessSend",
    id: "abc",
    harness,
    agentType: "workshop",
    text: "hello",
  };
}

{
  const okSdk = validateClientMessage(wellFormed("claude-sdk"));
  assert.equal(
    okSdk.ok,
    true,
    "well-formed claude-sdk harnessSend should validate",
  );

  // Optional fields of the right kind are accepted.
  const okOptional = validateClientMessage({
    ...wellFormed("claude-sdk"),
    modelId: "opus",
    thinkingLevel: "high",
    attachTaskId: "t1",
    projectId: "p1",
  });
  assert.equal(
    okOptional.ok,
    true,
    "optional fields of the right kind should validate",
  );

  // Missing required fields are rejected.
  for (const missing of ["id", "harness", "agentType", "text"] as const) {
    const bad: Record<string, unknown> = wellFormed("claude-sdk");
    delete bad[missing];
    const res = validateClientMessage(bad);
    assert.equal(
      res.ok,
      false,
      `harnessSend missing ${missing} should be rejected`,
    );
  }

  // Wrong-kind optional field rejected.
  const badAttachments = validateClientMessage({
    ...wellFormed("claude-sdk"),
    attachments: "nope",
  });
  assert.equal(
    badAttachments.ok,
    false,
    "non-array attachments should be rejected",
  );
}

/* --------------------------- 2. dispatch --------------------------- */

function makeConnection() {
  const sent: unknown[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s)),
  };
  // The constructor takes (ws, initialRoute?); the ws shape is all `send()` uses.
  const conn = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs);
  return { conn, sent };
}

{
  const { conn } = makeConnection();
  const calls: Array<{ which: string; msg: Record<string, unknown> }> = [];
  // Stub the private create-on-first-prompt helper so dispatch is observable
  // without creating a real session / SDK query.
  (conn as Record<string, unknown>).handleClaudeSdkSend = async (
    msg: Record<string, unknown>,
  ) => {
    calls.push({ which: "sdk", msg });
  };

  const handle = (
    conn as unknown as { handle: (m: unknown) => Promise<void> }
  ).handle.bind(conn);

  // claude-sdk → sdk path.
  await handle({
    type: "harnessSend",
    id: "s1",
    harness: "claude-sdk",
    agentType: "workshop",
    text: "hi",
  });
  assert.equal(calls.length, 1, "sdk harnessSend should dispatch once");
  assert.equal(
    calls[0]?.which,
    "sdk",
    "claude-sdk should route to the sdk path",
  );
}

{
  // pi harness → pi create-on-first-prompt path.
  const { conn } = makeConnection();
  const calls: Array<{ which: string; msg: Record<string, unknown> }> = [];
  (conn as Record<string, unknown>).handleClaudeSdkSend = async (
    msg: Record<string, unknown>,
  ) => {
    calls.push({ which: "sdk", msg });
  };
  (conn as Record<string, unknown>).handlePiFirstSend = async (
    msg: Record<string, unknown>,
  ) => {
    calls.push({ which: "pi", msg });
  };
  const handle = (
    conn as unknown as { handle: (m: unknown) => Promise<void> }
  ).handle.bind(conn);

  await handle({
    type: "harnessSend",
    id: "p1",
    harness: "pi",
    agentType: "assistant",
    text: "hi",
  });
  assert.equal(calls.length, 1, "pi harnessSend should dispatch once");
  assert.equal(calls[0]?.which, "pi", "pi should route to the pi path");
}

rmSync(tmp, { recursive: true, force: true });
console.log("harnessSend unit test: PASS");

test("validates and dispatches harnessSend messages", () => {
  // Assertions run during module evaluation to preserve the former standalone script structure.
});
