import type {
  WebPushConfigResponse,
  WebPushSubscriptionInput,
} from "@assistant/shared";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

interface DeclarativePushWindow extends Window {
  pushManager?: PushManager;
}

export type WebPushBrowserSupport =
  | { supported: true; pushManager: PushManager }
  | { supported: false; reason: string };

export function webPushBrowserSupport(): WebPushBrowserSupport {
  if (!window.isSecureContext)
    return {
      supported: false,
      reason: "Notifications require a secure HTTPS connection.",
    };
  if (!("Notification" in window))
    return {
      supported: false,
      reason: "This browser does not support notifications.",
    };
  const pushManager = (window as DeclarativePushWindow).pushManager;
  if (!pushManager) {
    return {
      supported: false,
      reason:
        "Declarative Web Push is unavailable here. On iPhone, update iOS and open the app from its Home Screen icon.",
    };
  }
  return { supported: true, pushManager };
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) {
    const message =
      typeof body.error === "string" && body.error.trim()
        ? body.error
        : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return body as T;
}

export async function fetchWebPushConfig(): Promise<WebPushConfigResponse> {
  const response = await fetch(`${serverHttpOrigin()}/api/web-push/config`, {
    headers: authHeaders(),
  });
  return jsonResponse<WebPushConfigResponse>(response);
}

export function applicationServerKeyBytes(
  value: string,
): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const raw = window.atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1)
    bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export function serializeWebPushSubscription(
  subscription: PushSubscription,
): WebPushSubscriptionInput {
  const json = subscription.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth)
    throw new Error("The browser returned an incomplete push subscription.");
  return { endpoint, keys: { p256dh, auth } };
}

export async function registerWebPushSubscription(
  subscription: PushSubscription,
): Promise<void> {
  const response = await fetch(
    `${serverHttpOrigin()}/api/web-push/subscription`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(serializeWebPushSubscription(subscription)),
    },
  );
  await jsonResponse<{ ok: true }>(response);
}

export async function enableWebPush(
  pushManager: PushManager,
  applicationServerKey: string,
): Promise<PushSubscription> {
  let permission = Notification.permission;
  if (permission === "default")
    permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error("Notification permission was not granted.");

  const existing = await pushManager.getSubscription();
  const subscription =
    existing ??
    (await pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKeyBytes(applicationServerKey),
    }));
  try {
    await registerWebPushSubscription(subscription);
    return subscription;
  } catch (error) {
    if (!existing) await subscription.unsubscribe().catch(() => false);
    throw error;
  }
}

export async function disableWebPush(
  subscription: PushSubscription,
): Promise<void> {
  // The local unsubscribe happens whether or not the server accepted the
  // delete, and a server failure still surfaces — `finally` says both.
  try {
    const response = await fetch(
      `${serverHttpOrigin()}/api/web-push/subscription`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      },
    );
    await jsonResponse<{ ok: true }>(response);
  } finally {
    await subscription.unsubscribe();
  }
}
