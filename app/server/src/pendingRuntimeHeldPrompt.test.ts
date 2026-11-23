/**
 * A user prompt whose turn a pending runtime selection holds at admission is
 * never appended and never lost: it waits in the user's queue, and the
 * session-targeted error says so (`docs/session-runtime-switching.md`).
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";

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

const id = "pending-runtime-held-prompt";

afterEach(() => {
  for (const row of promptQueueStore.list(id))
    promptQueueStore.remove(id, row.id);
  sessionStore.remove(id);
});

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
