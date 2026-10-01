import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type {
  RequestOptions,
  PushSubscription as ServerPushSubscription,
  SendResult,
} from "web-push";
import type { SessionMeta } from "./db/sessionStore.ts";
import type { StoredWebPushSubscription } from "./webPushStore.ts";
import { runOutcomeNeedsUser } from "./sessionOutcomePolicy.ts";
import {
  declarativeWebPushPayload,
  clearBlockedCompletionMarks,
  notifySessionBlocked as notifySessionBlockedImpl,
  notifySessionTurnCompleted as notifySessionTurnCompletedImpl,
  permanentAssistantTurnNotification,
  sendWebPushNotification,
  sessionTurnNotification,
  type AppWebPushNotification,
} from "./webPush.ts";

const storedSubscription: StoredWebPushSubscription = {
  endpoint: "https://push.example.test/subscription/one",
  keys: { p256dh: "public_123", auth: "auth_456" },
  origin: "https://pa.example.test",
  createdAt: 1,
  updatedAt: 1,
};
const vapidKeys = { publicKey: "vapid_public", privateKey: "vapid_private" };
const notification: AppWebPushNotification = {
  title: "Turn finished",
  body: "Implement Web Push",
  navigatePath: "/sessions/session-1",
};

const directOutcomePolicy = {
  isDirectlyOwned: () => true,
  runOutcomeNeedsUser: () => true,
};

function notifySessionBlocked(
  sessionId: Parameters<typeof notifySessionBlockedImpl>[0],
  blocked: Parameters<typeof notifySessionBlockedImpl>[1],
  detail?: Parameters<typeof notifySessionBlockedImpl>[2],
  dependencies: Parameters<typeof notifySessionBlockedImpl>[3] = {},
) {
  return notifySessionBlockedImpl(sessionId, blocked, detail, {
    ...directOutcomePolicy,
    ...dependencies,
  });
}

function notifySessionTurnCompleted(
  sessionId: Parameters<typeof notifySessionTurnCompletedImpl>[0],
  stopReason: Parameters<typeof notifySessionTurnCompletedImpl>[1],
  dependencies: Parameters<typeof notifySessionTurnCompletedImpl>[2] = {},
) {
  return notifySessionTurnCompletedImpl(sessionId, stopReason, {
    ...directOutcomePolicy,
    ...dependencies,
  });
}

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "session-1",
    scope: "user",
    purpose: "chat",
    harness: "pi",
    agentType: "assistant",
    title: "Implement Web Push",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 2,
    readAt: 0,
    forkAutoRenamePending: false,
    ...overrides,
  };
}

test("builds the standardized declarative payload with a same-origin session route", () => {
  assert.deepEqual(
    declarativeWebPushPayload(notification, storedSubscription.origin),
    {
      web_push: 8030,
      notification: {
        title: "Turn finished",
        body: "Implement Web Push",
        navigate: "https://pa.example.test/sessions/session-1",
        silent: false,
      },
    },
  );
  assert.throws(
    () =>
      declarativeWebPushPayload(
        { ...notification, navigatePath: "https://elsewhere.example/session" },
        storedSubscription.origin,
      ),
    /registered app origin/,
  );
});

test("sends declarative JSON using encrypted Web Push", async () => {
  const calls: Array<{
    subscription: ServerPushSubscription;
    payload: string | Buffer | null | undefined;
    options: RequestOptions | undefined;
  }> = [];
  const sendNotification = async (
    subscription: ServerPushSubscription,
    payload?: string | Buffer | null,
    options?: RequestOptions,
  ): Promise<SendResult> => {
    calls.push({ subscription, payload, options });
    return { statusCode: 201, body: "", headers: {} };
  };

  await sendWebPushNotification(notification, {
    subscriptions: [storedSubscription],
    vapidKeys,
    sendNotification,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options?.contentEncoding, "aes128gcm");
  assert.deepEqual(
    JSON.parse(String(calls[0]?.payload)),
    declarativeWebPushPayload(notification, storedSubscription.origin),
  );
});

test("prunes expired endpoints and contains transient delivery failures", async () => {
  const removed: string[] = [];
  const expiredSend = async (): Promise<SendResult> => {
    throw Object.assign(new Error("gone"), { statusCode: 410 });
  };
  await sendWebPushNotification(notification, {
    subscriptions: [storedSubscription],
    vapidKeys,
    sendNotification: expiredSend,
    removeSubscription: (endpoint) => {
      removed.push(endpoint);
      return true;
    },
  });
  assert.deepEqual(removed, [storedSubscription.endpoint]);

  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const failedSend = async (): Promise<SendResult> => {
    throw Object.assign(new Error("temporary"), { statusCode: 503 });
  };
  await assert.doesNotReject(() =>
    sendWebPushNotification(notification, {
      subscriptions: [storedSubscription],
      vapidKeys,
      sendNotification: failedSend,
    }),
  );
  assert.equal(warning.mock.calls.length, 1);
  warning.mockRestore();
});

test("maps ordinary and permanent-assistant completion outcomes", () => {
  assert.equal(
    sessionTurnNotification("session-1", "Build feature", "end").title,
    "Turn finished",
  );
  assert.equal(
    sessionTurnNotification("session-1", "Build feature", "error").title,
    "Turn failed",
  );
  assert.equal(
    sessionTurnNotification("session-1", "Build feature", "aborted").title,
    "Turn stopped",
  );

  assert.deepEqual(permanentAssistantTurnNotification("Ada", "end"), {
    title: "Ada",
    body: "I've finished responding.",
    navigatePath: "/assistant",
  });
  assert.equal(
    permanentAssistantTurnNotification("Ada", "error").body,
    "I couldn't finish that response.",
  );
  assert.equal(
    permanentAssistantTurnNotification("Ada", "aborted").body,
    "My response was stopped.",
  );
});

test("special-cases the permanent assistant and only sends for user-visible sessions", async () => {
  const sent: AppWebPushNotification[] = [];
  const send = async (value: AppWebPushNotification) => {
    sent.push(value);
  };
  await notifySessionTurnCompleted("session-1", "end", {
    getSession: () => session(),
    send,
  });
  await notifySessionTurnCompleted("assistant-1", "end", {
    getSession: () =>
      session({
        id: "assistant-1",
        agentType: "personal-assistant",
        title: "An old conversation title",
      }),
    getPermanentAssistantName: () => "Ada",
    send,
  });
  await notifySessionTurnCompleted("internal-1", "end", {
    getSession: () => session({ id: "internal-1", scope: "internal" }),
    send,
  });
  await notifySessionTurnCompleted("missing", "end", {
    getSession: () => undefined,
    send,
  });

  assert.deepEqual(sent, [
    {
      title: "Turn finished",
      body: "Implement Web Push",
      navigatePath: "/sessions/session-1",
    },
    {
      title: "Ada",
      body: "I've finished responding.",
      navigatePath: "/assistant",
    },
  ]);
});

test("keeps coordinator-owned children and intermediate parent wakes quiet", async () => {
  clearBlockedCompletionMarks();
  const sent: AppWebPushNotification[] = [];
  const send = async (value: AppWebPushNotification) => {
    sent.push(value);
  };

  await notifySessionBlocked("child", "question", undefined, {
    getSession: () => session({ id: "child", title: "Reviewer" }),
    isDirectlyOwned: () => false,
    send,
  });
  await notifySessionTurnCompleted("child", "end", {
    getSession: () => session({ id: "child", title: "Reviewer" }),
    runOutcomeNeedsUser: () => false,
    send,
  });

  let outstandingResponseRequestCount = 1;
  const parentPolicy = (
    _sessionId: string,
    stopReason: Parameters<typeof runOutcomeNeedsUser>[0]["stopReason"],
    origin: Parameters<typeof runOutcomeNeedsUser>[0]["origin"],
  ) =>
    runOutcomeNeedsUser({
      ownership: undefined,
      origin,
      stopReason,
      outstandingResponseRequestCount,
    });
  await notifySessionTurnCompleted("parent", "end", {
    getSession: () => session({ id: "parent", title: "Coordinator" }),
    origin: { kind: "agent", agentId: "peer-prompt" },
    runOutcomeNeedsUser: parentPolicy,
    send,
  });
  assert.equal(
    sent.length,
    0,
    "child and intermediate parent turns stay quiet",
  );
  assert.equal(
    runOutcomeNeedsUser({
      ownership: undefined,
      origin: { kind: "agent", agentId: "peer-prompt" },
      stopReason: "error",
      outstandingResponseRequestCount,
    }),
    true,
    "an intermediate parent failure still needs the user",
  );

  await notifySessionTurnCompleted("parent", "end", {
    getSession: () => session({ id: "parent", title: "Coordinator" }),
    origin: { kind: "human" },
    runOutcomeNeedsUser: parentPolicy,
    send,
  });
  assert.deepEqual(
    sent.map((value) => value.body),
    ["Coordinator"],
    "a direct human turn remains independently notify-worthy",
  );

  outstandingResponseRequestCount = 0;
  await notifySessionTurnCompleted("parent", "end", {
    getSession: () => session({ id: "parent", title: "Coordinator" }),
    origin: { kind: "agent", agentId: "peer-prompt" },
    runOutcomeNeedsUser: parentPolicy,
    send,
  });
  assert.equal(sent.length, 2, "the final expected peer report notifies");

  await notifySessionTurnCompleted("parent", "aborted", {
    getSession: () => session({ id: "parent", title: "Coordinator" }),
    send,
  });
  assert.equal(sent.length, 2, "a user-stopped turn does not notify");
});

/**
 * The other half of the push policy (`docs/messaging.md`): push is for a
 * blocked agent as well as a finished result. The failure this guards is
 * silence — the work has STOPPED, and the user learning that only when they
 * next happen to open the app is exactly the cost push exists to avoid.
 */
test("pushes when an agent is blocked on the user, with the same session guards", async () => {
  const sent: AppWebPushNotification[] = [];
  const send = async (value: AppWebPushNotification) => {
    sent.push(value);
  };
  await notifySessionBlocked("session-1", "approval", "Create pull request", {
    getSession: () => session(),
    send,
  });
  await notifySessionBlocked("session-1", "question", undefined, {
    getSession: () => session(),
    send,
  });
  // An internal session has no user to interrupt, and a missing one no title.
  await notifySessionBlocked("internal-1", "approval", "x", {
    getSession: () => session({ id: "internal-1", scope: "internal" }),
    send,
  });
  await notifySessionBlocked("missing", "approval", "x", {
    getSession: () => undefined,
    send,
  });

  assert.deepEqual(sent, [
    {
      title: "Approval needed",
      body: "Implement Web Push — Create pull request",
      navigatePath: "/sessions/session-1",
    },
    {
      title: "Question waiting",
      body: "Implement Web Push",
      navigatePath: "/sessions/session-1",
    },
  ]);
});

/**
 * ONE user wait, ONE alert — but only the wait's OWN completion is silenced.
 *
 * The approval and question tools terminate the run, so a block is immediately
 * followed by a completion for the same wait. Matching on "is this session
 * blocked right now" would be wrong in the other direction: a blocked session
 * still takes fresh turns (a queued peer prompt drains on every running→idle
 * transition), and those turns' results are legitimate alerts that must not be
 * swallowed for as long as the approval stays open. So the mark is one-shot.
 */
test("silences the block's own completion, and nothing after it", async () => {
  clearBlockedCompletionMarks();
  const sent: AppWebPushNotification[] = [];
  const send = async (value: AppWebPushNotification) => {
    sent.push(value);
  };

  await notifySessionBlocked("session-1", "approval", "Create pull request", {
    getSession: () => session(),
    send,
  });
  // The run the approval ended reports completion for that same wait.
  await notifySessionTurnCompleted("session-1", "end", {
    getSession: () => session(),
    send,
  });
  assert.deepEqual(
    sent.map((n) => n.title),
    ["Approval needed"],
  );

  // A LATER turn — a drained peer prompt, say — finishes while the approval is
  // still open. Its result is its own, and is announced.
  await notifySessionTurnCompleted("session-1", "end", {
    getSession: () => session(),
    send,
  });
  assert.deepEqual(
    sent.map((n) => n.title),
    ["Approval needed", "Turn finished"],
  );
});

/**
 * A block whose delivery FAILED alerted nobody, so it may not also consume the
 * completion that follows: one wait, one alert — never zero. The mark still
 * goes down before the delivery (the completion can arrive first), and is
 * released only when the delivery is known to have failed.
 */
test("a failed block delivery leaves its completion free to alert", async () => {
  clearBlockedCompletionMarks();
  const sent: AppWebPushNotification[] = [];
  await assert.rejects(
    notifySessionBlocked("session-1", "approval", "Create pull request", {
      getSession: () => session(),
      send: async () => {
        throw new Error("push service unreachable");
      },
    }),
  );
  await notifySessionTurnCompleted("session-1", "end", {
    getSession: () => session(),
    send: async (value) => {
      sent.push(value);
    },
  });
  assert.deepEqual(
    sent.map((n) => n.title),
    ["Turn finished"],
  );
});

// The mark belongs to the session it was raised for.
test("does not silence a different session's completion", async () => {
  clearBlockedCompletionMarks();
  const sent: AppWebPushNotification[] = [];
  const send = async (value: AppWebPushNotification) => {
    sent.push(value);
  };
  await notifySessionBlocked("session-1", "question", undefined, {
    getSession: () => session(),
    send,
  });
  await notifySessionTurnCompleted("other-1", "end", {
    getSession: () => session({ id: "other-1", title: "Another session" }),
    send,
  });
  assert.deepEqual(
    sent.map((n) => n.title),
    ["Question waiting", "Turn finished"],
  );
});
