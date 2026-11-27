/**
 * Module stand-ins for the scheduled prompts lane tests
 * (`src/schedules/scheduledPromptsLane*.test.ts`). Each test file registers
 * them with `vi.mock(path, async (load) => seams.xMock(await load()))`, so
 * this module stays a leaf: it imports no app module at load.
 *
 * Two of them are SEAMS, labelled where a test uses them, and never runtime
 * evidence:
 * - the RECEIPT seam scripts the facade's answer for one admission key: it
 *   runs the real `admit` (claim gate, attempt mark, strict restore) and then
 *   resolves or throws with no append, as a runtime duplicate or a typed
 *   refusal after admission would;
 * - the READER override answers `unknown` for one key, where the session must
 *   still take a real append (an unreadable file would refuse that too).
 */
import type * as Models from "../harnesses/models.ts";
import type { PromptQueueDriver } from "../promptQueue.ts";
import type * as Reader from "../session/log/admittedUserEntry.ts";
import type { PromptDeliveryReceipt } from "../session/runtime/promptDelivery.ts";
import type * as RuntimePrompt from "../session/runtimePrompt.ts";
import type * as StateTopics from "../stateTopics.ts";
import type * as WebPush from "../webPush.ts";
import type { FakeRuntimeDriver } from "./fakeRuntimeDriver.ts";

export type LaneDriver = FakeRuntimeDriver & PromptQueueDriver;

/** The sessions the fake hub serves, by id. */
export const drivers = new Map<string, LaneDriver>();
/** The model each test account offers, by credential profile id. */
export const offers = new Map<string, { provider: string; id: string }>();
/** RECEIPT seam scripts, by admission key. */
export const scripted = new Map<
  string,
  (receipt: PromptDeliveryReceipt) => Promise<void>
>();
/** READER override answers, by admission key. */
export const readerOverride = new Map<string, "unknown">();
/** How often the session rows were published after a restore. */
export const published = { count: 0 };

export const fakeHub = {
  getLiveById: (id: string) => drivers.get(id),
  acquireById: async (id: string) => drivers.get(id),
  broadcastPeerPromptCardUpdate: () => {},
  broadcastPeerPromptQueue: () => {},
};

export function hubMock() {
  return { hub: fakeHub };
}

export function modelsMock(real: typeof Models) {
  return {
    ...real,
    modelsForAccount: async ({ id }: { id: string }) =>
      offers.has(id)
        ? [{ ...offers.get(id), name: "Test model", reasoning: false }]
        : [],
  };
}

export function webPushMock(real: typeof WebPush) {
  return {
    ...real,
    notifySessionBlocked: async () => {},
    sendWebPushNotification: async () => {},
  };
}

export async function runtimePromptMock(real: typeof RuntimePrompt) {
  const { PromptDeliveryReceipt } =
    await import("../session/runtime/promptDelivery.ts");
  return {
    ...real,
    promptRuntimeSession: (
      ...args: Parameters<typeof real.promptRuntimeSession>
    ) => {
      const [, , options = {}] = args;
      const script = options.clientRequestId
        ? scripted.get(options.clientRequestId)
        : undefined;
      if (!script) return real.promptRuntimeSession(...args);
      return new PromptDeliveryReceipt(async (receipt) => {
        await Promise.resolve();
        options.admit?.();
        await script(receipt);
      });
    },
  };
}

export function readerMock(real: typeof Reader) {
  return {
    ...real,
    findAdmittedUserEntry: (
      sessionId: string,
      key: string,
      path?: string,
    ): Reader.AdmittedUserEntry =>
      readerOverride.get(key) ??
      (path === undefined
        ? real.findAdmittedUserEntry(sessionId, key)
        : real.findAdmittedUserEntry(sessionId, key, path)),
  };
}

export function stateTopicsMock(real: typeof StateTopics) {
  return {
    ...real,
    publishSessionRowsNow: () => {
      published.count += 1;
      real.publishSessionRowsNow();
    },
  };
}
