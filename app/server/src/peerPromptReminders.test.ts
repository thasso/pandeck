/**
 * Reply reminders (Task-943): an idle session is reminded, in one turn, of
 * every peer request it has neither answered nor settled — derived from the
 * store at admission, bounded per request, and always behind other owed work.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, it, vi } from "vitest";
import { sessionStore } from "./db/sessionStore.ts";
import { promptQueueStore } from "./db/promptQueueStore.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { agentHandoffStore } from "./db/agentHandoffStore.ts";
import { canonicalSessionLogPath } from "./sessionStorage.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { FakeRuntimeDriver } from "./test/fakeRuntimeDriver.ts";

const { fakeDrivers, coldIds, acquired, listBroadcasts, preparation } =
  vi.hoisted(() => ({
    fakeDrivers: new Map<string, unknown>(),
    /** Sessions with no live harness: only `acquireById` could open one. */
    coldIds: new Set<string>(),
    acquired: [] as string[],
    listBroadcasts: { count: 0 },
    /** Holds every prompt at its last await before admission while set. */
    preparation: { gate: undefined as undefined | (() => Promise<void>) },
  }));

vi.mock("./sessionSkills.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sessionSkills.ts")>();
  return {
    ...real,
    sessionSkills: async (...args: Parameters<typeof real.sessionSkills>) => {
      await preparation.gate?.();
      return real.sessionSkills(...args);
    },
  };
});
vi.mock("./webPush.ts", () => ({
  notifySessionBlocked: vi.fn(async () => {}),
}));

const fakeHub = {
  getLiveById: (id: string) => (coldIds.has(id) ? undefined : driverFor(id)),
  acquireById: async (id: string) => {
    acquired.push(id);
    return driverFor(id);
  },
  broadcastSessions: () => {
    listBroadcasts.count += 1;
  },
  broadcastPeerPromptCardUpdate: () => {},
  broadcastPeerPromptQueue: () => {},
};
vi.mock("./hub.ts", () => ({ hub: fakeHub }));

const peer = await import("./peerPrompt.ts");
const {
  drainRecipient,
  installReplyReminders,
  offerReplyReminders,
  peerRequestKey,
  setHubForTests,
  setPeerPromptAutoDeliverForTests,
  setReplyReminderHost,
  settlePeerRequests,
  sendPeerPrompt,
  drainAllQueuedOnBoot,
} = peer;
const { promptRuntimeSession } = await import("./session/runtimePrompt.ts");
const hold = await import("./automaticTurnHold.ts");
const handoffs = await import("./agentHandoffs.ts");
const { BackgroundCompletionDelivery } =
  await import("./backgroundWork/completionDelivery.ts");
const { createIdleEdge } = await import("./idleEdge.ts");
const { setSessionIdleHook } = await import("./session/runtime/liveSession.ts");

setHubForTests(fakeHub as never);

let n = 0;
const created: string[] = [];
let uninstall: () => void = () => {};
/** Every re-offer of the idle edge the engine asked for. */
const reoffers: string[] = [];
let handoffOwed = (_id: string) => false;
let wakeOwed = (_id: string) => false;

function driverFor(id: string): FakeRuntimeDriver {
  const existing = fakeDrivers.get(id);
  if (existing instanceof FakeRuntimeDriver) return existing;
  const driver = new FakeRuntimeDriver(id);
  fakeDrivers.set(id, driver);
  return driver;
}

function seed(title: string, opts: { archived?: boolean } = {}): string {
  const id = `rem-sess-${n++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title,
    scope: "user",
  });
  if (opts.archived) sessionStore.setArchived(id, true);
  created.push(id);
  return id;
}

/** A request whose turn ended without the answer: `awaiting_response`. */
function openRequest(
  from: string,
  to: string,
  prompt: string,
  opts: { stopped?: boolean; chainId?: string; expiresAt?: number } = {},
) {
  const chainId = opts.chainId ?? peerPromptStore.createChain();
  const m = peerPromptStore.enqueue({
    conversationId: `rem-conv-${n++}`,
    chainId,
    hop: peerPromptStore.reserveHop(chainId),
    senderSessionId: from,
    recipientSessionId: to,
    prompt,
    responseRequested: true,
    senderLabel: sessionStore.get(from)?.title ?? "",
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  });
  peerPromptStore.claimNext(to, "test", 60_000);
  peerPromptStore.markAdmitted(m.id);
  if (opts.stopped) peerPromptStore.markStopped(m.id);
  else peerPromptStore.markCompleted(m.id);
  const row = peerPromptStore.getById(m.id)!;
  assert.equal(row.status, "awaiting_response");
  return row;
}

/** The user entries in a session's log, oldest first, as text. */
function userTexts(sessionId: string): string[] {
  const path = canonicalSessionLogPath(sessionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => e.type === "message" && e.role === "user")
    .map((e) =>
      (e.content as Array<{ type: string; text?: string }>)
        .map((block) => block.text ?? "")
        .join(""),
    );
}
const reminders = (sessionId: string) =>
  userTexts(sessionId).filter((t) => t.startsWith("Peer reminder"));
const count = (id: string) => peerPromptStore.getById(id)!.reminderCount;

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${label} was not reached`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** A gate the next prompt's admission waits at; `open` lets it through. */
function gatePreparation() {
  let open!: () => void;
  let reached!: () => void;
  const atGate = new Promise<void>((resolve) => (reached = resolve));
  const gate = new Promise<void>((resolve) => (open = resolve));
  preparation.gate = () => {
    preparation.gate = undefined;
    reached();
    return gate;
  };
  return { atGate, open };
}

beforeAll(() => setPeerPromptAutoDeliverForTests(false));

beforeEach(() => {
  uninstall = installReplyReminders();
  handoffOwed = () => false;
  wakeOwed = () => false;
  setReplyReminderHost({
    handoffOwed: (id) => handoffOwed(id),
    wakeOwed: (id) => wakeOwed(id),
    requestIdleEdge: (id) => {
      reoffers.push(id);
    },
  });
});

afterEach(() => {
  uninstall();
  setReplyReminderHost(undefined);
  setSessionIdleHook(undefined);
  preparation.gate = undefined;
  reoffers.length = 0;
  acquired.length = 0;
  for (const id of created.splice(0)) {
    hold.deleteAutomaticTurnHold(id);
    for (const item of promptQueueStore.list(id))
      promptQueueStore.remove(id, item.id);
    for (const row of agentHandoffStore.listForSession(id))
      agentHandoffStore.remove(row.id);
    sessionStore.remove(id);
    fakeDrivers.delete(id);
    coldIds.delete(id);
    rmSync(dirname(canonicalSessionLogPath(id)), {
      recursive: true,
      force: true,
    });
  }
});

describe("reply reminders", () => {
  it("reminds an idle session of every open request in one turn, beyond one call's rows", async () => {
    const me = seed("Driver");
    const requesters = Array.from({ length: 12 }, (_, i) =>
      seed(`Requester ${i}`),
    );
    const rows = Array.from({ length: 23 }, (_, i) =>
      openRequest(requesters[i % 12]!, me, `question ${i}`),
    );

    await offerReplyReminders(me);

    const sent = reminders(me);
    assert.equal(sent.length, 1, "one turn covers all of them");
    for (const r of rows) {
      assert.ok(sent[0]!.includes(peerRequestKey(r)), `lists ${r.prompt}`);
      assert.ok(sent[0]!.includes(r.senderSessionId));
      assert.equal(count(r.id), 1);
    }
    assert.ok(sent[0]!.includes("23 requests sent to you"));
    assert.ok(sent[0]!.includes("One call holds at most 10 rows"));
    assert.ok(sent[0]!.includes("use several calls"));
    assert.ok(sent[0]!.includes("inReplyTo"));
    assert.ok(sent[0]!.includes("settle"));
    assert.ok(sent[0]!.includes("holding reply"));
    assert.ok(sent[0]!.includes("reminder 1 of 3"));
  });

  it("lists nothing answered, settled, expired, unrequested or from a put-down session", async () => {
    const me = seed("Driver");
    const asker = seed("Asker");
    const gone = seed("Archived asker", { archived: true });
    const due = openRequest(asker, me, "still open");
    const settled = openRequest(asker, me, "settled one");
    settlePeerRequests({
      settlerSessionId: me,
      keys: [peerRequestKey(settled)],
      reason: "done",
    });
    const expired = openRequest(asker, me, "expired one", {
      expiresAt: Date.now() - 1,
    });
    const fromArchived = openRequest(gone, me, "from an archived session");

    await offerReplyReminders(me);

    const [text] = reminders(me);
    assert.ok(text?.includes(peerRequestKey(due)));
    for (const r of [settled, expired, fromArchived])
      assert.ok(!text!.includes(peerRequestKey(r)), r.prompt);
    assert.equal(count(settled.id), 0);
  });

  it("never opens a cold session, and boot reminds nobody", async () => {
    const me = seed("Cold");
    const r = openRequest(seed("Asker"), me, "question");
    coldIds.add(me);

    await offerReplyReminders(me);
    await drainRecipient(me);
    drainAllQueuedOnBoot();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(acquired, []);
    assert.equal(count(r.id), 0);
  });

  it("boot queue recovery that yields without a turn reminds nobody", async () => {
    const me = seed("Rebooted");
    const r = openRequest(seed("Asker"), me, "question");
    // A queued message whose attachment is gone fails before its append,
    // pauses the queue and hands the edge on — at boot, with no idle edge.
    promptQueueStore.append({
      id: `q-${n++}`,
      sessionId: me,
      text: "with a file",
      attachments: [
        {
          id: "missing-attachment",
          name: "gone.png",
          mimeType: "image/png",
          size: 1,
        },
      ] as never,
    });
    const promptQueue = await import("./promptQueue.ts");
    const background = new BackgroundCompletionDelivery({
      drainPeers: drainRecipient,
      offer: async () => "delivered",
    });
    const edge = createIdleEdge({
      runAutoApprovals: async () => {},
      drainAgentHandoffs: async () => {},
      drainPromptQueue: (id) => promptQueue.drainPromptQueue(id),
      drainBackground: (id, rerun) =>
        rerun ? background.requestDrain(id) : background.drain(id),
      offerReplyReminders,
    });
    let yielded = 0;
    promptQueue.setPromptQueueHost({
      resolve: async (id) => driverFor(id) as never,
      live: (id) => driverFor(id) as never,
      publish: () => {},
      reportError: () => {},
      yieldToOthers: (id) => {
        yielded += 1;
        edge.offerAfterQueue(id);
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      promptQueue.drainPromptQueuesOnBoot();
      await until(() => yielded > 0, "the queue's yield");
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      vi.restoreAllMocks();
      promptQueue.setPromptQueueHost(undefined);
    }
    assert.equal(promptQueueStore.isPaused(me), true);
    assert.equal(reminders(me).length, 0);
    assert.equal(count(r.id), 0);
  });

  it("waits out a Stop, and reminds of a stopped request once resumed", async () => {
    const me = seed("Held");
    const r = openRequest(seed("Asker"), me, "question", { stopped: true });
    hold.holdAutomaticTurns(me);

    await offerReplyReminders(me);
    assert.equal(reminders(me).length, 0);
    assert.deepEqual(reoffers, [], "a hold is not work to yield to");

    hold.resumeAutomaticTurns(me);
    await offerReplyReminders(me);
    assert.equal(reminders(me).length, 1);
    assert.equal(count(r.id), 1);
  });

  it("counts a reminder once its turn is appended, even when that turn fails", async () => {
    const me = seed("Failing");
    const r = openRequest(seed("Asker"), me, "question");
    driverFor(me).behavior = { mode: "error", message: "usage limit" };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await offerReplyReminders(me);
    } finally {
      vi.restoreAllMocks();
    }
    assert.equal(reminders(me).length, 1);
    assert.equal(count(r.id), 1);
    assert.equal(
      peerPromptStore.getById(r.id)!.status,
      "awaiting_response",
      "a failed reminder closes nothing",
    );
  });

  it("stops at the limit, and the request shows as still owed", async () => {
    const me = seed("Ignoring");
    const asker = seed("Asker");
    const r = openRequest(asker, me, "question");
    const original = getSettings().sessionPeerPromptReminderLimit;
    updateSettings({ sessionPeerPromptReminderLimit: 2 });
    try {
      for (let i = 0; i < 2; i += 1) {
        await offerReplyReminders(me);
        // Something else happened in the session since.
        await promptRuntimeSession(driverFor(me), "unrelated", {
          origin: { kind: "system", source: "test" },
        });
      }
      const before = listBroadcasts.count;
      await offerReplyReminders(me);
      assert.equal(reminders(me).length, 2);
      assert.ok(reminders(me)[1]!.includes("reminder 2 of 2"));
      assert.equal(count(r.id), 2);
      assert.equal(listBroadcasts.count, before, "nothing new to show");
      assert.deepEqual(
        peerPromptStore.remindersExhaustedByRecipient(2).get(me),
        [asker],
      );
      assert.equal(
        peerPromptStore.remindersExhaustedByRecipient(3).get(me),
        undefined,
        "a higher limit makes it due again instead",
      );
      settlePeerRequests({
        settlerSessionId: me,
        keys: [peerRequestKey(r)],
        reason: "handled",
      });
      assert.equal(
        peerPromptStore.remindersExhaustedByRecipient(2).get(me),
        undefined,
      );
    } finally {
      updateSettings({ sessionPeerPromptReminderLimit: original });
    }
  });

  it("asks for a session-list rebuild when a request reaches its last reminder", async () => {
    const me = seed("Last one");
    openRequest(seed("Asker"), me, "question");
    const original = getSettings().sessionPeerPromptReminderLimit;
    updateSettings({ sessionPeerPromptReminderLimit: 1 });
    try {
      const before = listBroadcasts.count;
      await offerReplyReminders(me);
      await until(() => listBroadcasts.count > before, "the rebuild");
    } finally {
      updateSettings({ sessionPeerPromptReminderLimit: original });
    }
  });

  describe("no reminder right after a reminder", () => {
    it("not on the edge the reminder turn itself ends", async () => {
      const me = seed("Quiet");
      const r = openRequest(seed("Asker"), me, "question");
      await offerReplyReminders(me);
      await offerReplyReminders(me);
      assert.equal(reminders(me).length, 1);
      assert.equal(count(r.id), 1);
    });

    it("again after a notice-origin turn of another kind", async () => {
      const me = seed("Coordinator");
      const r = openRequest(seed("Asker"), me, "question");
      await offerReplyReminders(me);
      await promptRuntimeSession(driverFor(me), "a delegation notice", {
        origin: { kind: "agent", agentId: "peer-notice" },
      });
      await offerReplyReminders(me);
      assert.equal(reminders(me).length, 2);
      assert.equal(count(r.id), 2);
    });

    it("again after an unrelated peer prompt was delivered", async () => {
      const me = seed("Worker");
      const asker = seed("Asker");
      const r = openRequest(asker, me, "question");
      await offerReplyReminders(me);
      await sendPeerPrompt({
        senderSessionId: seed("Other"),
        targetSessionId: me,
        prompt: "fyi",
        responseRequested: false,
      });
      await drainRecipient(me);
      await offerReplyReminders(me);
      assert.equal(reminders(me).length, 2);
      assert.equal(count(r.id), 2);
    });

    it("not after a continuation, which appends no user entry", async () => {
      const me = seed("Recovered");
      openRequest(seed("Asker"), me, "question");
      await offerReplyReminders(me);
      await promptRuntimeSession(driverFor(me), "", {
        origin: { kind: "system", source: "test" },
        continuation: true,
      }).catch(() => {});
      await offerReplyReminders(me);
      assert.equal(reminders(me).length, 1);
    });
  });

  describe("admission re-reads the list after the last await", () => {
    it("rebuilds without a request settled meanwhile", async () => {
      const me = seed("Racing");
      const asker = seed("Asker");
      const a = openRequest(asker, me, "first");
      const b = openRequest(asker, me, "second");
      const gate = gatePreparation();
      const offer = offerReplyReminders(me);
      await gate.atGate;
      settlePeerRequests({
        settlerSessionId: me,
        keys: [peerRequestKey(a)],
        reason: "done",
      });
      gate.open();
      await offer;
      const [text] = reminders(me);
      assert.equal(reminders(me).length, 1);
      assert.ok(!text!.includes(peerRequestKey(a)));
      assert.ok(text!.includes(peerRequestKey(b)));
      assert.equal(count(a.id), 0);
      assert.equal(count(b.id), 1);
    });

    it("starts no turn when everything was answered meanwhile", async () => {
      const me = seed("Racing");
      const asker = seed("Asker");
      const a = openRequest(asker, me, "only");
      const gate = gatePreparation();
      const offer = offerReplyReminders(me);
      await gate.atGate;
      settlePeerRequests({
        settlerSessionId: me,
        keys: [peerRequestKey(a)],
        reason: "done",
      });
      gate.open();
      await offer;
      assert.equal(reminders(me).length, 0);
      assert.equal(userTexts(me).length, 0);
      assert.deepEqual(reoffers, []);
    });

    const overtakers: Array<
      [string, (me: string) => Promise<() => void> | (() => void)]
    > = [
      [
        "a message the user queued",
        (me) => {
          promptQueueStore.append({
            id: `q-${n++}`,
            sessionId: me,
            text: "mine first",
          });
          return () => {};
        },
      ],
      [
        "an agent handoff",
        (me) => {
          handoffs.enqueueAgentHandoff({
            sessionId: me,
            origin: { kind: "system", source: "test" },
            text: "card decided",
            visible: true,
          } as never);
          handoffOwed = (id) => handoffs.agentHandoffOwed(id);
          return () => {};
        },
      ],
      [
        "a background wake",
        () => {
          wakeOwed = () => true;
          return () => {
            wakeOwed = () => false;
          };
        },
      ],
      [
        "a peer prompt",
        async (me) => {
          await sendPeerPrompt({
            senderSessionId: seed("Late sender"),
            targetSessionId: me,
            prompt: "late",
            responseRequested: false,
          });
          return () => {};
        },
      ],
    ];
    for (const [what, arrive] of overtakers)
      it(`gives way to ${what} and offers the edge again`, async () => {
        const me = seed("Yielding");
        const r = openRequest(seed("Asker"), me, "question");
        const gate = gatePreparation();
        const offer = offerReplyReminders(me);
        await gate.atGate;
        const clear = await arrive(me);
        gate.open();
        await offer;
        assert.equal(reminders(me).length, 0);
        assert.equal(count(r.id), 0);
        assert.deepEqual(reoffers, [me]);
        clear();
      });

    it("gives way to a send-now that started waiting", async () => {
      const me = seed("Yielding");
      openRequest(seed("Asker"), me, "question");
      const { markExplicitRecipientWaiter, releaseExplicitRecipientWaiter } =
        await import("./recipientDrainAuthority.ts");
      const gate = gatePreparation();
      const offer = offerReplyReminders(me);
      await gate.atGate;
      markExplicitRecipientWaiter(me);
      gate.open();
      try {
        await offer;
      } finally {
        releaseExplicitRecipientWaiter(me);
      }
      assert.equal(reminders(me).length, 0);
      assert.deepEqual(reoffers, [me]);
    });

    it("does not give way to a card nobody has decided", async () => {
      const me = seed("Asking");
      openRequest(seed("Asker"), me, "question");
      handoffOwed = (id) => handoffs.agentHandoffOwed(id);
      await offerReplyReminders(me);
      assert.equal(reminders(me).length, 1);
    });

    it("stops offering the edge again when a blocker never clears", async () => {
      const me = seed("Stuck");
      openRequest(seed("Asker"), me, "question");
      wakeOwed = () => true;
      for (let i = 0; i < 6; i += 1) await offerReplyReminders(me);
      assert.equal(reoffers.length, 3);
      wakeOwed = () => false;
    });

    it("accepts at most one of two concurrent offers", async () => {
      const me = seed("Twice");
      const r = openRequest(seed("Asker"), me, "question");
      await Promise.all([offerReplyReminders(me), offerReplyReminders(me)]);
      assert.equal(reminders(me).length, 1);
      assert.equal(count(r.id), 1);
    });
  });

  it("delivers a notice owed while the reminder held the drain lock, without another event", async () => {
    const me = seed("Coordinator");
    const child = seed("Child");
    openRequest(seed("Asker"), me, "question");
    const driver = driverFor(me);
    const release = driver.holdTurns();
    const offer = offerReplyReminders(me);
    await until(() => driver.isRunning, "the reminder turn");
    // A request it sent is cut off mid-reminder: it is owed a notice, and
    // the wake for it finds the reminder holding the drain lock.
    const chainId = peerPromptStore.createChain();
    const sent = peerPromptStore.enqueue({
      conversationId: `rem-conv-${n++}`,
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: me,
      recipientSessionId: child,
      prompt: "please review",
      responseRequested: true,
    });
    peerPromptStore.claimNext(child, "test", 60_000);
    peerPromptStore.markAdmitted(sent.id);
    peerPromptStore.markInterrupted(sent.id, "the process died", "restart");
    void drainRecipient(me);
    release();
    await offer;
    await until(
      () => userTexts(me).some((t) => t.startsWith("Peer notice")),
      "the notice",
    );
  });

  it("speaks in the deepest request's chain, spends no hop, and a plain reply answers it", async () => {
    const me = seed("Answering");
    const shallow = seed("Shallow asker");
    const deep = seed("Deep asker");
    openRequest(shallow, me, "shallow question");
    const chainId = peerPromptStore.createChain();
    peerPromptStore.reserveHop(chainId);
    peerPromptStore.reserveHop(chainId);
    const anchor = openRequest(deep, me, "deep question", { chainId });
    const nextHop = peerPromptStore.getChain(chainId)!.nextHop;
    const driver = driverFor(me);
    const release = driver.holdTurns();
    const offer = offerReplyReminders(me);
    await until(() => driver.isRunning, "the reminder turn");
    assert.equal(
      peerPromptStore.getChain(chainId)!.nextHop,
      nextHop,
      "the reminder spends no hop",
    );
    await sendPeerPrompt({
      senderSessionId: me,
      targetSessionId: deep,
      prompt: "here you go",
      responseRequested: false,
    });
    release();
    await offer;
    const answered = peerPromptStore.getById(anchor.id)!;
    assert.equal(answered.status, "replied");
    const [reply] = peerPromptStore
      .listByChain(chainId)
      .filter((m) => m.senderSessionId === me);
    assert.equal(reply!.hop, nextHop);
  });
});

describe("the user-entry seam", () => {
  it("is heard for every appended entry, before the prompt's own callback", async () => {
    const me = seed("Seam");
    const { subscribeSessionUserEntry } =
      await import("./session/runtime/liveSession.ts");
    const heard: string[] = [];
    const stop = subscribeSessionUserEntry((id) => {
      if (id === me) heard.push("listener");
    });
    const throwing = subscribeSessionUserEntry(() => {
      throw new Error("one listener failing");
    });
    try {
      await promptRuntimeSession(driverFor(me), "hello", {
        origin: { kind: "system", source: "test" },
        onUserEntry: () => heard.push("onUserEntry"),
      });
    } finally {
      stop();
      throwing();
    }
    assert.deepEqual(heard, ["listener", "onUserEntry"]);
  });
});

describe("the idle edge (idleEdge.ts)", () => {
  it("offers the reminder last, after the background step settles", async () => {
    const order: string[] = [];
    let finishBackground!: () => void;
    const edge = createIdleEdge({
      runAutoApprovals: async () => void order.push("approvals"),
      drainAgentHandoffs: async () => void order.push("handoffs"),
      drainPromptQueue: async () => void order.push("queue"),
      drainBackground: (_id, rerun) => {
        order.push(`background:${rerun}`);
        return new Promise<void>((resolve) => (finishBackground = resolve));
      },
      offerReplyReminders: async () => void order.push("reminders"),
    });
    edge.offer("s1");
    await until(() => order.includes("background:false"), "background");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(!order.includes("reminders"));
    finishBackground();
    await until(() => order.includes("reminders"), "reminders");
    assert.deepEqual(order, [
      "approvals",
      "handoffs",
      "queue",
      "background:false",
      "reminders",
    ]);
  });

  it("a queue that yields offers background delivery only, never the reminder", async () => {
    const order: string[] = [];
    const edge = createIdleEdge({
      runAutoApprovals: async () => void order.push("approvals"),
      drainAgentHandoffs: async () => void order.push("handoffs"),
      drainPromptQueue: async () => void order.push("queue"),
      drainBackground: async (_id, rerun) =>
        void order.push(`background:${rerun}`),
      offerReplyReminders: async () => void order.push("reminders"),
    });
    edge.offerAfterQueue("s1");
    await until(() => order.includes("background:true"), "background");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(order, ["background:true"]);
  });

  it("an edge overlapping a queue's yield settles on exactly one reminder", async () => {
    const me = seed("Overlap");
    const r = openRequest(seed("Asker"), me, "question");
    const background = new BackgroundCompletionDelivery({
      drainPeers: drainRecipient,
      offer: async () => "delivered",
    });
    wakeOwed = (id) => background.wakeOwed(id);
    const edge = createIdleEdge({
      runAutoApprovals: async () => {},
      drainAgentHandoffs: async () => {},
      drainPromptQueue: async () => {},
      drainBackground: (id, rerun) =>
        rerun ? background.requestDrain(id) : background.drain(id),
      offerReplyReminders,
    });
    setReplyReminderHost({
      handoffOwed: () => false,
      wakeOwed: (id) => background.wakeOwed(id),
      requestIdleEdge: (id) => {
        reoffers.push(id);
        edge.offer(id);
      },
    });
    edge.offer(me);
    edge.offerAfterQueue(me);
    await until(() => reminders(me).length === 1, "the reminder");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(reminders(me).length, 1);
    assert.equal(count(r.id), 1);
    assert.ok(reoffers.length <= 3, "re-offers stop");
  });

  it("a deferred background fact rides the reminder turn", async () => {
    const me = seed("Deferred");
    openRequest(seed("Asker"), me, "question");
    const { setDeferredBackgroundContextProvider } =
      await import("./session/runtimePrompt.ts");
    const background = new BackgroundCompletionDelivery({
      drainPeers: drainRecipient,
      offer: async () => "delivered",
      disposition: () => "defer",
    });
    background.enqueue(me, {
      itemId: "bg-item",
      label: "Build",
      status: "succeeded",
      humanLink: "/background-tasks",
    } as never);
    assert.equal(background.queuedCount(me), 1);
    assert.equal(
      background.wakeOwed(me),
      false,
      "a deferred fact wakes nothing",
    );
    setDeferredBackgroundContextProvider((id) =>
      background.claimDeferredContext(id),
    );
    wakeOwed = (id) => background.wakeOwed(id);
    try {
      const edge = createIdleEdge({
        runAutoApprovals: async () => {},
        drainAgentHandoffs: async () => {},
        drainPromptQueue: async () => {},
        drainBackground: (id) => background.drain(id),
        offerReplyReminders,
      });
      edge.offer(me);
      await until(() => reminders(me).length === 1, "the reminder");
      const modelText = driverFor(me).promptTexts.at(-1) ?? "";
      assert.ok(modelText.includes("Peer reminder"));
      assert.ok(
        modelText.includes("Background-work status recorded"),
        "the deferred fact is in the reminder turn's model-only context",
      );
      assert.equal(background.queuedCount(me), 0);
    } finally {
      setDeferredBackgroundContextProvider(undefined);
    }
  });
});
