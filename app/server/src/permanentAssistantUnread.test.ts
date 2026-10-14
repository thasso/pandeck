import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { SESSION_READ_DWELL_MS, type ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "pa-unread-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
const { sessionStore } = await import("./db/sessionStore.ts");
const { permanentAssistantStore } =
  await import("./db/permanentAssistantStore.ts");
const {
  permanentAssistantUnread,
  permanentAssistantReadBoundary,
  acknowledgeSlackAssistantTurn,
} = await import("./permanentAssistantUnread.ts");
const { mergedSessionList } = await import("./harnesses/sessionList.ts");
const { hub } = await import("./hub.ts");
const { Connection } = await import("./connection.ts");
let counter = 0;
const ids: string[] = [];
function seed(updatedAt = 100) {
  const id = `pa-unread-${counter++}`;
  ids.push(id);
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "personal-assistant",
    messageCount: 2,
    updatedAt,
  });
  permanentAssistantStore.setSessionId(id);
  return id;
}
function update(id: string, updatedAt: number) {
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "personal-assistant",
    updatedAt,
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  permanentAssistantStore.clearSessionId();
  for (const id of ids.splice(0)) sessionStore.remove(id);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("the singleton uses the ordinary session unread projection", async () => {
  expect(await permanentAssistantUnread()).toBe(false);
  const id = seed();
  expect(await permanentAssistantUnread()).toBe(
    (await mergedSessionList()).find((row) => row.id === id)?.unread,
  );
  expect(await permanentAssistantUnread()).toBe(true);
  sessionStore.markRead(id, 100);
  expect(await permanentAssistantUnread()).toBe(false);
  update(id, 200);
  expect(await permanentAssistantUnread()).toBe(true);
  sessionStore.setSettled(id, true);
  expect(await permanentAssistantUnread()).toBe(false);
});

test("Slack delivery acknowledges its boundary but preserves older and newer unseen content", async () => {
  const id = seed();
  sessionStore.markRead(id, 100);
  const baseline = await permanentAssistantReadBoundary();
  update(id, 200);
  expect(acknowledgeSlackAssistantTurn(id, baseline, 200)).toBe(true);
  expect(await permanentAssistantUnread()).toBe(false);
  // A later web or background message is not part of the delivered response.
  update(id, 300);
  expect(acknowledgeSlackAssistantTurn(id, baseline, 200)).toBe(false);
  expect(await permanentAssistantUnread()).toBe(true);
  const unreadBaseline = await permanentAssistantReadBoundary();
  update(id, 400);
  expect(acknowledgeSlackAssistantTurn(id, unreadBaseline, 400)).toBe(false);
  expect(await permanentAssistantUnread()).toBe(true);
  // Rotation invalidates a delivery from the abandoned singleton.
  seed();
  expect(acknowledgeSlackAssistantTurn(id, baseline, 400)).toBe(false);
});

test("a first Slack turn does not inherit unread from metadata-only creation", async () => {
  const id = seed();
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "personal-assistant",
    messageCount: 0,
  });
  const baseline = await permanentAssistantReadBoundary();
  expect(baseline.unread).toBe(false);
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "personal-assistant",
    messageCount: 2,
    updatedAt: 200,
  });
  expect(acknowledgeSlackAssistantTurn(id, baseline, 200)).toBe(true);
  expect(await permanentAssistantUnread()).toBe(false);
});

test("release cancels a retained panel's pending reopen even before it attaches", async () => {
  const id = seed();
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: () => {},
  } as unknown as ConstructorParameters<typeof Connection>[0]);
  let resolve!: (rows: []) => void;
  vi.spyOn(hub, "listSessions").mockReturnValue(
    new Promise<[]>((done) => {
      resolve = done;
    }),
  );
  try {
    const reopening = connection.handle({ type: "openPermanentAssistant" });
    await connection.handle({
      type: "releasePermanentAssistant",
      sessionId: id,
    });
    resolve([]);
    await reopening;
    expect(connection.viewingSessionId()).toBeUndefined();
  } finally {
    connection.dispose();
  }
});

test("opening PA uses read dwell and publishes only its scalar unread state", async () => {
  const id = seed(Date.now() - 100);
  const sent: ServerMessage[] = [];
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  } as unknown as ConstructorParameters<typeof Connection>[0]);
  vi.useFakeTimers();
  try {
    await connection.handle({ type: "openPermanentAssistant" });
    expect(await permanentAssistantUnread()).toBe(true);
    await vi.advanceTimersByTimeAsync(SESSION_READ_DWELL_MS);
    expect(await permanentAssistantUnread()).toBe(false);
    const sink = { send: (message: ServerMessage) => sent.push(message) };
    hub.register(sink as unknown as InstanceType<typeof Connection>);
    try {
      await hub.sendPermanentAssistantUnreadTo(
        sink as unknown as InstanceType<typeof Connection>,
      );
      await hub.broadcastSessionUpdated(id);
      expect(sent.at(-1)).toEqual({
        type: "permanentAssistantUnread",
        unread: false,
      });
      const sentCount = sent.length;
      await hub.broadcastSessionUpdated(id);
      expect(sent.length).toBe(sentCount);
      update(id, Date.now() + 100);
      await hub.broadcastSessionUpdated(id);
      expect(sent.at(-1)).toEqual({
        type: "permanentAssistantUnread",
        unread: true,
      });
    } finally {
      hub.unregister(sink as unknown as InstanceType<typeof Connection>);
    }
    expect(
      sent
        .filter((message) => "sessions" in message)
        .every(
          (message) =>
            !(message as { sessions: { id: string }[] }).sessions.some(
              (row) => row.id === id,
            ),
        ),
    ).toBe(true);
    const held = (connection as unknown as { heldSubagentThreads: Set<string> })
      .heldSubagentThreads;
    held.add("pa-child-thread");
    const release = vi
      .spyOn(hub, "releaseSubagentRunTopic")
      .mockImplementation(() => {});
    await connection.handle({
      type: "releasePermanentAssistant",
      sessionId: id,
    });
    expect(connection.viewingSessionId()).toBeUndefined();
    expect(held.size).toBe(0);
    expect(release).toHaveBeenCalledWith("pa-child-thread");
  } finally {
    connection.dispose();
  }
});
