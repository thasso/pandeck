import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import type { DisplayMessage } from "@assistant/shared";
import type { PermanentAssistantDelivery } from "./permanentAssistant.ts";
import { PromptDeliveryReceipt } from "./session/runtime/promptDelivery.ts";

vi.mock("./session/runtimePrompt.ts", async (original) => ({
  ...(await original<typeof import("./session/runtimePrompt.ts")>()),
  promptRuntimeSession: vi.fn(),
}));
const tmp = mkdtempSync(join(tmpdir(), "pa-unread-drain-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
const assistant = await import("./permanentAssistant.ts");
const { promptRuntimeSession } = await import("./session/runtimePrompt.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { permanentAssistantStore } =
  await import("./db/permanentAssistantStore.ts");
const { getDb } = await import("./db/index.ts");
const { hub } = await import("./hub.ts");
const { harnessRegistry } = await import("./harnesses/registry.ts");
const { permanentAssistantUnread } =
  await import("./permanentAssistantUnread.ts");
let counter = 0;
let off: (() => void) | undefined;
let id: string;

function setup(extraPrompt = false) {
  // This stand-in PA has already started in the dedicated default directory.
  vi.spyOn(harnessRegistry, "cwdForSession").mockReturnValue(
    join(tmp, "data", "personal-assistant"),
  );
  id = `pa-drain-${counter++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "personal-assistant",
    updatedAt: 100,
    messageCount: 2,
  });
  sessionStore.markRead(id, 100);
  permanentAssistantStore.setSessionId(id);
  const messages: DisplayMessage[] = [];
  const driver = {
    id,
    agentType: "personal-assistant",
    createRuntimeAdapter: () => {},
    snapshot: () => messages,
  };
  vi.spyOn(hub, "acquireById").mockResolvedValue(driver as never);
  vi.spyOn(hub, "republishSessionRow").mockReturnValue(undefined);
  vi.mocked(promptRuntimeSession).mockClear();
  vi.mocked(promptRuntimeSession).mockImplementation(
    (_driver, text) =>
      new PromptDeliveryReceipt(async () => {
        messages.push({
          id: `user-${messages.length}`,
          role: "user",
          blocks: [{ kind: "text", text }],
        });
        if (extraPrompt)
          messages.push({
            id: `peer-${messages.length}`,
            role: "user",
            blocks: [{ kind: "text", text: "Another prompt arrived" }],
          });
        messages.push({
          id: `answer-${messages.length}`,
          role: "assistant",
          blocks: [{ kind: "text", text: "Answer" }],
        });
        sessionStore.upsert({
          id,
          harness: "pi",
          agentType: "personal-assistant",
          updatedAt: 100 + messages.length * 100,
          messageCount: 2 + messages.length,
        });
      }),
  );
}
function completion(
  count = 1,
  listener?: (delivery: PermanentAssistantDelivery) => void | Promise<void>,
) {
  const deliveries: PermanentAssistantDelivery[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((finish) => {
    resolve = finish;
  });
  off = assistant.subscribePermanentAssistant((delivery) => {
    if (delivery.state !== "completed") return;
    deliveries.push(delivery);
    if (deliveries.length === count) resolve();
    return listener?.(delivery);
  });
  return { done, deliveries };
}
function enqueue(source: "slack" | "web", key: string) {
  assistant.enqueuePermanentAssistant({ dedupeKey: key, source, text: key });
}
afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  off?.();
  off = undefined;
  getDb().prepare("DELETE FROM permanent_assistant_queue").run();
  permanentAssistantStore.clearSessionId();
  sessionStore.remove(id);
  vi.restoreAllMocks();
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("only Slack completion carries an acknowledgement and a hung delivery never blocks web intake", async () => {
  setup();
  let finishDelivery!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishDelivery = resolve;
  });
  const { done, deliveries } = completion(2, (delivery) =>
    delivery.item.source === "slack" ? pending : undefined,
  );
  enqueue("slack", "slack-first");
  enqueue("web", "web-next");
  await done;
  expect(promptRuntimeSession).toHaveBeenCalledTimes(2);
  expect(deliveries[0]?.acknowledgeSlackDelivery).toBeTypeOf("function");
  expect(deliveries[1]?.acknowledgeSlackDelivery).toBeUndefined();
  // Reading through the answered Slack turn cannot clear the later web turn.
  await deliveries[0]!.acknowledgeSlackDelivery!();
  expect(sessionStore.get(id)?.readAt).toBe(300);
  expect(await permanentAssistantUnread()).toBe(true);
  finishDelivery();
});

test("an additional prompt during a Slack turn prevents its acknowledgement", async () => {
  setup(true);
  const { done, deliveries } = completion();
  enqueue("slack", "extra-prompt");
  await done;
  expect(deliveries[0]?.acknowledgeSlackDelivery).toBeUndefined();
  expect(await permanentAssistantUnread()).toBe(true);
});

test("consecutive Slack answers can acknowledge their own boundaries after intake has finished", async () => {
  setup();
  const { done, deliveries } = completion(2);
  enqueue("slack", "slack-one");
  enqueue("slack", "slack-two");
  await done;
  expect(await permanentAssistantUnread()).toBe(true);
  await deliveries[0]!.acknowledgeSlackDelivery!();
  expect(await permanentAssistantUnread()).toBe(true);
  await deliveries[1]!.acknowledgeSlackDelivery!();
  expect(await permanentAssistantUnread()).toBe(false);
});

test("out-of-order Slack HTTP responses acknowledge in order without blocking intake", async () => {
  setup();
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  const firstHTTP = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const secondHTTP = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });
  let acknowledgedSecond!: () => void;
  const secondRead = new Promise<void>((resolve) => {
    acknowledgedSecond = resolve;
  });
  const { done } = completion(2, async (delivery) => {
    await (delivery.item.dedupeKey === "first-http" ? firstHTTP : secondHTTP);
    await delivery.acknowledgeSlackDelivery?.();
    if (delivery.item.dedupeKey === "second-http") acknowledgedSecond();
  });
  enqueue("slack", "first-http");
  enqueue("slack", "second-http");
  await done;
  expect(promptRuntimeSession).toHaveBeenCalledTimes(2);
  finishSecond();
  await new Promise((resolve) => setImmediate(resolve));
  expect(sessionStore.get(id)?.readAt).toBe(100);
  finishFirst();
  await secondRead;
  expect(await permanentAssistantUnread()).toBe(false);
});

test("a failed delivery leaves the completed Slack turn unread", async () => {
  setup();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { done } = completion(1, async () => {
    throw new Error("Slack delivery failed");
  });
  enqueue("slack", "delivery-failed");
  await done;
  await new Promise((resolve) => setImmediate(resolve));
  expect(warn).toHaveBeenCalledWith(
    "[permanent-assistant] delivery listener failed:",
    "Slack delivery failed",
  );
  expect(await permanentAssistantUnread()).toBe(true);
});
