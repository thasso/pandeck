/**
 * Regression test for the runtime-path engine→client SessionState bridge.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/connectionEngineState.test.ts
 *
 * On the runtime path the connection is NOT a direct engine viewer, and
 * adapter-native chat events do not carry engine metadata or store-backed card
 * updates. So clearing a pending question, task/toolGroup changes, notices, and
 * approval/review/peer-prompt lifecycles were lost, leaving stale panels and
 * approval buttons. `attachEngineStateViewer` forwards those non-chat envelopes;
 * chat-stream envelopes and run-state stay owned by the RuntimeTransport.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "conn-engine-state-test-"));
process.env.ASSISTANT_CWD = tmp;

const { Connection } = await import("./connection.ts");
const { ClaudeSdkSession } = await import("./claudeSdk/ClaudeSdkSession.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");

function makeConnection() {
  const sent: ServerMessage[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s) as ServerMessage),
  };
  const conn = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs);
  return { conn, sent };
}

{
  const { conn, sent } = makeConnection();

  // A minimal fake engine session that captures the viewer the connection adds.
  let captured: { send: (m: ServerMessage) => void } | undefined;
  const live = {
    id: "s1",
    addViewer(v: { send: (m: ServerMessage) => void }) {
      captured = v;
    },
    removeViewer() {
      captured = undefined;
    },
  };

  (
    conn as unknown as { attachEngineStateViewer: (l: unknown) => void }
  ).attachEngineStateViewer(live);
  assert.ok(
    captured,
    "the connection registered a viewer on the engine session",
  );

  // The engine broadcasts a fresh state with a pending question still set.
  // The forwarder must relay the metadata without becoming a run-state source.
  captured!.send({
    type: "state",
    state: { sessionId: "s1", pendingQuestion: { requestId: "q1" } } as never,
  });
  // Then the question is answered → engine re-broadcasts state with it cleared.
  captured!.send({ type: "state", state: { sessionId: "s1" } as never });
  // Non-chat session signals and store-backed overlays are forwarded.
  captured!.send({
    type: "contextInfo",
    sessionId: "s1",
    info: { sessionId: "s1" } as never,
  });
  captured!.send({ type: "notice", severity: "warning", message: "heads up" });
  captured!.send({
    type: "approvalUpdate",
    sessionId: "s1",
    approval: {
      renderKind: "approval",
      id: "appr-1",
      sessionId: "s1",
      kind: "jiraIssue",
      status: "pending",
      title: "Create Jira issue",
      createdAt: 1,
      body: { kind: "jiraIssue", items: [] },
    },
  });
  captured!.send({
    type: "peerPromptCardUpdate",
    sessionId: "s1",
    messageKey: "peer-1",
    state: "queued",
  });
  // Chat-stream envelopes are NOT forwarded (the RuntimeTransport owns those).
  captured!.send({ type: "assistantStart", sessionId: "s1", id: "a1" });
  captured!.send({ type: "textDelta", sessionId: "s1", id: "a1", delta: "hi" });

  const types = sent.map((m) => m.type);
  assert.deepEqual(
    types,
    [
      "state",
      "state",
      "contextInfo",
      "notice",
      "approvalUpdate",
      "peerPromptCardUpdate",
    ],
    "only non-chat session envelopes are forwarded, in order",
  );

  const states = sent.filter(
    (m): m is Extract<ServerMessage, { type: "state" }> => m.type === "state",
  );
  assert.ok(
    (states[0]!.state as { pendingQuestion?: unknown }).pendingQuestion,
    "first state still carries the pending question",
  );
  assert.equal(
    (states[1]!.state as { pendingQuestion?: unknown }).pendingQuestion,
    undefined,
    "the cleared-question state reaches the client (panel hides)",
  );

  // Detach removes the engine viewer so no further envelopes are forwarded.
  (conn as unknown as { detachRuntimeView: () => void }).detachRuntimeView();
  assert.equal(captured, undefined, "detach removes the engine state viewer");
}

{
  const sessionId = "conn-runtime-view-test";
  const { conn, sent } = makeConnection();
  const sdk = new ClaudeSdkSession(sessionId, {
    seam: async () => {
      throw new Error("prompt seam should not be used while viewing");
    },
  });
  const added: unknown[] = [];
  const originalAddViewer = sdk.addViewer.bind(sdk);
  sdk.addViewer = ((viewer: Parameters<typeof sdk.addViewer>[0]) => {
    added.push(viewer);
    originalAddViewer(viewer);
  }) as typeof sdk.addViewer;

  (conn as unknown as { view: (live: unknown) => void }).view(sdk);

  assert.deepEqual(
    sent.map((m) => m.type),
    // The grant list is a store overlay like approval cards, sent after it.
    ["snapshot", "approvalGrants"],
    "viewing sends exactly one runtime transport snapshot",
  );
  assert.equal(
    added.includes(conn),
    false,
    "viewing does not add the connection as a direct engine viewer",
  );
  assert.equal(
    added.length,
    1,
    "only the metadata bridge observes the engine session as a viewer",
  );

  (conn as unknown as { dispose: () => void }).dispose();
  await sessionRuntime.disposeSession(sessionId);
}

rmSync(tmp, { recursive: true, force: true });
console.log("connection engine-state bridge test: PASS");

test("bridges engine state into runtime-backed connections", () => {
  // Assertions run during module evaluation to preserve the former standalone script structure.
});
