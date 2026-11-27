/**
 * A scheduled prompt delivered into a real Claude session (`docs/schedules.md`,
 * "Delivering into an existing session").
 *   pnpm --filter @assistant/server test src/claudeSdk/ClaudeSdkSession.scheduledPrompt.test.ts
 *
 * Native-wrapper evidence, offline: the production lane
 * (`deliverScheduledPrompts`), facade (`promptRuntimeSession` on the
 * process-global runtime), canonical log, admission reader and Schedule store
 * all run for real against the real `ClaudeSdkSession`. Only the SDK `query`
 * is a controlled stand-in (the `sdkSeam.ts` injection point): it records the
 * user messages the CLI would read and answers with a clean `result`. No
 * provider, network or model is reached.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import type {
  ClaudeQuery,
  ClaudeQueryParams,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
  ClaudeSdkUserMessage,
} from "./sdkSeam.ts";
import { enableClaudeSdkForTests } from "../test/claudeSdkEnabled.ts";
import { seedLegacyDefaultAccounts } from "../test/legacyDefaultAccounts.ts";

const priorEnv = {
  DATA_DIR: process.env.DATA_DIR,
  ASSISTANT_CWD: process.env.ASSISTANT_CWD,
};
const dataDir = mkdtempSync(join(tmpdir(), "claude-scheduled-prompt-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const { ClaudeSdkSession } = await import("../test/claudeSdkSession.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { scheduleStore } = await import("../db/scheduleStore.ts");
const { closeDb } = await import("../db/index.ts");
const { sessionRuntime } = await import("../session/runtimeInstance.ts");
const { findAdmittedUserEntry } =
  await import("../session/log/admittedUserEntry.ts");
const { canonicalSessionLogPath } = await import("../sessionStorage.ts");
const { deliverScheduledPrompts, scheduledPromptHeader } =
  await import("../schedules/scheduledPrompts.ts");
const { getSettings } = await import("../settings.ts");
const { saveSettings } = await import("../settingsService.ts");

/** The CLI's output stream, fed by the test. */
class OutputQueue implements AsyncIterable<ClaudeSdkMessage> {
  private readonly values: ClaudeSdkMessage[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<ClaudeSdkMessage>) => void
  > = [];
  private closed = false;

  emit(message: ClaudeSdkMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.values.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** A `query()` that records every user message the CLI would have read. */
class ControlledQuery implements ClaudeQuery {
  readonly output = new OutputQueue();
  readonly inputs: ClaudeSdkUserMessage[] = [];

  constructor(readonly params: ClaudeQueryParams) {
    params.options?.abortController?.signal.addEventListener("abort", () =>
      this.output.close(),
    );
    void this.consumeInput();
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
    return this.output[Symbol.asyncIterator]();
  }

  close(): void {
    this.output.close();
  }

  async interrupt(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setMaxThinkingTokens(): Promise<void> {}
  async applyFlagSettings(): Promise<void> {}

  private async consumeInput(): Promise<void> {
    if (typeof this.params.prompt === "string") return;
    for await (const message of this.params.prompt) this.inputs.push(message);
  }
}

/** A clean, successful end of the turn that consumed `consumed`. */
function result(consumed: string[]): ClaudeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "provider-scheduled",
    uuid: "result-1",
    is_error: false,
    result: "done",
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: {},
      service_tier: "standard",
    },
    modelUsage: {},
    permission_denials: [],
    stop_reason: null,
    user_message_uuids: consumed,
  } as unknown as ClaudeSdkMessage;
}

async function until(check: () => boolean): Promise<void> {
  // Generous: a loaded runner can take far longer to open the session.
  for (let i = 0; i < 5_000; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

/** The text a user message hands the model, whatever its content shape. */
function inputText(message: ClaudeSdkUserMessage): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
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
const SESSION_ID = "claude-scheduled-prompt";
// Wednesday 24 November 2027, 15:45 in Berlin (CET, UTC+1): far from the
// real clock, so nothing else settles it.
const DUE_AT_MS = Date.parse("2027-11-24T14:45:00Z");
const NAME = "  PR \t CI\n check  ";
const PROMPT = "Check the PR's CI.\n\n  Report  failures with their job names.";

let session: InstanceType<typeof ClaudeSdkSession> | undefined;
const queries: ControlledQuery[] = [];

beforeAll(async () => {
  // Synthetic accounts in the temp registry; the integration is off by default.
  await seedLegacyDefaultAccounts();
  await enableClaudeSdkForTests();
  // The visible prompt would otherwise name this unnamed session through a
  // detached helper model run, outside the controlled query and past this
  // file's cleanup. The deterministic fallback title needs no helper.
  await saveSettings({
    sessionNaming: { ...getSettings().sessionNaming, enabled: false },
  });
});

afterAll(async () => {
  sessionRuntime.closeForTeardown(SESSION_ID);
  session?.dispose();
  await sessionRuntime.disposeSession(SESSION_ID);
  for (const query of queries) query.close();
  closeDb();
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

test("the production lane delivers a claimed occurrence into a real Claude session", async () => {
  sessionStore.upsert({
    id: SESSION_ID,
    scope: "user",
    harness: "claude-sdk",
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
  assert.equal(occurrence.dueAtMs, DUE_AT_MS);
  const key = `schedule:${occurrence.id}`;
  const header = `⏰ Scheduled prompt "PR CI check" · schedule \`${scheduleId}\` · due Wed 24 Nov 15:45 Europe/Berlin`;
  assert.equal(scheduledPromptHeader(occurrence), header);
  // The session starts with no conversation at all.
  assert.deepEqual(canonicalRecords(SESSION_ID), []);
  assert.equal(getSettings().sessionNaming.enabled, false, "naming is off");

  const seam: ClaudeSdkSeam = {
    query(params) {
      const query = new ControlledQuery(params);
      queries.push(query);
      return query;
    },
  };
  session = new ClaudeSdkSession(SESSION_ID, {
    seam: async () => seam,
    agentType: "assistant",
  });

  const pass = deliverScheduledPrompts(session, () => true);
  await until(() => queries[0]?.inputs.length === 1);
  const first = queries[0]!.inputs[0]!;
  assert.ok(first.uuid, "the turn's prompt carries the uuid the CLI reports");
  queries[0]!.output.emit(result([first.uuid]));
  await pass;

  // 1. The model read the frozen header, a blank line, then the raw prompt.
  assert.equal(queries.length, 1, "one query opened");
  assert.equal(queries[0]!.inputs.length, 1, "one user message sent");
  assert.ok(
    inputText(first).startsWith(`${header}\n\n${PROMPT}`),
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
