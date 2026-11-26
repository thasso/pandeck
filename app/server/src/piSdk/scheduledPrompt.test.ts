/**
 * A scheduled prompt delivered into a real pi session (`docs/schedules.md`,
 * "Delivering into an existing session").
 *   pnpm --filter @assistant/server test src/piSdk/scheduledPrompt.test.ts
 *
 * Native-wrapper evidence, offline: the production lane
 * (`deliverScheduledPrompts`), facade (`promptRuntimeSession` on the
 * process-global runtime), canonical log, admission reader and Schedule store
 * run for real against the real `PiLiveSession` over the real `localPiEngine`.
 * Only pi's `AgentSession` beneath the engine is a controlled stand-in, as in
 * `steerOnlyRefusal.test.ts`: it records the text pi would send the model and
 * runs one clean turn's events. No provider, network or model is reached.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const priorEnv = {
  DATA_DIR: process.env.DATA_DIR,
  ASSISTANT_CWD: process.env.ASSISTANT_CWD,
};
const dataDir = mkdtempSync(join(tmpdir(), "pi-scheduled-prompt-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const { PiLiveSession } = await import("./PiLiveSession.ts");
const { localPiEngine } = await import("./piEngine.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { scheduleStore } = await import("../db/scheduleStore.ts");
const { closeDb } = await import("../db/index.ts");
const { sessionRuntime } = await import("../session/runtimeInstance.ts");
const { findAdmittedUserEntry } =
  await import("../session/log/admittedUserEntry.ts");
const { canonicalSessionLogPath } = await import("../sessionStorage.ts");
const { deliverScheduledPrompts, scheduledPromptHeader } =
  await import("../schedules/scheduledPrompts.ts");

type Listener = (event: unknown) => void;

/**
 * The `AgentSession` surface a prompted turn touches. `prompt` records the
 * text pi would send the model, then waits for the test to finish the turn
 * with the events pi emits for one clean reply.
 */
function controlledAgentSession(sessionId: string) {
  const listeners: Listener[] = [];
  const prompts: string[] = [];
  let finishTurn: (() => void) | undefined;
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const reply = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
  };
  const session = {
    sessionId,
    sessionFile: undefined,
    // A named session skips auto-naming, which would run detached on
    // infrastructure this test does not stand up.
    sessionName: "Already named",
    isStreaming: false,
    model: undefined,
    thinkingLevel: undefined,
    messages: [] as unknown[],
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
      getHeader: () => undefined,
      getSessionId: () => sessionId,
      getLeafId: () => undefined,
      getEntry: () => undefined,
    },
    subscribe(listener: Listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
    getSessionStats: () => ({
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextSize: 0,
    }),
    steer: () => Promise.reject(new Error("no steer in this test")),
    dispose: () => {
      listeners.length = 0;
    },
    async prompt(text: string) {
      prompts.push(text);
      session.isStreaming = true;
      await new Promise<void>((resolve) => (finishTurn = resolve));
      emit({ type: "agent_start" });
      emit({ type: "message_start", message: reply });
      emit({ type: "message_end", message: reply });
      emit({ type: "agent_end", messages: [reply], willRetry: false });
      session.isStreaming = false;
      emit({ type: "agent_settled" });
    },
  };
  return {
    session,
    prompts,
    finish: () => {
      assert.ok(finishTurn, "a turn is waiting");
      finishTurn();
    },
  };
}

function host() {
  return {
    sessionRowsChanged: () => {},
    noteRunStarted: () => {},
    checkPendingReload: () => {},
    isReloadQueued: () => false,
    buildSessionState: () => ({}) as never,
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 5_000; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

/** Every record of the canonical log, each line parsed whole. */
function canonicalRecords(sessionId: string): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = readFileSync(canonicalSessionLogPath(sessionId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  assert.ok(raw.endsWith("\n"), "the canonical log ends on a whole record");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const MINUTE = 60_000;
const SESSION_ID = "pi-scheduled-prompt";
// Wednesday 24 November 2027, 15:45 in Berlin (CET, UTC+1): far from the
// real clock, so nothing else settles it.
const DUE_AT_MS = Date.parse("2027-11-24T14:45:00Z");
const NAME = "  PR \t CI\n check  ";
const PROMPT = "Check the PR's CI.\n\n  Report  failures with their job names.";

let live: InstanceType<typeof PiLiveSession> | undefined;

afterAll(async () => {
  sessionRuntime.closeForTeardown(SESSION_ID);
  live?.dispose();
  await sessionRuntime.disposeSession(SESSION_ID);
  closeDb();
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

test("the production lane delivers a claimed occurrence into a real pi session", async () => {
  sessionStore.upsert({
    id: SESSION_ID,
    harness: "pi",
    agentType: "assistant",
  });
  const scheduleId = scheduleStore.create(
    {
      name: NAME,
      prompt: PROMPT,
      timing: { kind: "daily", time: "15:45", timeZone: "Europe/Berlin" },
      target: { kind: "session", sessionId: SESSION_ID },
      createdBy: { kind: "session", sessionId: SESSION_ID },
      cardless: true,
    },
    DUE_AT_MS - 60 * MINUTE,
  ).id;
  const occurrence = scheduleStore.claimDue(scheduleId, DUE_AT_MS, {
    graceMs: 60 * MINUTE,
  }).claimed;
  assert.ok(occurrence, "the clock's claim of the due time");
  assert.equal(occurrence.state, "claimed");
  assert.equal(occurrence.attemptedAtMs, undefined);
  const key = `schedule:${occurrence.id}`;
  const header = `⏰ Scheduled prompt "PR CI check" · schedule \`${scheduleId}\` · due Wed 24 Nov 15:45 Europe/Berlin`;
  assert.equal(scheduledPromptHeader(occurrence), header);
  // The session starts with no conversation at all.
  assert.deepEqual(canonicalRecords(SESSION_ID), []);

  const agent = controlledAgentSession(SESSION_ID);
  live = new PiLiveSession(
    "assistant",
    localPiEngine(agent.session as never),
    host() as never,
    () => {},
  );

  const pass = deliverScheduledPrompts(live, () => true);
  await until(() => agent.prompts.length === 1);
  agent.finish();
  await pass;

  // 1. The model read the frozen header, a blank line, then the raw prompt.
  assert.equal(agent.prompts.length, 1, "one prompt sent to pi");
  assert.ok(
    agent.prompts[0]!.startsWith(`${header}\n\n${PROMPT}`),
    "the first model input starts with the header and the raw prompt",
  );

  // 2. The canonical log holds exactly one user entry: the prompt alone,
  // with its schedule origin and admission key.
  const users = canonicalRecords(SESSION_ID).filter(
    (record) => record.type === "message" && record.role === "user",
  );
  assert.equal(users.length, 1, "exactly one user entry in the session");
  const [user] = users;
  assert.deepEqual(user!.content, [{ type: "text", text: PROMPT }]);
  assert.deepEqual(user!.origin, {
    kind: "schedule",
    scheduleId,
    occurrenceId: occurrence.id,
    dueAtMs: DUE_AT_MS,
  });
  assert.equal(user!.clientRequestId, key);

  // 3. The production admission reader finds the keyed entry.
  assert.equal(findAdmittedUserEntry(SESSION_ID, key), "present");

  // 4. The occurrence was attempted through the lane and delivered.
  const settled = scheduleStore.getOccurrence(occurrence.id);
  assert.equal(settled?.state, "delivered");
  assert.ok(settled?.attemptedAtMs !== undefined, "the lane marked it");
  assert.deepEqual(scheduleStore.owedForTarget(SESSION_ID), []);
  assert.ok(sessionRuntime.get(SESSION_ID), "bound to the global runtime");
});
