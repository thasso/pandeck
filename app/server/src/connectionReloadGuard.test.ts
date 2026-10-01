/**
 * Regression guard for the reload/shutdown drain gate in `connection.ts`.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/connectionReloadGuard.test.ts
 *
 * When a deploy/systemd stop starts a graceful drain (`hub.isReloadQueued()`),
 * `Connection.handle` rejects every run-starting client message so no new turn
 * begins and `runningCount()` can reach zero. Answering a pending question
 * resumes the session with a fresh hidden run, so it MUST be treated as
 * run-starting — otherwise answering a question card mid-drain keeps a session
 * running and the deploy hangs until the force timeout.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage } from "@assistant/shared";

process.env.ASSISTANT_CWD = mkdtempSync(
  join(tmpdir(), "conn-reload-guard-test-"),
);

const { isRunStartingMessage } = await import("./connection.ts");

test("respondToQuestion is a run-starting message (blocked during drain)", () => {
  const msg: ClientMessage = {
    type: "respondToQuestion",
    response: {
      requestId: "q-1",
      status: "cancelled",
      answers: [],
      submittedAt: 0,
    },
  };
  assert.equal(isRunStartingMessage(msg), true);
});

test("every command that resumes/starts a run is covered", () => {
  const runStarting: ClientMessage["type"][] = [
    "prompt",
    "harnessSend",
    "newSession",
    "createDraftSession",
    "runSlashCommand",
    "acceptCommitDryRun",
    "resolveApproval",
    "respondToQuestion",
  ];
  for (const type of runStarting) {
    assert.equal(
      isRunStartingMessage({ type } as ClientMessage),
      true,
      `${type} should be run-starting`,
    );
  }
  // A read-only command must not be gated by the drain.
  assert.equal(
    isRunStartingMessage({ type: "requestPeerPromptHistory" } as ClientMessage),
    false,
  );
});
