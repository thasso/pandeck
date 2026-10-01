import webPush from "web-push";
import {
  PERSONAL_ASSISTANT_AGENT_TYPE,
  type WebPushConfigResponse,
} from "@assistant/shared";
import { paObjectPath } from "@assistant/shared/objectLinks";
import type { AgentStopReason, PromptOrigin } from "@assistant/shared/session";
import { sendApnsNotification } from "./apns.ts";
import { PUBLIC_BASE_URL } from "./config.ts";
import { sessionStore, type SessionMeta } from "./db/sessionStore.ts";
import { getSettings } from "./settings.ts";
import {
  sessionIsDirectlyOwned,
  sessionRunOutcomeNeedsUser,
} from "./sessionOutcomePolicy.ts";
import type { PullRequestObservationResult } from "./workflow/resultContracts.ts";
import {
  getOrCreateVapidKeys,
  listWebPushSubscriptions,
  removeWebPushSubscription,
  type StoredVapidKeys,
  type StoredWebPushSubscription,
} from "./webPushStore.ts";

const VAPID_SUBJECT = PUBLIC_BASE_URL || "mailto:web-push@localhost";
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 240;
const PERMANENT_ASSISTANT_PATH = "/assistant";

export interface AppWebPushNotification {
  title: string;
  body: string;
  navigatePath: string;
}

interface DeclarativeWebPushPayload {
  web_push: 8030;
  notification: {
    title: string;
    body: string;
    navigate: string;
    silent: false;
  };
}

type SendNotification = typeof webPush.sendNotification;

interface SendDependencies {
  subscriptions?: StoredWebPushSubscription[];
  vapidKeys?: StoredVapidKeys;
  sendNotification?: SendNotification;
  removeSubscription?: (endpoint: string) => boolean;
}

interface CompletionDependencies {
  getSession?: (sessionId: string) => SessionMeta | undefined;
  getPermanentAssistantName?: () => string;
  send?: (notification: AppWebPushNotification) => Promise<void>;
  /** The completed run's trigger, supplied by the normalized runtime event. */
  origin?: PromptOrigin;
  isDirectlyOwned?: (sessionId: string) => boolean;
  runOutcomeNeedsUser?: (
    sessionId: string,
    stopReason: AgentStopReason,
    origin: PromptOrigin | undefined,
  ) => boolean;
}

function boundedText(
  value: string,
  fallback: string,
  maxChars: number,
): string {
  const normalized = value.replace(/\s+/g, " ").trim() || fallback;
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 1)}…`;
}

export function getWebPushConfig(): WebPushConfigResponse {
  const keys = getOrCreateVapidKeys(() => webPush.generateVAPIDKeys());
  return { applicationServerKey: keys.publicKey };
}

export function declarativeWebPushPayload(
  notification: AppWebPushNotification,
  origin: string,
): DeclarativeWebPushPayload {
  const navigate = new URL(notification.navigatePath, origin).toString();
  if (new URL(navigate).origin !== new URL(origin).origin)
    throw new Error(
      "Web Push navigation must stay on the registered app origin.",
    );
  return {
    web_push: 8030,
    notification: {
      title: boundedText(notification.title, "Pandeck update", MAX_TITLE_CHARS),
      body: boundedText(
        notification.body,
        "A session changed.",
        MAX_BODY_CHARS,
      ),
      navigate,
      silent: false,
    },
  };
}

function errorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = Number((error as { statusCode?: unknown }).statusCode);
  return Number.isInteger(value) ? value : undefined;
}

/** Send one declarative notification to every registered browser installation. */
export async function sendWebPushNotification(
  notification: AppWebPushNotification,
  dependencies: SendDependencies = {},
): Promise<void> {
  const subscriptions =
    dependencies.subscriptions ?? listWebPushSubscriptions();
  if (subscriptions.length === 0) return;
  const vapidKeys =
    dependencies.vapidKeys ??
    getOrCreateVapidKeys(() => webPush.generateVAPIDKeys());
  const sendNotification =
    dependencies.sendNotification ?? webPush.sendNotification;
  const removeSubscription =
    dependencies.removeSubscription ?? removeWebPushSubscription;

  await Promise.all(
    subscriptions.map(async (subscription) => {
      const payload = JSON.stringify(
        declarativeWebPushPayload(notification, subscription.origin),
      );
      try {
        await sendNotification(subscription, payload, {
          vapidDetails: {
            subject: VAPID_SUBJECT,
            publicKey: vapidKeys.publicKey,
            privateKey: vapidKeys.privateKey,
          },
          contentEncoding: "aes128gcm",
          TTL: 60 * 60,
          urgency: "normal",
          timeout: 15_000,
        });
      } catch (error) {
        const statusCode = errorStatusCode(error);
        if (statusCode === 404 || statusCode === 410) {
          try {
            removeSubscription(subscription.endpoint);
          } catch (removeError) {
            console.warn(
              "[web-push] failed to remove expired subscription:",
              removeError instanceof Error
                ? removeError.message
                : String(removeError),
            );
          }
          return;
        }
        console.warn(
          `[web-push] delivery failed${statusCode ? ` (${statusCode})` : ""}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }),
  );
}

/**
 * The live-socket half of delivery. Set by the hub; absent in tests and until
 * the hub is up, where dropping the broadcast is the right answer anyway.
 *
 * `broadcastAll`, not a topic, and deliberately so: an alert is not a list, and
 * the server cannot tell which connected client has a push subscription and
 * which has no push service at all. Every client hears it and the ONE that must
 * act does.
 */
export interface AppNotificationBroadcaster {
  broadcastAll(notification: AppWebPushNotification): void;
}

let notificationBroadcaster: AppNotificationBroadcaster | null = null;

export function setAppNotificationBroadcaster(
  next: AppNotificationBroadcaster | null,
): void {
  notificationBroadcaster = next;
}

/**
 * Deliver one alert by EVERY route, which is what every caller wants.
 *
 * Three of them, because no single one reaches every client this app has:
 *
 * - **Web Push** reaches browsers and installed Home Screen apps that subscribed,
 *   including while they are closed. It reaches nobody in a runtime with no push
 *   service — the native shell is a WKWebView, where `PushManager` does not exist
 *   and a subscription can never be made.
 * - **APNs** is that runtime's equivalent, and the only path to a phone whose app
 *   is not running: the iOS shell's live socket dies seconds after it is
 *   backgrounded. Silent unless a key is configured (`apns.ts`).
 * - **The live socket** carries the same payload to whatever is connected right
 *   now, and the client decides whether it is the one that must act (see the
 *   `appNotification` protocol message). A browser is subscribed and ignores it;
 *   a macOS shell has neither of the other two and raises it natively; an iOS
 *   shell ignores it once its APNs registration is live, and falls back to raising
 *   it locally until then.
 *
 * Which means exactly one runtime acts on any given alert, and the decision is
 * made by the client that knows what it is capable of — not here.
 */
export async function deliverAppNotification(
  notification: AppWebPushNotification,
): Promise<void> {
  try {
    notificationBroadcaster?.broadcastAll(notification);
  } catch (error) {
    console.warn(
      "[web-push] live notification broadcast failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
  await Promise.all([
    sendWebPushNotification(notification),
    sendApnsNotification(notification),
  ]);
}

export function sessionTurnNotification(
  sessionId: string,
  sessionTitle: string,
  stopReason: AgentStopReason,
): AppWebPushNotification {
  const title =
    stopReason === "error"
      ? "Turn failed"
      : stopReason === "aborted"
        ? "Turn stopped"
        : "Turn finished";
  return {
    title,
    body: boundedText(sessionTitle, "Session", MAX_BODY_CHARS),
    navigatePath: paObjectPath("session", sessionId),
  };
}

/**
 * The agent has STOPPED and cannot continue without the user: an approval it
 * proposed, or a question it asked.
 *
 * This is the half of the push policy that is not about a finished result
 * (`docs/messaging.md`): the work is blocked, so waiting for the user to next
 * open the app is exactly the cost we are trying to avoid. It is raised once,
 * when the block appears — the durable card and the inbox's `needs-you` tier
 * carry it from then on.
 */
function sessionBlockedNotification(
  sessionId: string,
  sessionTitle: string,
  blocked: "approval" | "question",
  detail?: string,
): AppWebPushNotification {
  return {
    title: blocked === "approval" ? "Approval needed" : "Question waiting",
    // The session is what the user has to pick between; what it is asking is
    // the second line's job where the caller knows it.
    body: boundedText(
      detail ? `${sessionTitle} — ${detail}` : sessionTitle,
      "Session",
      MAX_BODY_CHARS,
    ),
    navigatePath: paObjectPath("session", sessionId),
  };
}

/**
 * Best-effort adapter from a session becoming blocked on the user to a push.
 * Mirrors `notifySessionTurnCompleted`'s guards: an internal or deleted session
 * has no user to interrupt.
 */
export async function notifySessionBlocked(
  sessionId: string,
  blocked: "approval" | "question",
  detail?: string,
  dependencies: CompletionDependencies = {},
): Promise<void> {
  const session = (dependencies.getSession ?? sessionStore.get)(sessionId);
  if (!session || session.scope !== "user" || session.deletedAt !== undefined)
    return;
  if (!(dependencies.isDirectlyOwned ?? sessionIsDirectlyOwned)(sessionId))
    return;
  // The run this block ends is about to report completion for the same wait —
  // possibly before the delivery below resolves — so the mark goes down FIRST.
  blockedCompletions.add(sessionId);
  const send = dependencies.send ?? deliverAppNotification;
  try {
    await send(
      sessionBlockedNotification(sessionId, session.title, blocked, detail),
    );
  } catch (err) {
    // Nothing was delivered, so this mark would turn one alert into zero: the
    // completion it suppresses is the only remaining chance to reach the user.
    // Released rather than never taken, so the ordering above still holds.
    blockedCompletions.delete(sessionId);
    throw err;
  }
}

/**
 * A `/pr` pull request's CI concluded. `pullRequestWatcher.ts` sends this once
 * per PR + head SHA (a rebase-heavy branch gets a fresh notification only for
 * its NEW head), navigating back to the session that owns the live card.
 */
export function pullRequestCiConclusionNotification(
  card: import("@assistant/shared").PullRequestCard,
  ci: import("@assistant/shared").WorktreeCiStatus,
): AppWebPushNotification {
  const title = ci.state === "success" ? "CI passed" : "CI failed";
  return {
    title,
    body: boundedText(card.title, "Pull request", MAX_BODY_CHARS),
    navigatePath: paObjectPath("session", card.sessionId),
  };
}

export function workflowRunAttentionNotification(
  run: { taskId: number },
  card: import("@assistant/shared").PullRequestCard,
  observation: PullRequestObservationResult,
): AppWebPushNotification {
  const ready = observation.outcome === "ready";
  const detail = ready
    ? `CI passed and pull request #${card.number ?? "?"} is ready for a merge decision.`
    : observation.reason;
  return {
    title: ready ? "Workflow ready to merge" : "Workflow needs attention",
    body: boundedText(
      `Task #${run.taskId}: ${detail}`,
      "Workflow update",
      MAX_BODY_CHARS,
    ),
    navigatePath: paObjectPath("task", String(run.taskId)),
  };
}

export function permanentAssistantTurnNotification(
  assistantName: string,
  stopReason: AgentStopReason,
): AppWebPushNotification {
  const body =
    stopReason === "error"
      ? "I couldn't finish that response."
      : stopReason === "aborted"
        ? "My response was stopped."
        : "I've finished responding.";
  return {
    title: boundedText(assistantName, "Personal Assistant", MAX_TITLE_CHARS),
    body,
    navigatePath: PERMANENT_ASSISTANT_PATH,
  };
}

/**
 * Sessions whose NEXT run completion belongs to a block we have just announced.
 *
 * The approval and question tools terminate the run, so registering a block is
 * immediately followed by a completion for the same wait — and one wait may
 * produce only one alert. What this may NOT do is ask whether the session is
 * blocked RIGHT NOW: a blocked session still takes fresh turns (a queued peer
 * prompt drains on every running→idle transition), and suppressing on current
 * state would swallow those turns' legitimate results for as long as the
 * approval stayed open. So the mark is one-shot and identifies a specific
 * completion rather than inferring cause from durable state.
 *
 * The residual: a block that does NOT end its run leaves a mark that consumes
 * one later completion. That is bounded to one alert and only after a block,
 * where the alternative — matching on current state — loses every alert for an
 * unbounded time.
 */
const blockedCompletions = new Set<string>();

/** Test seam: the mark outlives any one call, so a suite has to clear it. */
export function clearBlockedCompletionMarks(): void {
  blockedCompletions.clear();
}

/** Best-effort adapter from a normalized user-visible session turn to Web Push. */
export async function notifySessionTurnCompleted(
  sessionId: string,
  stopReason: AgentStopReason,
  dependencies: CompletionDependencies = {},
): Promise<void> {
  const session = (dependencies.getSession ?? sessionStore.get)(sessionId);
  if (!session || session.scope !== "user" || session.deletedAt !== undefined)
    return;
  // The completion caused by a block we just announced, consumed exactly once:
  // one wait, one alert. Every later turn — including one admitted while the
  // approval is still open — is judged on its own trigger and obligations.
  if (blockedCompletions.delete(sessionId)) return;
  // Stopping your own turn is not news, matching the Sessions inbox.
  if (stopReason === "aborted") return;
  if (
    !(dependencies.runOutcomeNeedsUser ?? sessionRunOutcomeNeedsUser)(
      sessionId,
      stopReason,
      dependencies.origin,
    )
  )
    return;
  const send = dependencies.send ?? deliverAppNotification;
  if (session.agentType === PERSONAL_ASSISTANT_AGENT_TYPE) {
    const assistantName = (
      dependencies.getPermanentAssistantName ??
      (() => getSettings().permanentAssistant.name)
    )();
    await send(permanentAssistantTurnNotification(assistantName, stopReason));
    return;
  }
  await send(sessionTurnNotification(sessionId, session.title, stopReason));
}
