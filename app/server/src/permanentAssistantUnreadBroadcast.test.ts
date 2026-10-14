import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import type { Viewer } from "./harness.ts";

const tmp = mkdtempSync(join(tmpdir(), "pa-unread-broadcast-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
const { hub } = await import("./hub.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { permanentAssistantStore } =
  await import("./db/permanentAssistantStore.ts");
const unreadModule = await import("./permanentAssistantUnread.ts");
const cache = hub as unknown as {
  lastPermanentAssistantUnread: boolean | undefined;
};
let id: string;
let viewer: Viewer;
let count = 0;
function seed() {
  id = `pa-broadcast-${count++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "personal-assistant",
    updatedAt: 100,
    messageCount: 2,
  });
  permanentAssistantStore.setSessionId(id);
  cache.lastPermanentAssistantUnread = undefined;
  const sent: ServerMessage[] = [];
  viewer = { send: (message) => sent.push(message) } as Viewer;
  hub.register(viewer);
  return sent;
}
afterEach(() => {
  hub.unregister(viewer);
  sessionStore.remove(id);
  permanentAssistantStore.clearSessionId();
  cache.lastPermanentAssistantUnread = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("unchanged row updates and full flushes do not resend the singleton boolean", async () => {
  const sent = seed();
  await hub.sendPermanentAssistantUnreadTo(viewer);
  await hub.broadcastSessionUpdated(id);
  vi.useFakeTimers();
  const flush = hub.broadcastSessions();
  await vi.advanceTimersByTimeAsync(1_000);
  await flush;
  expect(
    sent.filter((message) => message.type === "permanentAssistantUnread"),
  ).toEqual([{ type: "permanentAssistantUnread", unread: true }]);
  sessionStore.markRead(id, 100);
  await hub.broadcastSessionUpdated(id);
  await hub.broadcastSessionUpdated(id);
  expect(
    sent.filter((message) => message.type === "permanentAssistantUnread"),
  ).toHaveLength(2);
});

test("a late connect read sends the cache after a newer live change, not its stale result", async () => {
  const sent = seed();
  let resolve!: (value: boolean) => void;
  vi.spyOn(unreadModule, "permanentAssistantUnread").mockReturnValue(
    new Promise<boolean>((done) => {
      resolve = done;
    }),
  );
  const initial = hub.sendPermanentAssistantUnreadTo(viewer);
  sessionStore.markRead(id, 100);
  await hub.broadcastSessionUpdated(id);
  resolve(true);
  await initial;
  expect(
    sent.filter((message) => message.type === "permanentAssistantUnread"),
  ).toEqual([
    { type: "permanentAssistantUnread", unread: false },
    { type: "permanentAssistantUnread", unread: false },
  ]);
});
