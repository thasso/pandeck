import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeAll, describe, it, vi } from "vitest";
import {
  PEER_PROMPT_EXCERPT_CHARS,
  peerPromptExcerpt,
} from "@assistant/shared";
import { sessionStore } from "./db/sessionStore.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { canonicalSessionLogPath } from "./sessionStorage.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { FakeRuntimeDriver } from "./test/fakeRuntimeDriver.ts";

// `vi.mock` factories run hoisted, before normal top-level imports finish
// initializing, so referencing the real `FakeRuntimeDriver` class here would
// hit a TDZ. Tests that need REAL delivery pre-register a real
// `FakeRuntimeDriver` via `driverFor()` (plain module scope, no TDZ issue);
// any id not explicitly registered gets a trivial always-idle stand-in
// (sufficient for tests that only need the target to look "promptable").
// `vi.mock` reliably intercepts `sessionInspection.ts`'s own dynamic
// `import("./hub.ts")` (used by `resolvePromptableTarget`'s resumability
// check), but the engine's OWN three `hub` call sites go through the explicit
// `setHubForTests` seam below instead of relying on module-mocking a
// process-wide dynamically-imported singleton for every call site.
const { fakeDrivers, deadIds, cardUpdates, listBroadcasts, fakeHub } =
  vi.hoisted(() => {
    const fakeDrivers = new Map<string, unknown>();
    const deadIds = new Set<string>();
    /** Session-list rebuilds the engine asked for (who still owes whom). */
    const listBroadcasts = { count: 0 };
    const cardUpdates: Array<{
      sessionId: string;
      messageKey: string;
      state: string;
      failureReason?: string;
    }> = [];
    // A trivial ALWAYS-SUCCEEDING adapter/driver for ids no test explicitly
    // registered via `driverFor()` — self-contained (no external class
    // reference) to avoid a TDZ inside this hoisted factory.
    function defaultStandIn(id: string) {
      return {
        id,
        key: id,
        sessionId: id,
        harness: "pi",
        agentType: "assistant",
        sessionFile: undefined,
        canSteer: false,
        isRunning: false,
        contextInfo: () => ({
          sessionId: id,
          updatedAt: Date.now(),
          messageCounts: {
            user: 0,
            assistant: 0,
            toolCalls: 0,
            toolResults: 0,
            total: 0,
          },
          tokenUsage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
          cost: 0,
        }),
        broadcastState: () => {},
        createRuntimeAdapter: () => ({
          provider: "fake",
          capabilities: { fork: "none", compact: false, attachments: false },
          subscribe: () => () => {},
          getBinding: () => ({ provider: "fake" }),
          prompt: async () => ({ stopReason: "end" }),
          abort: () => {},
          setModel: () => {},
          setReasoning: () => {},
          dispose: () => {},
        }),
      };
    }
    const fakeHub = {
      getLiveById: (id: string) => {
        if (deadIds.has(id)) return undefined;
        if (!fakeDrivers.has(id)) fakeDrivers.set(id, defaultStandIn(id));
        return fakeDrivers.get(id);
      },
      acquireById: async (id: string) => {
        if (deadIds.has(id)) throw new Error("no on-disk state to resume from");
        if (!fakeDrivers.has(id)) fakeDrivers.set(id, defaultStandIn(id));
        return fakeDrivers.get(id);
      },
      broadcastSessions: () => {
        listBroadcasts.count += 1;
      },
      broadcastPeerPromptCardUpdate: (
        sessionId: string,
        update: { messageKey: string; state: string; failureReason?: string },
      ) => {
        cardUpdates.push({ sessionId, ...update });
      },
    };
    return { fakeDrivers, deadIds, cardUpdates, listBroadcasts, fakeHub };
  });

vi.mock("./hub.ts", () => ({ hub: fakeHub }));

const {
  BATCH_MAX_MESSAGES,
  ENVELOPE_OVERHEAD_MAX,
  RETRY_MAX_ATTEMPTS,
  buildEnvelope,
  cancelQueuedPeerPrompts,
  closeChainsForHumanPrompt,
  drainAllQueuedOnBoot,
  drainRecipient,
  peerPromptAnchorFor,
  peerPromptThreadsFor,
  recoverPeerPromptsOnBoot,
  runPeerPromptRetention,
  sendPeerPrompt,
  setHubForTests,
  setPeerPromptAutoDeliverForTests,
  setInterruptionNoticeRetryDelayForTests,
  setPeerPromptDeliveryStoppedForTests,
  stopPeerPromptDelivery,
  sweepExpiredLeases,
  sweepPeerPromptRetries,
} = await import("./peerPrompt.ts");
const { sessionSendPromptTools } =
  await import("./tools/sessions/sessionSendPromptTool.ts");
const { setSessionIdleHook } = await import("./session/runtime/liveSession.ts");
const { applySessionContext, resolveSessionContext } =
  await import("./sessionContext.ts");
const { createTask } = await import("./tasks.ts");
const { promptRuntimeSession } = await import("./session/runtimePrompt.ts");

setHubForTests(fakeHub as any);

let n = 0;
const created: string[] = [];
const tool = () => sessionSendPromptTools()[0]!;

beforeAll(() => setPeerPromptAutoDeliverForTests(false));

function seed(
  title = "Peer session",
  opts: Partial<{
    scope: "user" | "internal";
    archived: boolean;
    harness: "pi" | "claude-sdk";
  }> = {},
): string {
  const id = `pp-sess-${n++}`;
  sessionStore.upsert({
    id,
    harness: opts.harness ?? "pi",
    agentType: "assistant",
    title,
    scope: opts.scope ?? "user",
  });
  if (opts.archived) sessionStore.setArchived(id, true);
  created.push(id);
  return id;
}

/** Get (or lazily create) the REAL fake runtime driver an id resolves to through the mocked hub. */
function driverFor(id: string): FakeRuntimeDriver {
  const existing = fakeDrivers.get(id);
  if (existing instanceof FakeRuntimeDriver) return existing;
  const driver = new FakeRuntimeDriver(id);
  fakeDrivers.set(id, driver);
  return driver;
}

afterEach(() => {
  for (const id of created.splice(0)) {
    sessionStore.remove(id);
    fakeDrivers.delete(id);
    deadIds.delete(id);
    rmSync(dirname(canonicalSessionLogPath(id)), {
      recursive: true,
      force: true,
    });
  }
  cardUpdates.length = 0;
});

const ctx = (sessionId: string, title = "Sender") => ({
  toolCallId: "t",
  session: {
    sessionId,
    harness: "pi" as const,
    agentType: "assistant" as const,
    title,
  },
});

describe("session_send_prompt tool", () => {
  it("exposes exactly the four public fields", () => {
    const props = (tool().parameters as any).properties;
    assert.deepEqual(Object.keys(props).sort(), [
      "prompt",
      "responseRequested",
      "targetSessionId",
      "taskId",
    ]);
    assert.deepEqual((tool().parameters as any).required.sort(), [
      "prompt",
      "targetSessionId",
    ]);
  });

  it("validates before enqueue", async () => {
    const target = seed();
    await assert.rejects(
      () => tool().execute({ targetSessionId: "  ", prompt: "hi" }, ctx("me")),
      /required/,
    );
    await assert.rejects(
      () =>
        tool().execute({ targetSessionId: target, prompt: "  " }, ctx("me")),
      /prompt is required/,
    );
    await assert.rejects(
      () =>
        tool().execute(
          { targetSessionId: target, prompt: "x".repeat(8001) },
          ctx("me"),
        ),
      /8000-character/,
    );
    await assert.rejects(
      () => tool().execute({ targetSessionId: "me", prompt: "hi" }, ctx("me")),
      /current session/,
    );
    await assert.rejects(
      () =>
        tool().execute({ targetSessionId: "ghost", prompt: "hi" }, ctx("me")),
      /No session found/,
    );
    const archived = seed("Archived", { archived: true });
    await assert.rejects(
      () =>
        tool().execute({ targetSessionId: archived, prompt: "hi" }, ctx("me")),
      /archived/,
    );
    const internal = seed("Internal", { scope: "internal" });
    await assert.rejects(
      () =>
        tool().execute({ targetSessionId: internal, prompt: "hi" }, ctx("me")),
      /internal/,
    );
    await assert.rejects(
      () =>
        tool().execute(
          { targetSessionId: target, prompt: "hi", taskId: "999999" },
          ctx("me"),
        ),
      /was not found/,
    );
  });

  it("rejects a known non-promptable target (evicted, no resumable state) before enqueue", async () => {
    const dead = seed("Evicted");
    deadIds.add(dead);
    await assert.rejects(
      () => tool().execute({ targetSessionId: dead, prompt: "hi" }, ctx("me")),
      /cannot currently be prompted/,
    );
    assert.equal(
      peerPromptStore.listByParticipant(dead).length,
      0,
      "rejected before persisting",
    );
  });

  it("returns a sanitized queued card carrying only the linkable peer session id", async () => {
    const target = seed("Reviewer");
    const result = await tool().execute(
      { targetSessionId: target, prompt: "please review" },
      ctx("me", "Implementer"),
    );
    const payload = result.details as any;
    assert.equal(payload.renderKind, "sessionPeerPrompt");
    assert.equal(payload.card.direction, "sent");
    assert.equal(payload.card.recipientTitle, "Reviewer");
    assert.equal(payload.card.state, "queued");
    assert.equal(typeof payload.card.messageKey, "string");
    // The recipient's session id is the card's ONE id: it is the navigation
    // target, and the sender named it in the first place. Everything else --
    // message, conversation and chain ids -- stays opaque.
    assert.equal(payload.card.peerSessionId, target);
    const row = peerPromptStore.listByParticipant(target)[0]!;
    const text = JSON.stringify(payload.card);
    for (const id of [row.id, row.conversationId, row.chainId])
      assert.equal(text.includes(id), false, `card must not leak ${id}`);
  });
});

describe("peer prompt engine", () => {
  it("keeps the delivery envelope overhead under budget and batches by limits", () => {
    const chainId = peerPromptStore.createChain();
    // Worst case for the overhead budget: a clipped-length sender title, a
    // uuid-shaped sender id, and the (longer) reply cue.
    const msgs = Array.from({ length: BATCH_MAX_MESSAGES }, (_, i) =>
      peerPromptStore.enqueue({
        conversationId: "c1",
        chainId,
        hop: peerPromptStore.reserveHop(chainId),
        senderSessionId: "019fc18d-da26-7c9f-9511-d869b5f34bfa",
        recipientSessionId: "R",
        prompt: `line ${i}`,
        responseRequested: true,
        senderLabel: "x".repeat(200),
      }),
    );
    const envelope = buildEnvelope(msgs);
    const body = msgs.map((m) => m.prompt).join("\n\n");
    const overhead = envelope.length - body.length;
    assert.ok(overhead <= ENVELOPE_OVERHEAD_MAX, `overhead=${overhead}`);
    assert.ok(
      envelope.includes("line 0") &&
        envelope.includes(`line ${BATCH_MAX_MESSAGES - 1}`),
    );
  });

  it("names the sender session id in the reply cue, only when one is requested", () => {
    const chainId = peerPromptStore.createChain();
    const enqueue = (responseRequested: boolean) =>
      peerPromptStore.enqueue({
        conversationId: "c-cue",
        chainId,
        hop: peerPromptStore.reserveHop(chainId),
        senderSessionId: "sender-abc",
        recipientSessionId: "R",
        prompt: "have a look",
        responseRequested,
        senderLabel: "Implementer",
      });
    const asked = buildEnvelope([enqueue(true)]);
    assert.match(asked, /session_send_prompt to session `sender-abc`/);
    assert.match(asked, /end your turn/);
    const told = buildEnvelope([enqueue(false)]);
    assert.equal(told.includes("sender-abc"), false);
    assert.equal(told.includes("session_send_prompt"), false);
  });

  it("auto-correlates a unique unreplied request into the same conversation", async () => {
    const me = seed("Me");
    const other = seed("Other");
    // `other` asked `me` a question earlier (responseRequested), admitted.
    const chainId = peerPromptStore.createChain();
    const original = peerPromptStore.enqueue({
      conversationId: "conv-x",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: other,
      recipientSessionId: me,
      prompt: "what is the status?",
      responseRequested: true,
    });
    peerPromptStore.markAdmitted(
      (peerPromptStore.claimNext(me, "d", 1000) ?? original).id,
    );

    const { message } = await sendPeerPrompt({
      senderSessionId: me,
      targetSessionId: other,
      prompt: "status is green",
      responseRequested: false,
    });
    assert.equal(
      message.conversationId,
      "conv-x",
      "reply continues the same conversation",
    );
    assert.equal(
      peerPromptStore.getById(original.id)?.status,
      "replied",
      "the original request is marked replied",
    );
    assert.equal(message.replyToMessageId, original.id);
  });

  it("recovers in-flight rows: admitted-before-crash interrupts, others requeue", () => {
    const chainId = peerPromptStore.createChain();
    const admittedRecipient = `r-adm-${n++}`;
    const freshRecipient = `r-fresh-${n++}`;
    const m1 = peerPromptStore.enqueue({
      conversationId: "cr1",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: "S",
      recipientSessionId: admittedRecipient,
      prompt: "delivered before crash",
      responseRequested: false,
    });
    const m2 = peerPromptStore.enqueue({
      conversationId: "cr2",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: "S",
      recipientSessionId: freshRecipient,
      prompt: "never delivered",
      responseRequested: false,
    });
    peerPromptStore.claimNext(admittedRecipient, "d", 60_000); // -> dispatching
    peerPromptStore.claimNext(freshRecipient, "d", 60_000); // -> dispatching

    // Simulate m1 having been admitted to the recipient log before the crash.
    const logPath = canonicalSessionLogPath(admittedRecipient);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(
      logPath,
      `${JSON.stringify({ type: "message", role: "user", id: "u1", clientRequestId: `peer:${m1.id}`, content: [{ type: "text", text: "x" }] })}\n`,
      "utf8",
    );

    const result = recoverPeerPromptsOnBoot();
    assert.ok(result.recovered >= 2);
    assert.equal(peerPromptStore.getById(m1.id)?.status, "interrupted");
    assert.equal(peerPromptStore.getById(m2.id)?.status, "queued");
    rmSync(dirname(logPath), { recursive: true, force: true });
  });

  it("recovers EVERY row of a delivered batch, not just the head", () => {
    const recipient = `r-batch-${n++}`;
    const chainId = peerPromptStore.createChain();
    const m1 = peerPromptStore.enqueue({
      conversationId: "bconv",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: "S",
      recipientSessionId: recipient,
      prompt: "one",
      responseRequested: false,
    });
    const m2 = peerPromptStore.enqueue({
      conversationId: "bconv",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: "S",
      recipientSessionId: recipient,
      prompt: "two",
      responseRequested: false,
    });
    peerPromptStore.claimBatch(recipient, "d", 60_000, 5, 16_000); // both -> dispatching

    // The delivered turn persisted BOTH member keys in the recipient log.
    const logPath = canonicalSessionLogPath(recipient);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(
      logPath,
      `${JSON.stringify({ type: "message", role: "user", id: "u1", clientRequestId: `peer:${m1.id}`, peerMessageIds: [`peer:${m1.id}`, `peer:${m2.id}`], content: [{ type: "text", text: "envelope" }] })}\n`,
      "utf8",
    );

    recoverPeerPromptsOnBoot();
    assert.equal(peerPromptStore.getById(m1.id)?.status, "interrupted");
    assert.equal(
      peerPromptStore.getById(m2.id)?.status,
      "interrupted",
      "non-head batch row must also be recovered, not requeued",
    );
    rmSync(dirname(logPath), { recursive: true, force: true });
  });

  it("recovers rows stranded in admitted/acknowledged (crash after admission, before run completion) as interrupted, never requeued", async () => {
    const admittedRecipient = `r-strand-adm-${n++}`;
    const ackedRecipient = `r-strand-ack-${n++}`;
    const chainId = peerPromptStore.createChain();
    const admitted = peerPromptStore.enqueue({
      conversationId: "strand-adm",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: "S",
      recipientSessionId: admittedRecipient,
      prompt: "x",
      responseRequested: false,
    });
    const acked = peerPromptStore.enqueue({
      conversationId: "strand-ack",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: "S",
      recipientSessionId: ackedRecipient,
      prompt: "y",
      responseRequested: false,
    });
    peerPromptStore.claimNext(admittedRecipient, "d", 60_000);
    peerPromptStore.markAdmitted(admitted.id); // crash lands here: after admission, before run completion
    peerPromptStore.claimNext(ackedRecipient, "d", 60_000);
    peerPromptStore.markAdmitted(acked.id);
    peerPromptStore.markAcknowledged(acked.id); // crash lands here instead: run started, never finished
    cardUpdates.length = 0;

    const result = recoverPeerPromptsOnBoot();
    await Promise.resolve(); // flush the fire-and-forget broadcast microtask
    assert.equal(
      peerPromptStore.getById(admitted.id)?.status,
      "interrupted",
      "an admitted-but-unresolved row must never be re-queued for reinjection",
    );
    assert.equal(
      peerPromptStore.getById(acked.id)?.status,
      "interrupted",
      "an acknowledged-but-unresolved row must never be re-queued for reinjection",
    );
    assert.deepEqual(
      peerPromptStore
        .getById(admitted.id)
        ?.transitions.map((t) => t.to)
        .slice(-1),
      ["interrupted"],
      "the recovery is an audited transition, not a raw SQL update",
    );
    assert.ok(result.interrupted >= 2);
    assert.ok(
      cardUpdates.some(
        (u) => u.sessionId === admittedRecipient && u.state === "interrupted",
      ),
    );
    assert.ok(
      cardUpdates.some(
        (u) => u.sessionId === ackedRecipient && u.state === "interrupted",
      ),
    );
  });

  it("restores batch_head_id from the canonical log when the crash lands between admission append and markDeliveryBatch", async () => {
    // The canonical log append (with peerMessageIds) happens BEFORE our own
    // markDeliveryBatch bookkeeping, so simulate a crash landing exactly in
    // that window: the log already has the full batch's admission keys, but
    // neither row's batch_head_id column was ever set.
    const recipient = `r-restore-${n++}`;
    const chainId = peerPromptStore.createChain();
    const m1 = peerPromptStore.enqueue({
      conversationId: "restore-conv",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: "S",
      recipientSessionId: recipient,
      prompt: "one",
      responseRequested: false,
    });
    const m2 = peerPromptStore.enqueue({
      conversationId: "restore-conv",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: "S",
      recipientSessionId: recipient,
      prompt: "two",
      responseRequested: true,
    });
    peerPromptStore.claimBatch(recipient, "d", 60_000, 5, 16_000); // both -> dispatching
    assert.equal(
      peerPromptStore.getById(m1.id)?.batchHeadId,
      undefined,
      "batch_head_id must NOT be set yet (simulating the pre-markDeliveryBatch crash)",
    );

    const logPath = canonicalSessionLogPath(recipient);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(
      logPath,
      `${JSON.stringify({ type: "message", role: "user", id: "u1", clientRequestId: `peer:${m1.id}`, peerMessageIds: [`peer:${m1.id}`, `peer:${m2.id}`], content: [{ type: "text", text: "envelope" }] })}\n`,
      "utf8",
    );
    cardUpdates.length = 0;

    recoverPeerPromptsOnBoot();
    await Promise.resolve(); // flush the fire-and-forget broadcast microtask

    assert.equal(peerPromptStore.getById(m1.id)?.status, "interrupted");
    assert.equal(
      peerPromptStore.getById(m2.id)?.status,
      "interrupted",
      "non-head batch row must also be recovered",
    );
    assert.equal(
      peerPromptStore.getById(m1.id)?.batchHeadId,
      m1.id,
      "batch_head_id must be restored from peerMessageIds, not left null",
    );
    assert.equal(
      peerPromptStore.getById(m2.id)?.batchHeadId,
      m1.id,
      "the non-head row must be grouped under the SAME restored head id",
    );

    // Both rows must broadcast under ONE shared (aggregate) key to the
    // recipient, not two separate individual keys — matching the ONE
    // canonical card the recipient's log actually recorded.
    const recipientKeys = new Set(
      cardUpdates
        .filter((u) => u.sessionId === recipient)
        .map((u) => u.messageKey),
    );
    assert.equal(
      recipientKeys.size,
      1,
      "recovery must reconcile the ONE canonical batch card, not split it into per-row keys",
    );

    // A reconnect read must now group these rows into ONE history entry too.
    const history = peerPromptThreadsFor(recipient);
    const received = history.threads
      .flatMap((t) => t.messages)
      .filter((m) => m.direction === "received");
    assert.equal(
      received.length,
      1,
      "reconnect must be able to match the ONE canonical batch card after recovery",
    );
    rmSync(dirname(logPath), { recursive: true, force: true });
  });

  it("recoverPeerPromptsOnBoot appends an audited transition and broadcasts for rows recovered back to queued (not just interrupted ones)", async () => {
    const recipient = `r-recq-${n++}`;
    const chainId = peerPromptStore.createChain();
    const m = peerPromptStore.enqueue({
      conversationId: "recq",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: "S",
      recipientSessionId: recipient,
      prompt: "never delivered",
      responseRequested: false,
    });
    peerPromptStore.claimNext(recipient, "d", 60_000); // -> dispatching, never admitted
    cardUpdates.length = 0;

    recoverPeerPromptsOnBoot();
    await Promise.resolve(); // flush the fire-and-forget broadcast microtask
    const row = peerPromptStore.getById(m.id)!;
    assert.equal(row.status, "queued");
    assert.deepEqual(
      row.transitions.map((t) => t.to),
      ["queued", "dispatching", "queued"],
      "the recovery transition is audited, not a raw SQL update",
    );
    assert.ok(
      cardUpdates.some((u) => u.sessionId === recipient),
      "recovered-to-queued rows must also broadcast, not just interrupted ones",
    );
  });

  it("sweepExpiredLeases requeues an expired in-process lease through an audited transition and broadcasts + redrains", async () => {
    const recipient = seed("LeaseRecipient");
    driverFor(recipient).behavior = { mode: "success" };
    const chainId = peerPromptStore.createChain();
    const m = peerPromptStore.enqueue({
      conversationId: "lease",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: "S",
      recipientSessionId: recipient,
      prompt: "hi",
      responseRequested: false,
    });
    peerPromptStore.claimNext(recipient, "some-other-drainer", -1); // lease already expired
    cardUpdates.length = 0;

    sweepExpiredLeases();
    await Promise.resolve(); // flush the fire-and-forget broadcast microtask
    // requeueDueRetries only handles retryable_failed; the lease sweep must
    // independently recover a hung dispatching lease back to queued.
    const requeued = peerPromptStore.getById(m.id)!;
    assert.ok(
      [
        "queued",
        "dispatching",
        "admitted",
        "acknowledged",
        "completed",
      ].includes(requeued.status),
      `unexpected status ${requeued.status}`,
    );
    assert.deepEqual(
      requeued.transitions.map((t) => t.to).slice(0, 3),
      ["queued", "dispatching", "queued"],
      "the lease-expiry requeue is an audited transition",
    );
    assert.ok(
      cardUpdates.some((u) => u.sessionId === recipient),
      "the lease-expiry requeue must broadcast a card update",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      peerPromptStore.getById(m.id)?.status,
      "completed",
      "the lease sweep must also re-drain the freed recipient",
    );
  });

  it("rebuilds the session list when queued requests are cancelled", async () => {
    const recipient = `r-cancel-${n++}`;
    const chainId = peerPromptStore.createChain();
    peerPromptStore.enqueue({
      conversationId: "cancel",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: "S-cancel",
      recipientSessionId: recipient,
      prompt: "q",
      responseRequested: true,
    });
    const listsBefore = listBroadcasts.count;
    const cancelled = cancelQueuedPeerPrompts({
      senderSessionId: "S-cancel",
      recipientSessionId: recipient,
      reason: "test",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cancelled.length, 1);
    assert.ok(
      listBroadcasts.count > listsBefore,
      "a cancel outside any turn still reaches the session list",
    );
  });

  it("refreshes both participants' resident state on a transition, whichever engine runs them", async () => {
    const sender = `S-refresh-${n++}`;
    const recipient = `r-refresh-${n++}`;
    const refreshed: string[] = [];
    // A Claude sender and a pi recipient: the refresh asks the resident
    // session by id, never one engine's store.
    for (const [id, harness] of [
      [sender, "claude-sdk"],
      [recipient, "pi"],
    ] as const)
      fakeDrivers.set(id, {
        id,
        key: id,
        sessionId: id,
        harness,
        broadcastState: () => refreshed.push(id),
      });
    const chainId = peerPromptStore.createChain();
    peerPromptStore.enqueue({
      conversationId: "refresh",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "q",
      responseRequested: true,
    });
    cancelQueuedPeerPrompts({
      senderSessionId: sender,
      recipientSessionId: recipient,
      reason: "test",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(refreshed.sort(), [recipient, sender].sort());
  });

  it("runPeerPromptRetention appends an audited transition and broadcasts for each expired row", async () => {
    const recipient = `r-exp-${n++}`;
    const chainId = peerPromptStore.createChain();
    const m = peerPromptStore.enqueue({
      conversationId: "exp",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: "S",
      recipientSessionId: recipient,
      prompt: "q",
      responseRequested: true,
      expiresAt: Date.now() - 1000,
    });
    peerPromptStore.markAdmitted(
      (peerPromptStore.claimNext(recipient, "d", 1000) ?? m).id,
    );
    peerPromptStore.markCompleted(m.id); // -> awaiting_response
    cardUpdates.length = 0;
    const listsBefore = listBroadcasts.count;

    const result = runPeerPromptRetention(Date.now() + 10_000);
    await new Promise((resolve) => setTimeout(resolve, 0)); // flush broadcasts
    assert.equal(result.expired, 1);
    assert.ok(
      listBroadcasts.count > listsBefore,
      "an expired request owes nothing: the session list is rebuilt",
    );
    const row = peerPromptStore.getById(m.id)!;
    assert.equal(row.status, "expired");
    assert.deepEqual(row.transitions.map((t) => t.to).slice(-1), ["expired"]);
    assert.ok(
      cardUpdates.some(
        (u) => u.sessionId === recipient && u.state === "expired",
      ),
      "expiry must broadcast a targeted card update, not just mutate silently",
    );
  });

  it("gives a session that has never run its starting context, once", async () => {
    // An agent-spawned session is created by one path and first prompted here,
    // and this envelope has no attachment slot — so delivery rebuilds the
    // context from the links its creator recorded ([Task-554](pa://task/554)).
    const recipient = seed("SpawnedRecipient");
    const sender = seed("SpawnSender");
    const driver = driverFor(recipient);
    driver.behavior = { mode: "success" };
    driver.acceptsAttachments = true;
    const task = createTask({
      title: "Spawned assignment",
      source: { createdBy: "user" },
    });
    await applySessionContext(resolveSessionContext({ taskId: task.id }), {
      sessionId: recipient,
      harness: "pi",
      agentType: "assistant",
    });

    await sendPeerPrompt({
      senderSessionId: sender,
      targetSessionId: recipient,
      prompt: "you are the reviewer",
      responseRequested: false,
    });
    await drainRecipient(recipient);

    const first = driver.promptOptions.at(-1);
    assert.equal(first?.attachments?.length, 1, "first turn carries context");
    assert.equal(first?.attachments?.[0]?.role, "task-context");

    // A session already in conversation has had this context since it began;
    // re-injecting it on every peer message would be a leak, not a service.
    sessionStore.upsert({
      id: recipient,
      harness: "pi",
      agentType: "assistant",
      messageCount: 2,
    });
    await sendPeerPrompt({
      senderSessionId: sender,
      targetSessionId: recipient,
      prompt: "one more thing",
      responseRequested: false,
    });
    await drainRecipient(recipient);

    assert.equal(driver.promptOptions.at(-1)?.attachments, undefined);
  });

  it("runPeerPromptRetention broadcasts the batch-aware aggregate for an expired batched row, matching the key reconnect will seed", async () => {
    const recipient = seed("ExpireBatchRecipient");
    const sender = seed("ExpireBatchSender");
    driverFor(recipient).behavior = { mode: "success" };
    const chainId = peerPromptStore.createChain();
    peerPromptStore.enqueue({
      conversationId: "batch-expire",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "first (no reply needed)",
      responseRequested: false,
    });
    const request = peerPromptStore.enqueue({
      conversationId: "batch-expire",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "second (reply needed)",
      responseRequested: true,
      expiresAt: Date.now() - 1000,
    });
    await drainRecipient(recipient);
    assert.equal(
      peerPromptStore.getById(request.id)?.status,
      "awaiting_response",
    );
    cardUpdates.length = 0;

    const result = runPeerPromptRetention(Date.now() + 10_000);
    await Promise.resolve(); // flush the fire-and-forget broadcast microtask
    assert.equal(result.expired, 1);
    assert.equal(peerPromptStore.getById(request.id)?.status, "expired");

    const historyForRecipient = peerPromptThreadsFor(recipient);
    const received = historyForRecipient.threads
      .flatMap((t) => t.messages)
      .filter((m) => m.direction === "received");
    assert.equal(received.length, 1);
    assert.equal(received[0]?.state, "expired");
    const recipientUpdates = cardUpdates.filter(
      (u) => u.sessionId === recipient,
    );
    assert.ok(
      recipientUpdates.some(
        (u) => u.messageKey === received[0]!.id && u.state === "expired",
      ),
      "expiry must broadcast the SAME batch-aggregate key reconnect will seed, not an orphaned per-row key",
    );
  });

  it("coalesces concurrent drains for the same recipient", () => {
    const a = drainRecipient("nonexistent-recipient-xyz");
    const b = drainRecipient("nonexistent-recipient-xyz");
    assert.equal(a, b, "concurrent drains share one in-flight promise");
    return Promise.all([a, b]);
  });

  it("starts a new conversation when correlation is ambiguous", async () => {
    const me = seed("Me2");
    const other = seed("Other2");
    for (let i = 0; i < 2; i++) {
      const chainId = peerPromptStore.createChain();
      const m = peerPromptStore.enqueue({
        conversationId: `amb-${i}`,
        chainId,
        hop: peerPromptStore.reserveHop(chainId),
        senderSessionId: other,
        recipientSessionId: me,
        prompt: `q${i}`,
        responseRequested: true,
      });
      peerPromptStore.markAdmitted(
        (peerPromptStore.claimNext(me, "d", 1000) ?? m).id,
      );
    }
    const { message } = await sendPeerPrompt({
      senderSessionId: me,
      targetSessionId: other,
      prompt: "reply",
      responseRequested: false,
    });
    assert.equal(
      message.conversationId.startsWith("amb-"),
      false,
      "ambiguous correlation starts fresh",
    );
    assert.equal(message.replyToMessageId, undefined);
  });

  it("rejects a send that would exceed the configured causal-chain hop limit", async () => {
    const originalMaxHops = getSettings().sessionPeerPromptMaxHops;
    const configuredMaxHops = 3;
    const me = seed("HopMe");
    const other = seed("HopOther");
    const chainId = peerPromptStore.createChain();
    peerPromptStore.addParticipant(chainId, me);
    peerPromptStore.addParticipant(chainId, other);
    updateSettings({ sessionPeerPromptMaxHops: configuredMaxHops });
    try {
      // Advance next_hop so the next reservation lands beyond the live setting.
      for (let i = 0; i < configuredMaxHops; i++)
        peerPromptStore.reserveHop(chainId);
      const req = peerPromptStore.enqueue({
        conversationId: "hop-conv",
        chainId,
        hop: configuredMaxHops,
        senderSessionId: other,
        recipientSessionId: me,
        prompt: "ping",
        responseRequested: true,
      });
      peerPromptStore.markAdmitted(
        (peerPromptStore.claimNext(me, "d", 1000) ?? req).id,
      );

      await assert.rejects(
        () =>
          sendPeerPrompt({
            senderSessionId: me,
            targetSessionId: other,
            prompt: "reply",
            responseRequested: false,
          }),
        /3-hop limit/,
      );
      // Rejected before persisting: the original request is NOT marked replied.
      assert.equal(peerPromptStore.getById(req.id)?.status, "admitted");
    } finally {
      updateSettings({ sessionPeerPromptMaxHops: originalMaxHops });
    }

    // The opening prompt of a freshly SPAWNED session ([Task-553](pa://task/553))
    // travels this same path, and needs no hop exemption: a first exchange with
    // a session that shares no history opens its own conversation and chain, so
    // an exhausted chain elsewhere cannot starve work a human just approved.
    const spawned = seed("HopSpawned");
    const { message } = await sendPeerPrompt({
      senderSessionId: me,
      targetSessionId: spawned,
      prompt: "you are the reviewer",
      responseRequested: true,
    });
    assert.notEqual(message.chainId, chainId);
    assert.equal(message.hop, 1);
  });

  it("projects a bounded, sanitized sender+recipient history with opaque keys", async () => {
    const me = seed("HistMe");
    const other = seed("HistOther");
    const conv = "hist-conv";
    const chain = peerPromptStore.createChain();
    const sent = peerPromptStore.enqueue({
      conversationId: conv,
      chainId: chain,
      hop: peerPromptStore.reserveHop(chain),
      senderSessionId: me,
      recipientSessionId: other,
      prompt: "please review",
      responseRequested: true,
      taskLabel: "Fix bug",
    });
    peerPromptStore.enqueue({
      conversationId: conv,
      chainId: chain,
      hop: peerPromptStore.reserveHop(chain),
      senderSessionId: other,
      recipientSessionId: me,
      prompt: "looks good",
      responseRequested: false,
    });

    const projection = peerPromptThreadsFor(me);
    assert.equal(projection.threads.length, 1);
    const thread = projection.threads[0]!;
    assert.deepEqual(
      thread.messages.map((m) => m.direction),
      ["sent", "received"],
    );
    assert.equal(thread.messages[0]!.taskTitle, "Fix bug");
    // The other party's session id is carried so the thread can link to that
    // conversation — the same field a transcript card already shows.
    assert.equal(thread.peerSessionId, other);
    // Everything else stays sanitized: no routing ids, message ids or paths, and
    // not the viewer's own id either.
    const serialized = JSON.stringify(projection);
    for (const leak of [me, conv, chain, sent.id])
      assert.equal(serialized.includes(leak), false, `leaked ${leak}`);
  });

  it("anchors a sent message at the RECIPIENT's delivery entry", async () => {
    const sender = seed("AnchorSender");
    const recipient = seed("AnchorRecipient");
    driverFor(recipient).behavior = { mode: "success" };
    await sendPeerPrompt({
      senderSessionId: sender,
      targetSessionId: recipient,
      prompt: "please look at the lease sweep",
      responseRequested: false,
    });
    await drainRecipient(recipient);

    const thread = peerPromptThreadsFor(sender).threads[0]!;
    const anchor = peerPromptAnchorFor(sender, thread.messages[0]!.id);
    assert.equal(anchor?.sessionId, recipient);
    assert.ok((anchor?.index ?? -1) >= 0);
    // The entry it names is the recipient's own card for this message, not the
    // sender's: that is the copy the reader is sent to read.
    const delivered = readFileSync(canonicalSessionLogPath(recipient), "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, any>)
      .find((entry) => entry.id === anchor?.entryId);
    assert.ok(delivered?.peerPrompt, "anchored entry carries the peer card");
    assert.notEqual(delivered.peerPrompt.messageKey, thread.messages[0]!.id);
  });

  it("anchors a received message at the SENDER's row, folding its tool result into the assistant entry", () => {
    const me = seed("AnchorRecipient2");
    const other = seed("AnchorSender2");
    const chain = peerPromptStore.createChain();
    const received = peerPromptStore.enqueue({
      conversationId: "anchor-conv",
      chainId: chain,
      hop: peerPromptStore.reserveHop(chain),
      senderSessionId: other,
      recipientSessionId: me,
      prompt: "have a look",
      responseRequested: false,
    });
    const messageKey = peerPromptThreadsFor(me).threads[0]!.messages[0]!.id;

    // The sender's copy is the `session_send_prompt` RESULT, which the
    // transcript renders inside the assistant turn that called the tool.
    const logPath = canonicalSessionLogPath(other);
    mkdirSync(dirname(logPath), { recursive: true });
    const senderCardKey =
      peerPromptThreadsFor(other).threads[0]!.messages[0]!.id;
    writeFileSync(
      logPath,
      [
        JSON.stringify({
          type: "message",
          role: "assistant",
          id: "a1",
          seq: 0,
          content: [
            {
              type: "toolCall",
              toolCallId: "call-1",
              name: "session_send_prompt",
              input: {},
            },
          ],
        }),
        JSON.stringify({
          type: "message",
          role: "toolResult",
          id: "tr1",
          seq: 1,
          toolCallId: "call-1",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                renderKind: "sessionPeerPrompt",
                card: { messageKey: senderCardKey },
              }),
            },
          ],
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const anchor = peerPromptAnchorFor(me, messageKey);
    assert.deepEqual(anchor, { sessionId: other, entryId: "a1", index: 0 });
    assert.notEqual(received.id, undefined);
  });

  it("answers nothing for a key this session has no row for", () => {
    const me = seed("AnchorNobody");
    assert.equal(peerPromptAnchorFor(me, "knope"), undefined);
  });

  it("human intervention closes chains so a later reply starts fresh", async () => {
    const me = seed("HrMe");
    const other = seed("HrOther");
    const { message: request } = await sendPeerPrompt({
      senderSessionId: other,
      targetSessionId: me,
      prompt: "need input",
      responseRequested: true,
    });
    peerPromptStore.markAdmitted(
      (peerPromptStore.claimNext(me, "d", 1000) ?? request).id,
    );
    const oldChain = request.chainId;

    closeChainsForHumanPrompt(me);
    assert.equal(peerPromptStore.getChain(oldChain)?.closed, true);

    const { message: reply } = await sendPeerPrompt({
      senderSessionId: me,
      targetSessionId: other,
      prompt: "here",
      responseRequested: false,
    });
    assert.notEqual(reply.chainId, oldChain, "closed chain is not continued");
    assert.equal(reply.replyToMessageId, undefined);
  });
});

describe("real delivery through a fake runtime driver", () => {
  it("delivers an idle target end-to-end: admitted -> acknowledged -> completed", async () => {
    const sender = seed("Sender1");
    const recipient = seed("Recipient1");
    driverFor(recipient).behavior = { mode: "success" };
    const { message } = await sendPeerPrompt({
      senderSessionId: sender,
      targetSessionId: recipient,
      prompt: "hello",
      responseRequested: false,
    });
    await drainRecipient(recipient);
    const final = peerPromptStore.getById(message.id)!;
    assert.equal(final.status, "completed");
    assert.deepEqual(
      final.transitions.map((t) => t.to),
      ["queued", "dispatching", "admitted", "acknowledged", "completed"],
    );
  });

  it("stops delivering new batches during graceful shutdown so the drain can settle", async () => {
    const sender = seed("SenderShutdown");
    const recipient = seed("RecipientShutdown");
    driverFor(recipient).behavior = { mode: "success" };
    const { message } = await sendPeerPrompt({
      senderSessionId: sender,
      targetSessionId: recipient,
      prompt: "hello",
      responseRequested: false,
    });
    // Shutdown requested: no new batch delivery must start, so the idle hook
    // cannot re-drive the recipient and keep the process running.
    stopPeerPromptDelivery();
    try {
      await drainRecipient(recipient);
      const held = peerPromptStore.getById(message.id)!;
      assert.equal(
        held.status,
        "queued",
        "row must stay queued (undelivered) while delivery is stopped",
      );
      assert.deepEqual(
        held.transitions.map((t) => t.to),
        ["queued"],
      );
    } finally {
      setPeerPromptDeliveryStoppedForTests(false);
    }
    // Delivery resumes normally after the flag is cleared (e.g. next boot).
    await drainRecipient(recipient);
    assert.equal(peerPromptStore.getById(message.id)!.status, "completed");
  });

  it("desensitizes the delivered origin: no raw sender session id in the recipient's canonical log", async () => {
    const sender = seed("Sender2");
    const recipient = seed("Recipient2");
    driverFor(recipient).behavior = { mode: "success" };
    await sendPeerPrompt({
      senderSessionId: sender,
      targetSessionId: recipient,
      prompt: "hi",
      responseRequested: false,
    });
    await drainRecipient(recipient);
    const logText = readFileSync(canonicalSessionLogPath(recipient), "utf8");
    // The display card links back to the sender's session on purpose (see
    // PeerPromptCard.peerSessionId); everything the MODEL reads -- entry
    // content and origin -- still carries no raw sender id.
    const modelFacing = logText
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const { peerPrompt: _card, ...rest } = JSON.parse(line) as Record<
          string,
          unknown
        >;
        return JSON.stringify(rest);
      })
      .join("\n");
    assert.equal(
      modelFacing.includes(sender),
      false,
      "raw sender session id must not appear in the ordinary delivered entry",
    );
    assert.ok(
      logText.includes("peer-prompt"),
      "a non-identifying origin marker is used instead",
    );
    const card = logText
      .split("\n")
      .filter((line) => line.trim())
      .map(
        (line) => JSON.parse(line) as { peerPrompt?: { direction?: string } },
      )
      .find((entry) => entry.peerPrompt?.direction === "received")?.peerPrompt;
    assert.equal((card as any)?.peerSessionId, sender);
  });

  it("aggregates responseRequested across the whole batch, not just the head", async () => {
    const sender = seed("Sender3");
    const recipient = seed("Recipient3");
    const chainId = peerPromptStore.createChain();
    peerPromptStore.enqueue({
      conversationId: "batch-rr",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "first (no reply needed)",
      responseRequested: false,
    });
    peerPromptStore.enqueue({
      conversationId: "batch-rr",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "second (reply needed)",
      responseRequested: true,
    });
    driverFor(recipient).behavior = { mode: "success" };
    await drainRecipient(recipient);
    const logText = readFileSync(canonicalSessionLogPath(recipient), "utf8");
    const lines = logText
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const row = lines.find((l) => l.peerPrompt);
    assert.ok(row, "expected a delivered entry carrying a peerPrompt card");
    assert.equal(
      row.peerPrompt.responseRequested,
      true,
      "the card must reflect any batched member requesting a response",
    );
  });

  it("broadcasts an AGGREGATE state for the batch head's shared card when members finish in different states", async () => {
    const sender = seed("Sender3b");
    const recipient = seed("Recipient3b");
    const chainId = peerPromptStore.createChain();
    const head = peerPromptStore.enqueue({
      conversationId: "batch-agg",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "first (no reply needed)",
      responseRequested: false,
    });
    const second = peerPromptStore.enqueue({
      conversationId: "batch-agg",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "second (reply needed)",
      responseRequested: true,
    });
    driverFor(recipient).behavior = { mode: "success" };
    await drainRecipient(recipient);

    // Per-row truth: head (no response needed) is fully completed; the second
    // member (response needed) is still awaiting a reply.
    assert.equal(peerPromptStore.getById(head.id)?.status, "completed");
    assert.equal(
      peerPromptStore.getById(second.id)?.status,
      "awaiting_response",
    );

    // The ONE shared recipient card (keyed by the head's messageKey) must
    // reflect the aggregate outcome — awaiting_response — not head's own
    // (already-resolved) status, so it stays consistent with its own
    // aggregated responseRequested: true.
    const headKey = cardUpdates.filter((u) => u.sessionId === recipient);
    const last = headKey[headKey.length - 1];
    assert.equal(last?.state, "awaiting_response");
  });

  it("keeps the head's own sender-side card at its individual state, distinct from the recipient's aggregate batch card", async () => {
    const sender = seed("Sender3c");
    const recipient = seed("Recipient3c");
    const chainId = peerPromptStore.createChain();
    peerPromptStore.enqueue({
      conversationId: "batch-key",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "first (no reply needed)",
      responseRequested: false,
    });
    peerPromptStore.enqueue({
      conversationId: "batch-key",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "second (reply needed)",
      responseRequested: true,
    });
    driverFor(recipient).behavior = { mode: "success" };
    await drainRecipient(recipient);

    // The head's own sender-side card must show ITS OWN resolved state...
    const senderCompletedUpdate = cardUpdates.find(
      (u) => u.sessionId === sender && u.state === "completed",
    );
    // ...while the recipient's ONE shared batch card shows the aggregate state.
    const recipientAggregateUpdate = cardUpdates.find(
      (u) => u.sessionId === recipient && u.state === "awaiting_response",
    );
    assert.ok(
      senderCompletedUpdate,
      "the head's own sender-side card must not be overwritten by the aggregate state",
    );
    assert.ok(
      recipientAggregateUpdate,
      "the recipient's shared batch card must show the aggregate state",
    );
    assert.notEqual(
      senderCompletedUpdate?.messageKey,
      recipientAggregateUpdate?.messageKey,
      "the two cards must use distinct keys so one's update can never overwrite the other",
    );
  });

  it("groups a delivered batch into ONE aggregate-state recipient history entry, keyed the same as the live batch card broadcast", async () => {
    const sender = seed("Sender3d");
    const recipient = seed("Recipient3d");
    const chainId = peerPromptStore.createChain();
    peerPromptStore.enqueue({
      conversationId: "batch-hist",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "first (no reply needed)",
      responseRequested: false,
    });
    peerPromptStore.enqueue({
      conversationId: "batch-hist",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "second (reply needed)",
      responseRequested: true,
    });
    driverFor(recipient).behavior = { mode: "success" };
    await drainRecipient(recipient);

    const recipientHistory = peerPromptThreadsFor(recipient);
    const receivedMessages = recipientHistory.threads
      .flatMap((t) => t.messages)
      .filter((m) => m.direction === "received");
    assert.equal(
      receivedMessages.length,
      1,
      "batch members must collapse into ONE recipient history entry, matching the ONE delivered transcript card",
    );
    assert.equal(
      receivedMessages[0]?.state,
      "awaiting_response",
      "the grouped entry must show the aggregate state",
    );
    assert.equal(receivedMessages[0]?.responseRequested, true);

    const senderHistory = peerPromptThreadsFor(sender);
    const sentMessages = senderHistory.threads
      .flatMap((t) => t.messages)
      .filter((m) => m.direction === "sent");
    assert.equal(
      sentMessages.length,
      2,
      "the sender's OWN per-message cards must stay ungrouped",
    );

    // The reconnect-seeded key must match the live batch-card broadcast key.
    // The batch-aggregate key is the ONE key that is only ever broadcast to
    // the recipient (never the sender) — every other (individual per-message)
    // key goes to both sides, since each row is also its own sender-side card.
    const recipientKeys = new Set(
      cardUpdates
        .filter((u) => u.sessionId === recipient)
        .map((u) => u.messageKey),
    );
    const senderKeys = new Set(
      cardUpdates
        .filter((u) => u.sessionId === sender)
        .map((u) => u.messageKey),
    );
    const recipientOnlyKeys = [...recipientKeys].filter(
      (k) => !senderKeys.has(k),
    );
    assert.equal(
      recipientOnlyKeys.length,
      1,
      "expected exactly one recipient-only (batch-aggregate) card key",
    );
    assert.equal(
      receivedMessages[0]?.id,
      recipientOnlyKeys[0],
      "reconnect must seed the SAME key the live broadcast used for the shared batch card",
    );
  });

  it("keeps a batch's aggregate state complete even when history pagination would otherwise split it across the page boundary", async () => {
    const sender = seed("Sender3e");
    const recipient = seed("Recipient3e");
    const chainId = peerPromptStore.createChain();
    peerPromptStore.enqueue({
      conversationId: "batch-page",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "first (no reply needed)",
      responseRequested: false,
    });
    peerPromptStore.enqueue({
      conversationId: "batch-page",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "second (reply needed)",
      responseRequested: true,
    });
    driverFor(recipient).behavior = { mode: "success" };
    await drainRecipient(recipient);

    // Pad with ONE newer, unrelated row so a narrow (limit=2) window captures
    // the batch's SECOND (later-queued) member plus the pad row, but NOT the
    // batch's first (earlier-queued) member.
    const padChain = peerPromptStore.createChain();
    peerPromptStore.enqueue({
      conversationId: "pad",
      chainId: padChain,
      hop: peerPromptStore.reserveHop(padChain),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "pad",
      responseRequested: false,
    });

    // Two separate "received" entries are expected in the FULL read: the
    // batch's ONE grouped (aggregate) entry, and the unrelated pad message.
    const full = peerPromptThreadsFor(recipient, 50);
    const fullBatchEntry = full.threads
      .flatMap((t) => t.messages)
      .filter((m) => m.direction === "received")
      .find((m) => m.state === "awaiting_response");
    assert.ok(
      fullBatchEntry,
      "the unpaginated read must show the batch's aggregate entry",
    );

    const narrow = peerPromptThreadsFor(recipient, 2);
    const narrowBatchEntry = narrow.threads
      .flatMap((t) => t.messages)
      .filter((m) => m.direction === "received")
      .find((m) => m.state === "awaiting_response");
    assert.ok(
      narrowBatchEntry,
      "the aggregate must reflect the batch's COMPLETE membership even though only one of its members is inside this narrow page",
    );
    assert.equal(
      narrowBatchEntry?.id,
      fullBatchEntry?.id,
      "the grouped entry's key must be identical regardless of the pagination window",
    );
  });

  it("broadcasts an update for the original request's OWN card when a reply marks it replied", async () => {
    const me = seed("ReplyMe");
    const other = seed("ReplyOther");
    driverFor(me).behavior = { mode: "success" };
    driverFor(other).behavior = { mode: "success" };
    const { message: request } = await sendPeerPrompt({
      senderSessionId: other,
      targetSessionId: me,
      prompt: "need input",
      responseRequested: true,
    });
    await drainRecipient(me);
    assert.equal(
      peerPromptStore.getById(request.id)?.status,
      "awaiting_response",
    );
    cardUpdates.length = 0; // isolate the reply's own broadcast

    await sendPeerPrompt({
      senderSessionId: me,
      targetSessionId: other,
      prompt: "here",
      responseRequested: false,
    });
    assert.equal(
      peerPromptStore.getById(request.id)?.status,
      "replied",
      "enqueueRouted marks the original replied atomically",
    );
    const repliedUpdate = cardUpdates.find((u) => u.state === "replied");
    assert.ok(
      repliedUpdate,
      "the original request's own card must receive a Replied update, not just the new reply's card",
    );
  });

  it("broadcasts a reply's card update through the recipient's batch-aware aggregate key, not an orphaned individual key", async () => {
    const me = seed("BatchReplyMe");
    const other = seed("BatchReplyOther");
    driverFor(me).behavior = { mode: "success" };
    driverFor(other).behavior = { mode: "success" };
    const chainId = peerPromptStore.createChain();
    peerPromptStore.enqueue({
      conversationId: "batch-reply",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: other,
      recipientSessionId: me,
      prompt: "first (no reply needed)",
      responseRequested: false,
    });
    const request = peerPromptStore.enqueue({
      conversationId: "batch-reply",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: other,
      recipientSessionId: me,
      prompt: "second (reply needed)",
      responseRequested: true,
    });
    await drainRecipient(me);
    assert.equal(
      peerPromptStore.getById(request.id)?.status,
      "awaiting_response",
    );
    cardUpdates.length = 0;

    await sendPeerPrompt({
      senderSessionId: me,
      targetSessionId: other,
      prompt: "here you go",
      responseRequested: false,
    });
    assert.equal(peerPromptStore.getById(request.id)?.status, "replied");

    const historyForMe = peerPromptThreadsFor(me);
    const receivedForMe = historyForMe.threads
      .flatMap((t) => t.messages)
      .filter((m) => m.direction === "received");
    assert.equal(receivedForMe.length, 1);
    const meUpdates = cardUpdates.filter((u) => u.sessionId === me);
    assert.ok(
      meUpdates.some((u) => u.state === "replied"),
      "the reply must be reflected in the recipient's aggregate card",
    );
    assert.ok(
      meUpdates.some((u) => u.messageKey === receivedForMe[0]!.id),
      "the reply's recipient-side broadcast must use the SAME key as the shared batch card, not an orphaned individual key",
    );
  });

  it("broadcasts a card update to both sender and recipient on every durable transition", async () => {
    const sender = seed("Sender4");
    const recipient = seed("Recipient4");
    driverFor(recipient).behavior = { mode: "success" };
    await sendPeerPrompt({
      senderSessionId: sender,
      targetSessionId: recipient,
      prompt: "hi",
      responseRequested: false,
    });
    await drainRecipient(recipient);
    // messageKey is opaque (hashed); assert both sessions were notified and the
    // final update reflects the real terminal state (completed), not a stale
    // pre-transition snapshot.
    const sessionsSeen = new Set(cardUpdates.map((u) => u.sessionId));
    assert.ok(
      sessionsSeen.has(sender) && sessionsSeen.has(recipient),
      "both sender and recipient are notified",
    );
    assert.ok(cardUpdates.some((u) => u.state === "completed"));
  });

  it("a provider error AFTER admission is interrupted, never re-injected or silently retried", async () => {
    // Admission (the durable log append) happens before the adapter's provider
    // call resolves, so a provider-level failure at this point is a genuinely
    // different case from a pre-admission failure: the prompt already reached
    // the recipient's visible transcript, so it must not be redelivered.
    const sender = seed("Sender5");
    const recipient = seed("Recipient5");
    const driver = driverFor(recipient);
    driver.behavior = { mode: "error", message: "simulated provider failure" };
    const { message } = await sendPeerPrompt({
      senderSessionId: sender,
      targetSessionId: recipient,
      prompt: "hi",
      responseRequested: false,
    });
    await drainRecipient(recipient);
    const row = peerPromptStore.getById(message.id)!;
    assert.equal(row.status, "interrupted");
    assert.equal(row.failureReason, "simulated provider failure");
    // Never becomes retryable/requeued from here.
    sweepPeerPromptRetries(Date.now() + 10_000);
    assert.equal(peerPromptStore.getById(message.id)?.status, "interrupted");
  });

  it("retries a pre-admission (resume) failure with backoff, then succeeds once due and redelivered", async () => {
    const sender = seed("Sender5b");
    const recipient = seed("Recipient5b");
    // Queue while resumable, then the target becomes evicted/unresumable
    // (a transient acquire/resume failure) before delivery is attempted.
    const { message } = await sendPeerPrompt({
      senderSessionId: sender,
      targetSessionId: recipient,
      prompt: "hi",
      responseRequested: false,
    });
    deadIds.add(recipient);
    await drainRecipient(recipient);
    let row = peerPromptStore.getById(message.id)!;
    assert.equal(row.status, "retryable_failed");
    assert.match(row.failureReason ?? "", /could not be resumed/);
    assert.ok(typeof row.nextAttemptAt === "number");

    // Not due yet: a sweep now should not requeue it.
    sweepPeerPromptRetries(Date.now());
    assert.equal(
      peerPromptStore.getById(message.id)?.status,
      "retryable_failed",
    );

    // The target becomes resumable again, and the backoff elapses: sweep requeues and redelivers to completion.
    deadIds.delete(recipient);
    driverFor(recipient).behavior = { mode: "success" };
    cardUpdates.length = 0;
    sweepPeerPromptRetries(row.nextAttemptAt! + 1);
    await drainRecipient(recipient); // the sweep's own drain is fire-and-forget; drive it directly too
    row = peerPromptStore.getById(message.id)!;
    assert.equal(row.status, "completed");
    // The transient resume failure no longer applies once the message
    // actually delivered — a stale "could not be resumed" detail must not
    // survive into the store, live card broadcasts, or reconnect history.
    assert.equal(
      row.failureReason,
      undefined,
      "store state must not carry the stale failure reason once completed",
    );
    // The sweep's own requeue broadcast (still queued/retrying) is allowed to
    // retain the reason; only the FINAL (post-completion) broadcast must not.
    const completedUpdates = cardUpdates.filter((u) => u.state === "completed");
    assert.ok(
      completedUpdates.length > 0,
      "expected at least one completed-state broadcast",
    );
    assert.ok(
      completedUpdates.every((u) => u.failureReason === undefined),
      "the completed-state card broadcast must not carry the stale failure reason",
    );
    const senderHistory = peerPromptThreadsFor(sender);
    const sentMessage = senderHistory.threads
      .flatMap((t) => t.messages)
      .find((m) => m.direction === "sent");
    assert.equal(sentMessage?.state, "completed");
    assert.equal(
      sentMessage?.failureReason,
      undefined,
      "reconnect history must not render the stale failure reason for a completed message",
    );
  });

  it("gives up permanently (failed, not retryable) after the bounded retry limit", async () => {
    const sender = seed("Sender6");
    const recipient = seed("Recipient6");
    const { message } = await sendPeerPrompt({
      senderSessionId: sender,
      targetSessionId: recipient,
      prompt: "hi",
      responseRequested: false,
    });
    deadIds.add(recipient); // a persistent (never-recovering) resume failure
    for (let i = 0; i < RETRY_MAX_ATTEMPTS + 1; i++) {
      await drainRecipient(recipient);
      const row = peerPromptStore.getById(message.id)!;
      if (row.status === "failed") break;
      assert.equal(row.status, "retryable_failed");
      sweepPeerPromptRetries((row.nextAttemptAt ?? Date.now()) + 1);
    }
    assert.equal(
      peerPromptStore.getById(message.id)?.status,
      "failed",
      "bounded retries must eventually give up permanently",
    );
  });

  it("marks a transient resume/acquire failure retryable with an actionable reason (not silently stuck queued)", async () => {
    const sender = seed("Sender7");
    const recipient = seed("Recipient7");
    deadIds.add(recipient); // simulates hub.acquireById throwing (transient resume failure)
    peerPromptStore.enqueueRouted({
      conversationId: "resume-fail",
      chainId: peerPromptStore.createChain(),
      senderSessionId: sender,
      recipientSessionId: recipient,
      participants: [sender, recipient],
      maxHops: 8,
      prompt: "hi",
      responseRequested: false,
    });
    await drainRecipient(recipient);
    const rows = peerPromptStore.listPendingForRecipient(recipient);
    assert.equal(rows.length, 0, "no longer silently queued");
    const all = peerPromptStore.listByParticipant(recipient, 5);
    assert.equal(all[0]?.status, "retryable_failed");
    assert.match(all[0]?.failureReason ?? "", /could not be resumed/);
    assert.ok(typeof all[0]?.nextAttemptAt === "number");
  });

  it("interrupts (never retries/fails) a queued-but-already-canonically-admitted row on an acquisition failure, without ever acquiring the target", async () => {
    // Restart fixture starting from `queued` (not `dispatching`): defense in
    // depth for the "queued but already admitted" state a two-phase boot
    // recovery commit could otherwise leave behind. The recipient is
    // permanently unresumable for this whole test, proving the self-heal in
    // markResumeFailureRetryable never needs to (and does not) acquire it.
    const sender = seed("Sender8");
    const recipient = seed("Recipient8");
    deadIds.add(recipient);
    const chainId = peerPromptStore.createChain();
    const m1 = peerPromptStore.enqueue({
      conversationId: "queued-admitted",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "one",
      responseRequested: false,
    });
    const m2 = peerPromptStore.enqueue({
      conversationId: "queued-admitted",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: "two",
      responseRequested: true,
    });
    assert.equal(peerPromptStore.getById(m1.id)?.status, "queued");

    const logPath = canonicalSessionLogPath(recipient);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(
      logPath,
      `${JSON.stringify({ type: "message", role: "user", id: "u1", clientRequestId: `peer:${m1.id}`, peerMessageIds: [`peer:${m1.id}`, `peer:${m2.id}`], content: [{ type: "text", text: "envelope" }] })}\n`,
      "utf8",
    );
    cardUpdates.length = 0;

    await drainRecipient(recipient);

    assert.equal(
      peerPromptStore.getById(m1.id)?.status,
      "interrupted",
      "must be interrupted, never retried/failed, since the recipient already saw this prompt",
    );
    assert.equal(peerPromptStore.getById(m2.id)?.status, "interrupted");
    assert.equal(
      peerPromptStore.getById(m1.id)?.batchHeadId,
      m1.id,
      "batch grouping must be restored from the log",
    );
    assert.equal(peerPromptStore.getById(m2.id)?.batchHeadId, m1.id);
    assert.ok(
      cardUpdates.some(
        (u) => u.sessionId === recipient && u.state === "interrupted",
      ),
    );
    assert.equal(
      fakeDrivers.has(recipient),
      false,
      "the target must never have been acquired/registered",
    );
    rmSync(dirname(logPath), { recursive: true, force: true });
  });
});

describe("browser-independent drain triggers", () => {
  afterEach(() => setSessionIdleHook(undefined));

  it("drains a queued peer prompt once ANY prompt on the recipient session goes idle (non-web trigger)", async () => {
    const sender = seed("HookSender");
    const recipient = seed("HookRecipient");
    setSessionIdleHook((sessionId) => {
      void drainRecipient(sessionId).catch(() => {});
    });
    const driver = driverFor(recipient);
    driver.behavior = { mode: "success" };
    await sendPeerPrompt({
      senderSessionId: sender,
      targetSessionId: recipient,
      prompt: "hi",
      responseRequested: false,
    });
    assert.equal(
      peerPromptStore.listPendingForRecipient(recipient).length,
      1,
      "queued, not yet delivered",
    );

    // A non-web caller drives a normal prompt on
    // the SAME session; once that turn ends the idle hook must drain the queue.
    await promptRuntimeSession(driver, "system turn", {
      origin: { kind: "system", source: "test" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const rows = peerPromptStore.listByParticipant(recipient, 5);
    assert.ok(
      rows.some((r) => r.status === "completed"),
      "the queued peer prompt drained on idle without any explicit drainRecipient call",
    );
  });

  it("drainAllQueuedOnBoot delivers to a resumable idle target with no browser connection", async () => {
    const sender = seed("BootSender");
    const recipient = seed("BootRecipient");
    driverFor(recipient).behavior = { mode: "success" };
    await sendPeerPrompt({
      senderSessionId: sender,
      targetSessionId: recipient,
      prompt: "hi",
      responseRequested: false,
    });
    assert.equal(peerPromptStore.listPendingForRecipient(recipient).length, 1);

    drainAllQueuedOnBoot();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const rows = peerPromptStore.listByParticipant(recipient, 5);
    assert.ok(
      rows.some((r) => r.status === "completed"),
      "startup drain delivered without a browser connection",
    );
  });
});

/**
 * A sender that asked for a reply and got a restart instead. `interrupted` is
 * terminal and the prompt is never re-injected, so without a notice the sender
 * waits forever for an answer nobody is going to send.
 */
describe("interruption notice to the sender", () => {
  /** A row in the exact state boot recovery leaves behind: delivered, then the process died. */
  function strandedRow(
    sender: string,
    recipient: string,
    prompt: string,
    kind: "restart" | "failure" = "restart",
  ) {
    const chainId = peerPromptStore.createChain();
    const m = peerPromptStore.enqueue({
      conversationId: `notice-${n++}`,
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt,
      responseRequested: true,
    });
    peerPromptStore.claimNext(recipient, "d", 60_000);
    peerPromptStore.markAdmitted(m.id);
    peerPromptStore.markAcknowledged(m.id);
    peerPromptStore.markInterrupted(m.id, "the process died", kind);
    return m;
  }

  it("wakes the sender with the recipient's session id once the restart stranded its request", async () => {
    const sender = seed("NoticeSender");
    const recipient = seed("NoticeRecipient");
    const driver = driverFor(sender);
    driver.behavior = { mode: "success" };
    const m = strandedRow(sender, recipient, "please review the diff");

    await drainRecipient(sender);

    const delivered = readFileSync(canonicalSessionLogPath(sender), "utf8");
    assert.ok(
      delivered.includes(recipient),
      "the notice names the recipient session id, which is the one useful action",
    );
    assert.ok(
      delivered.includes("NoticeRecipient"),
      "and its title, so the sender can recognise it",
    );
    assert.ok(delivered.includes("please review the diff"));
    assert.equal(
      peerPromptStore.getById(m.id)?.senderNotifiedAt !== undefined,
      true,
      "the notice is recorded durably, not in memory",
    );
  });

  it("wakes the sender with the provider's error when the recipient's turn failed", async () => {
    const sender = seed("LimitSender");
    const recipient = seed("LimitRecipient");
    const driver = driverFor(sender);
    driver.behavior = { mode: "success" };
    const m = strandedRow(sender, recipient, "run the suite", "failure");

    await drainRecipient(sender);

    const delivered = readFileSync(canonicalSessionLogPath(sender), "utf8");
    assert.ok(delivered.includes(recipient));
    assert.ok(delivered.includes("run the suite"));
    assert.ok(
      delivered.includes("failed with a provider error"),
      "the notice says it was a failure, not a restart",
    );
    assert.ok(
      delivered.includes("Error: the process died"),
      "and quotes the failure reason, which decides what to do next",
    );
    assert.ok(!delivered.includes("server restarted"));
    assert.equal(driver.promptOptions.length, 1);
    assert.equal(
      peerPromptStore.getById(m.id)?.senderNotifiedAt !== undefined,
      true,
    );
  });

  it("notifies a waiting sender as soon as a delivered turn fails", async () => {
    const sender = seed("FailSender");
    const recipient = seed("FailRecipient");
    driverFor(sender).behavior = { mode: "success" };
    driverFor(recipient).behavior = {
      mode: "error",
      message:
        "Provider refused the content (openai-codex/gpt-6.1-sol): flagged for possible cybersecurity risk",
    };
    const { message } = await sendPeerPrompt({
      senderSessionId: sender,
      targetSessionId: recipient,
      prompt: "review the IAM cutoff",
      responseRequested: true,
    });

    await drainRecipient(recipient);
    // The wake is fire-and-forget from the recipient's drain.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(peerPromptStore.getById(message.id)?.status, "interrupted");
    const delivered = readFileSync(canonicalSessionLogPath(sender), "utf8");
    assert.ok(
      delivered.includes("flagged for possible cybersecurity risk"),
      "the sender learns the provider's reason without anyone draining it",
    );
    assert.equal(
      peerPromptStore.getById(message.id)?.senderNotifiedAt !== undefined,
      true,
    );
  });

  it("does not wake a sender that asked for no reply", async () => {
    const sender = seed("QuietSender");
    const recipient = seed("QuietRecipient");
    driverFor(sender).behavior = { mode: "success" };
    driverFor(recipient).behavior = { mode: "error", message: "boom" };
    await sendPeerPrompt({
      senderSessionId: sender,
      targetSessionId: recipient,
      prompt: "fyi",
      responseRequested: false,
    });

    await drainRecipient(recipient);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(driverFor(sender).promptOptions.length, 0);
  });

  it("never notifies twice, even across a second boot", async () => {
    const sender = seed("OnceSender");
    const recipient = seed("OnceRecipient");
    const driver = driverFor(sender);
    driver.behavior = { mode: "success" };
    strandedRow(sender, recipient, "first");

    await drainRecipient(sender);
    const afterFirst = driver.promptOptions.length;
    assert.equal(afterFirst, 1);

    drainAllQueuedOnBoot();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await drainRecipient(sender);

    assert.equal(
      driver.promptOptions.length,
      afterFirst,
      "the durable mark, not an in-memory set, is what makes it exactly-once",
    );
  });

  it("keeps owing the notice when the sender's turn is refused", async () => {
    const sender = seed("RefusedSender");
    const recipient = seed("RefusedRecipient");
    const driver = driverFor(sender);
    driver.behavior = { mode: "reject", message: "session busy" };
    const m = strandedRow(sender, recipient, "still owed");

    await drainRecipient(sender);

    assert.equal(
      peerPromptStore.getById(m.id)?.senderNotifiedAt,
      undefined,
      "a refused turn must not consume the only warning the sender gets",
    );

    assert.equal(
      driver.promptOptions.length,
      1,
      "the provider was reached once",
    );

    driver.behavior = { mode: "success" };
    await drainRecipient(sender);
    assert.equal(
      driver.promptOptions.length,
      2,
      "the retry must REACH the provider — a dedup key retained from the failed" +
        " attempt would answer it 'already handled' and mark a delivery that never happened",
    );
    assert.equal(
      peerPromptStore.getById(m.id)?.senderNotifiedAt !== undefined,
      true,
      "the next idle delivers it",
    );
  });

  it("retries a refused notice on its own, with no further drain from anywhere", async () => {
    const sender = seed("RetrySender");
    const recipient = seed("RetryRecipient");
    const driver = driverFor(sender);
    driver.behavior = { mode: "reject", message: "provider hiccup" };
    const m = strandedRow(sender, recipient, "needs a retry");
    setInterruptionNoticeRetryDelayForTests(5);
    try {
      // The ONLY drain production performs. The runtime's idle hook fires inside
      // `LiveRuntimeSession.prompt`'s finally, while this drain still holds its lock, so
      // it coalesces and starts nothing; after this returns the sender is idle
      // with an empty queue and no event left to ride.
      await drainRecipient(sender);
      assert.equal(driver.promptOptions.length, 1);
      assert.equal(peerPromptStore.getById(m.id)?.senderNotifiedAt, undefined);

      driver.behavior = { mode: "success" };
      await vi.waitFor(
        () => {
          assert.equal(
            peerPromptStore.getById(m.id)?.senderNotifiedAt !== undefined,
            true,
          );
        },
        { timeout: 2_000, interval: 10 },
      );
      assert.ok(
        driver.promptOptions.length >= 2,
        "the scheduled retry reached the provider without any caller re-draining",
      );
    } finally {
      setInterruptionNoticeRetryDelayForTests(undefined);
    }
  });

  it("recovers when the COLD sender cannot be resumed yet — the case boot exists for", async () => {
    const sender = seed("ColdSender");
    const recipient = seed("ColdRecipient");
    const m = strandedRow(sender, recipient, "owed while cold");
    // No queued row stands behind a notice, so the queue's own resume-failure
    // bookkeeping claims an empty batch and records nothing. The schedule is the
    // only thing keeping this sender reachable.
    deadIds.add(sender);
    setInterruptionNoticeRetryDelayForTests(5);
    try {
      drainAllQueuedOnBoot();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        peerPromptStore.getById(m.id)?.senderNotifiedAt,
        undefined,
        "nothing delivered while the session will not resume",
      );

      deadIds.delete(sender);
      driverFor(sender).behavior = { mode: "success" };
      await vi.waitFor(
        () => {
          assert.equal(
            peerPromptStore.getById(m.id)?.senderNotifiedAt !== undefined,
            true,
          );
        },
        { timeout: 2_000, interval: 10 },
      );
    } finally {
      setInterruptionNoticeRetryDelayForTests(undefined);
      deadIds.delete(sender);
    }
  });

  it("stops retrying a notice once the bounded budget is spent", async () => {
    const sender = seed("BudgetSender");
    const recipient = seed("BudgetRecipient");
    const driver = driverFor(sender);
    driver.behavior = { mode: "reject", message: "always down" };
    const m = strandedRow(sender, recipient, "never lands");
    setInterruptionNoticeRetryDelayForTests(1);
    try {
      await drainRecipient(sender);
      // Every attempt may cold-resume the session, so the schedule must not run
      // forever against a session that cannot take the notice at all.
      await vi.waitFor(
        () => {
          assert.ok(driver.promptOptions.length >= 6);
        },
        { timeout: 2_000, interval: 10 },
      );
      const settled = driver.promptOptions.length;
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(
        driver.promptOptions.length,
        settled,
        "the budget is spent; the owed row now waits for boot, not for a timer",
      );
      assert.equal(
        peerPromptStore.getById(m.id)?.senderNotifiedAt,
        undefined,
        "and it is still owed, never marked delivered",
      );
    } finally {
      setInterruptionNoticeRetryDelayForTests(undefined);
    }
  });

  it("gathers several stranded requests into one notice rather than one wake each", async () => {
    const sender = seed("BatchNoticeSender");
    const a = seed("RecipientA");
    const b = seed("RecipientB");
    const driver = driverFor(sender);
    driver.behavior = { mode: "success" };
    strandedRow(sender, a, "first ask");
    strandedRow(sender, b, "second ask");

    await drainRecipient(sender);

    assert.equal(driver.promptOptions.length, 1, "one turn, not two");
    const delivered = readFileSync(canonicalSessionLogPath(sender), "utf8");
    assert.ok(delivered.includes(a) && delivered.includes(b));
  });

  it("delivers incoming queued work before telling the sender an old prompt died", async () => {
    const sender = seed("OrderSender");
    const recipient = seed("OrderRecipient");
    const other = seed("OrderOther");
    const driver = driverFor(sender);
    driver.behavior = { mode: "success" };
    strandedRow(sender, recipient, "the stranded one");
    await sendPeerPrompt({
      senderSessionId: other,
      targetSessionId: sender,
      prompt: "something newer",
      responseRequested: false,
    });

    await drainRecipient(sender);

    const log = readFileSync(canonicalSessionLogPath(sender), "utf8");
    assert.ok(
      log.indexOf("something newer") < log.indexOf("interruption notice"),
      "queued delivery comes first, so the notice lands on a session already holding its new work",
    );
  });
});

/**
 * What the history projection COSTS. It rides on the viewed session's
 * `SessionState` — so on its snapshot and on every `state` broadcast it makes —
 * and a coordinator's 50 full agent briefs made that 130 KB, re-sent on every
 * turn completion, for a collapsed panel that draws two clamped lines each.
 */
describe("peer-prompt history payload", () => {
  it("carries an excerpt and no audit trail, whatever the message weighs", async () => {
    const sender = `s-excerpt-${n++}`;
    const recipient = `r-excerpt-${n++}`;
    const chainId = peerPromptStore.createChain();
    const brief = `Please review this\n\n${"long brief ".repeat(500)}`;
    const record = peerPromptStore.enqueue({
      conversationId: "excerpt",
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: sender,
      recipientSessionId: recipient,
      prompt: brief,
      responseRequested: false,
    });
    assert.ok(record.prompt.length > 4_000, "the stored message stays whole");

    const sent = peerPromptThreadsFor(sender)
      .threads.flatMap((t) => t.messages)
      .find((m) => m.direction === "sent");
    assert.ok(sent, "the sender sees its own message in the history");
    assert.equal(
      sent.message,
      peerPromptExcerpt(brief),
      "the projection carries the excerpt the reader is shown, not the brief",
    );
    assert.equal(sent.message.length, PEER_PROMPT_EXCERPT_CHARS);
    assert.equal(
      Object.hasOwn(sent, "auditTrail"),
      false,
      "and no transition audit trail: nothing renders it",
    );
    // The whole projection stays small enough to ride on every state frame.
    assert.ok(
      JSON.stringify(peerPromptThreadsFor(sender)).length < 2_000,
      "one long message must not put kilobytes on every broadcast",
    );
  });
});
