/**
 * A user prompt whose turn a pending runtime selection holds at admission is
 * never appended and never lost: it waits in the user's queue, and the
 * session-targeted error says so (`docs/session-runtime-switching.md`). A
 * skill invocation, which cannot be queued, is kept as a HELD input of the
 * session instead: stored, shown to every viewer, never sent on its own.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type {
  ClientMessage,
  PromptQueueState,
  ServerMessage,
} from "@assistant/shared";

const held = vi.hoisted(() => ({ message: "" }));
vi.mock("./session/runtimePrompt.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./session/runtimePrompt.ts")>();
  const { PendingRuntimeHeldError } =
    await import("./sessionPendingRuntime.ts");
  return {
    ...original,
    promptRuntimeSession: async (driver: { sessionId: string }) => {
      throw new PendingRuntimeHeldError(driver.sessionId, held.message);
    },
  };
});

const { Connection } = await import("./connection.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { promptQueueStore } = await import("./db/promptQueueStore.ts");
const { FakeRuntimeDriver } = await import("./test/fakeRuntimeDriver.ts");
const { closeDb, getDb } = await import("./db/index.ts");
const queue = await import("./promptQueue.ts");

// One session per test: a removed session id is not opened again.
let run = 0;
let id = "";
beforeEach(() => {
  id = `pending-runtime-held-prompt-${++run}`;
});

afterEach(() => {
  queue.setPromptQueueHost(undefined);
  promptQueueStore.deleteSession(id);
  sessionStore.remove(id);
});

function connection(driver: InstanceType<typeof FakeRuntimeDriver>) {
  const sent: ServerMessage[] = [];
  const conn = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as never) as unknown as {
    handle(msg: ClientMessage): Promise<void>;
    ensureViewingDriver: () => Promise<unknown>;
    viewing: unknown;
    dispose(): void;
  };
  conn.viewing = {
    sessionId: id,
    live: true,
    broadcastState: () => {},
    removeViewer: () => {},
  };
  conn.ensureViewingDriver = async () => driver;
  return { conn, sent };
}

const errorsOf = (sent: ServerMessage[]) =>
  sent.filter((message) => message.type === "error") as Extract<
    ServerMessage,
    { type: "error" }
  >[];

/** Send `text` as a skill invocation the pending selection holds. */
async function sendHeldSkill(text: string, clientRequestId: string) {
  const driver = new FakeRuntimeDriver(id);
  const { conn, sent } = connection(driver);
  try {
    await conn.handle({
      type: "prompt",
      text,
      skill: text.slice(1).split(" ")[0],
      clientRequestId,
    } as ClientMessage);
    await vi.waitFor(() => assert.equal(errorsOf(sent).length, 1));
    return { error: errorsOf(sent)[0]!, driver };
  } finally {
    conn.dispose();
  }
}

test("a prompt held by a pending selection waits in the user's queue, with the reason", async () => {
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  held.message =
    "Couldn't switch to Big model · B: B needs login. The change is still pending; change or reset it to continue.";
  const sent: ServerMessage[] = [];
  const conn = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as never) as unknown as {
    handle(msg: ClientMessage): Promise<void>;
    ensureViewingDriver: () => Promise<unknown>;
    viewing: unknown;
    dispose(): void;
  };
  const driver = new FakeRuntimeDriver(id);
  conn.viewing = {
    sessionId: id,
    live: true,
    broadcastState: () => {},
    removeViewer: () => {},
  };
  conn.ensureViewingDriver = async () => driver;
  try {
    await conn.handle({
      type: "prompt",
      text: "keep these words",
      clientRequestId: "send-1",
    } as ClientMessage);
    await vi.waitFor(() =>
      assert.ok(sent.some((message) => message.type === "error")),
    );
    const [error] = sent.filter(
      (message) => message.type === "error",
    ) as Extract<ServerMessage, { type: "error" }>[];
    assert.equal(
      error?.message,
      `${held.message} Your message is waiting in your queue.`,
    );
    assert.deepEqual(error?.target, { type: "session", id });
    assert.equal(error?.failedPromptClientRequestId, "send-1");
    const queued = promptQueueStore.list(id);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.text, "keep these words");
    assert.equal(
      promptQueueStore.isPaused(id),
      false,
      "offered again without a click",
    );
    assert.deepEqual(driver.promptTexts, [], "nothing was appended");
  } finally {
    conn.dispose();
  }
});

test("a skill held by a pending selection is kept as a held input of the session, exactly as typed and never queued", async () => {
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  held.message =
    "Couldn't switch to Big model · B: B needs login. The change is still pending; change or reset it to continue.";
  // Every viewer of the session, on any device, is told through the queue's
  // publish (`hub.broadcastPromptQueue`).
  const published: PromptQueueState[] = [];
  queue.setPromptQueueHost({
    live: () => undefined,
    publish: (sessionId, state) => {
      if (sessionId === id) published.push(state);
    },
    reportError: () => {},
    yieldToOthers: () => {},
  });
  const typed = "/review-pr 412 --focus security, then summarize the risks";
  const { error, driver } = await sendHeldSkill(typed, "skill-1");
  assert.equal(
    error.message,
    `${held.message} /review-pr did not run; it is waiting above your message box to put back once the change applies or is reset.`,
  );
  assert.equal(error.failedPromptClientRequestId, "skill-1");
  assert.equal(
    "restoreDraft" in error,
    false,
    "no browser-only hand-back: the server keeps it",
  );
  assert.equal(promptQueueStore.list(id).length, 0, "skills never queue");
  assert.deepEqual(driver.promptTexts, [], "nothing was appended");
  const stored = promptQueueStore.listHeld(id);
  assert.deepEqual(
    stored.map((input) => input.text),
    [typed],
  );
  assert.deepEqual(published.at(-1)?.held, stored);
  // The session state's field (`sessionState.ts`): what a reload, or a second
  // client subscribing, is answered with.
  assert.deepEqual(queue.promptQueueField(id).promptQueue?.held, stored);
});

test("several held skills keep their order; a Resend of the same command is kept as another", async () => {
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  held.message = "Couldn't switch: B needs login.";
  await sendHeldSkill("/review-pr 1", "a");
  await sendHeldSkill("/summarize the thread", "b");
  await sendHeldSkill("/review-pr 1", "c");
  assert.deepEqual(
    promptQueueStore.listHeld(id).map((input) => input.text),
    ["/review-pr 1", "/summarize the thread", "/review-pr 1"],
  );
});

test("only Put back or Discard removes a held input; queue commands never touch it; deleting the session does", async () => {
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  queue.holdInput(id, "/first");
  queue.holdInput(id, "/second");
  queue.queuePrompt(id, { text: "an ordinary queued message" });
  const [first, second] = promptQueueStore.listHeld(id);
  queue.removeQueuedPrompt(id, first!.id);
  queue.clearPromptQueue(id);
  assert.deepEqual(
    promptQueueStore.listHeld(id).map((input) => input.text),
    ["/first", "/second"],
    "Remove and Clear act on queued rows only",
  );
  assert.equal(promptQueueStore.list(id).length, 0);
  const { conn, sent } = connection(new FakeRuntimeDriver(id));
  try {
    await conn.handle({
      type: "removeHeldInput",
      sessionId: id,
      id: first!.id,
    });
    assert.deepEqual(errorsOf(sent), []);
  } finally {
    conn.dispose();
  }
  assert.deepEqual(
    promptQueueStore.listHeld(id).map((input) => input.id),
    [second!.id],
  );
  queue.deleteSessionPromptQueue(id);
  assert.deepEqual(promptQueueStore.listHeld(id), []);
  assert.deepEqual(queue.promptQueueField(id), {});
});

// Last: reopening the database leaves later tests a fresh handle.
test("held inputs survive a server restart and are never sent: not by the boot drain, not by a drain of the session", async () => {
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  held.message = "Couldn't switch: B needs login.";
  await sendHeldSkill("/review-pr 9", "r");
  closeDb();
  getDb();
  assert.deepEqual(
    promptQueueStore.listHeld(id).map((input) => input.text),
    ["/review-pr 9"],
  );
  const offered: string[] = [];
  queue.drainPromptQueuesOnBoot((sessionId) => offered.push(sessionId));
  assert.equal(offered.includes(id), false, "nothing of this session to send");
  assert.equal(queue.promptQueueHasPriority(id), false);
  // The selection applied (or was reset): the scheduler drains the session.
  const driver = new FakeRuntimeDriver(id);
  await queue.drainPromptQueue(id, () => true, driver as never);
  assert.deepEqual(driver.promptTexts, []);
  assert.equal(promptQueueStore.listHeld(id).length, 1, "still held");
});
