/**
 * A Stop holds the permanent Assistant's intake: what the user queued before
 * it waits, in order and across a restart, until they write again or resume.
 *   pnpm --filter @assistant/server test src/permanentAssistantStopHold.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import type {
  AgentRunResult,
  PromptableAdapter,
} from "./session/adapters/contract.ts";

// The Slack DM handler runs for real; only its account settings and transport
// are stood in for.
vi.mock("./slackSettings.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./slackSettings.ts")>()),
  getSlackRuntimeSettings: () => ({
    enabled: true,
    accountUserId: "U-OWNER",
    botUserId: "U-BOT",
  }),
  getSlackToolConfig: () => ({ enabled: true, token: "xoxb-test" }),
}));
vi.mock("./slackSocketMode.ts", () => ({
  slackSocketMode: { subscribe: () => () => undefined },
}));

const tmp = mkdtempSync(join(tmpdir(), "permanent-assistant-stop-hold-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const assistant = await import("./permanentAssistant.ts");
const { permanentAssistantStore } =
  await import("./db/permanentAssistantStore.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { getDb } = await import("./db/index.ts");
const { hub } = await import("./hub.ts");
const { harnessRegistry } = await import("./harnesses/registry.ts");
const hold = await import("./automaticTurnHold.ts");
const { updateSettings, getSettings } = await import("./settings.ts");
const { handleSlackAssistantEnvelope } =
  await import("./slackAssistantChat.ts");

updateSettings({ memory: { ...getSettings().memory, learningMode: "off" } });

/** The bound Assistant; its first turn stays open until `finishFirst`. */
function boundAssistant(id: string, options: { holdFirst?: boolean } = {}) {
  // This fake represents a PA already started in its dedicated directory.
  vi.spyOn(harnessRegistry, "cwdForSession").mockReturnValue(
    getSettings().permanentAssistant.defaultWorkingDirectory,
  );
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "pi",
    agentType: "personal-assistant",
  });
  const sent: string[] = [];
  let running = false;
  let finish: (() => void) | undefined;
  const adapter: PromptableAdapter = {
    provider: "fake",
    capabilities: { fork: "none", compact: false, attachments: false },
    subscribe: () => () => {},
    getBinding: () => ({ provider: "fake" }),
    prompt: (text) => {
      sent.push(text);
      if (options.holdFirst && sent.length === 1) {
        running = true;
        return new Promise<AgentRunResult>((resolve) => {
          finish = () => {
            running = false;
            resolve({ stopReason: "aborted" });
          };
        });
      }
      return Promise.resolve<AgentRunResult>({ stopReason: "end" });
    },
    abort: () => finish?.(),
    setModel: () => {},
    setReasoning: () => {},
    dispose: () => {},
  };
  const driver = {
    id,
    key: id,
    sessionId: id,
    harness: "pi" as const,
    agentType: "personal-assistant" as const,
    sessionFile: undefined,
    get isRunning() {
      return running;
    },
    canSteer: false,
    contextInfo: () => ({}) as never,
    broadcastState: () => {},
    createRuntimeAdapter: () => adapter,
    snapshot: () => [],
  };
  permanentAssistantStore.setSessionId(id);
  vi.spyOn(hub, "acquireById").mockImplementation(async (sessionId) =>
    sessionId === id ? (driver as never) : undefined,
  );
  return { id, sent, finishFirst: () => finish?.() };
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${label} was not reached`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const idle = () =>
  until(() => !assistant.permanentAssistantIsBusy(), "the intake to settle");
const web = (dedupeKey: string, text = dedupeKey) => ({
  dedupeKey,
  source: "web" as const,
  text,
});
const statusOf = (dedupeKey: string) =>
  permanentAssistantStore.find(dedupeKey)?.status;

const originalFetch = globalThis.fetch;
afterEach(async () => {
  await idle();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  getDb().prepare("DELETE FROM permanent_assistant_queue").run();
  permanentAssistantStore.clearSessionId();
  hold.setAutomaticTurnHoldHost(undefined);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("a Stop holds intake queued before it, across a restart, until the user writes again", async () => {
  const a = boundAssistant("assistant-held", { holdFirst: true });
  assistant.enqueuePermanentAssistant(web("first"));
  await until(() => a.sent.length === 1, "the first item's turn");
  assistant.enqueuePermanentAssistant(web("second", "queued before the Stop"));

  hold.holdAutomaticTurns(a.id);
  a.finishFirst();
  await idle();
  assert.deepEqual(a.sent, ["first"], "nothing after the stopped turn");
  assert.equal(hold.automaticTurnsHeld(a.id), true);
  assert.equal(statusOf("second"), "queued");

  // A restart recovers the intake and offers it again: still held.
  assistant.stopPermanentAssistant();
  assistant.startPermanentAssistant();
  await idle();
  assert.deepEqual(a.sent, ["first"]);
  assert.equal(statusOf("second"), "queued");

  // A resend of a row already stored (a reconnect) resumes nothing.
  assistant.enqueuePermanentAssistant(web("second", "queued before the Stop"), {
    resumeHold: hold.captureHumanResume(a.id),
  });
  await idle();
  assert.equal(hold.automaticTurnsHeld(a.id), true);
  assert.deepEqual(a.sent, ["first"]);

  // A new message does, and the intake goes on in its order.
  assistant.enqueuePermanentAssistant(web("third", "a new message"), {
    resumeHold: hold.captureHumanResume(a.id),
  });
  await until(() => a.sent.length === 3, "the intake to resume");
  await idle();
  assert.deepEqual(a.sent, [
    "first",
    "queued before the Stop",
    "a new message",
  ]);
  assert.equal(hold.automaticTurnsHeld(a.id), false);
  assert.equal(statusOf("second"), "completed");
  assert.equal(statusOf("third"), "completed");
});

test("a new message authorized before a newer Stop is stored but resumes nothing", async () => {
  const a = boundAssistant("assistant-stale");
  hold.holdAutomaticTurns(a.id);
  const stale = hold.captureHumanResume(a.id);
  hold.holdAutomaticTurns(a.id);
  assistant.enqueuePermanentAssistant(web("stale", "typed before"), {
    resumeHold: stale,
  });
  await idle();
  assert.equal(hold.automaticTurnsHeld(a.id), true);
  assert.equal(statusOf("stale"), "queued");
  assert.deepEqual(a.sent, []);
});

test("Resume goes on with the Assistant's intake from where the Stop held it", async () => {
  const a = boundAssistant("assistant-resume");
  hold.holdAutomaticTurns(a.id);
  assistant.enqueuePermanentAssistant(web("waiting"));
  await idle();
  assert.deepEqual(a.sent, []);
  hold.setAutomaticTurnHoldHost({
    changed: () => {},
    resumed: (id) => assistant.resumePermanentAssistantIntake(id),
  });
  hold.resumeAutomaticTurns(a.id);
  await until(() => a.sent.length === 1, "the intake after Resume");
  await idle();
  assert.equal(statusOf("waiting"), "completed");
});

test("a Stop landing while an intake item is on its way puts it back, unspent", async () => {
  const a = boundAssistant("assistant-race");
  // The Stop lands once the item is marked working, before the run door.
  const unsubscribe = assistant.subscribePermanentAssistant((delivery) => {
    if (delivery.state === "working")
      queueMicrotask(() => hold.holdAutomaticTurns(a.id));
  });
  try {
    assistant.enqueuePermanentAssistant(web("racing"));
    await idle();
  } finally {
    unsubscribe();
  }
  assert.deepEqual(a.sent, []);
  assert.equal(hold.automaticTurnsHeld(a.id), true);
  const item = permanentAssistantStore.find("racing");
  assert.equal(item?.status, "queued");
  assert.equal(item?.attempts, 0, "a held refusal is not a failed attempt");
  assert.equal(item?.error, undefined);
});

/** A Slack DM event; the account owner's unless overridden. */
function dm(ts: string, text: string, over: Record<string, unknown> = {}) {
  return {
    type: "events_api",
    payload: {
      team_id: "T1",
      event: {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U-OWNER",
        ts,
        text,
        ...over,
      },
    },
  };
}

/** Answer every Slack Web API call; the placeholder can be held back. */
function slackApi(placeholder?: Promise<void>) {
  globalThis.fetch = vi.fn(async () => {
    await placeholder;
    return new Response(JSON.stringify({ ok: true, ts: "900.1" }));
  }) as typeof fetch;
}

test("a new Slack DM from the account owner resumes a stopped Assistant, after its backlog", async () => {
  const a = boundAssistant("assistant-slack");
  slackApi();
  hold.holdAutomaticTurns(a.id);
  assistant.enqueuePermanentAssistant(web("before", "queued before the Stop"));
  await idle();
  assert.deepEqual(a.sent, []);

  // Not the owner's words: a bot, an edit, someone else. None resumes.
  await handleSlackAssistantEnvelope(dm("1.1", "bot", { bot_id: "B1" }));
  await handleSlackAssistantEnvelope(
    dm("1.2", "edited", { subtype: "message_changed" }),
  );
  await handleSlackAssistantEnvelope(dm("1.3", "other", { user: "U-OTHER" }));
  await idle();
  assert.equal(hold.automaticTurnsHeld(a.id), true);
  assert.deepEqual(a.sent, []);

  await handleSlackAssistantEnvelope(dm("2.1", "a new DM"));
  await until(() => a.sent.length === 2, "the intake to resume");
  await idle();
  assert.deepEqual(a.sent, ["queued before the Stop", "a new DM"], "FIFO");
  assert.equal(hold.automaticTurnsHeld(a.id), false);

  // Stopped again: Slack redelivering that same event resumes nothing.
  hold.holdAutomaticTurns(a.id);
  await handleSlackAssistantEnvelope(dm("2.1", "a new DM"));
  await idle();
  assert.equal(hold.automaticTurnsHeld(a.id), true);
  assert.equal(a.sent.length, 2);
});

test("a Stop that lands while the Slack placeholder is posted wins over the DM", async () => {
  const a = boundAssistant("assistant-slack-race");
  let postPlaceholder!: () => void;
  slackApi(new Promise<void>((resolve) => (postPlaceholder = resolve)));
  hold.holdAutomaticTurns(a.id);
  const handled = handleSlackAssistantEnvelope(dm("3.1", "sent before"));
  // The DM's authority is already captured; the user stops again meanwhile.
  hold.holdAutomaticTurns(a.id);
  postPlaceholder();
  await handled;
  await idle();
  assert.equal(hold.automaticTurnsHeld(a.id), true);
  assert.deepEqual(a.sent, []);
  assert.equal(
    permanentAssistantStore.find("slack:T1:D1:3.1")?.status,
    "queued",
    "stored, in its place, for Resume",
  );
});
