/**
 * Registering this iOS installation for Apple push, and deciding which runtime
 * raises an alert once it is.
 *
 * The iOS shell is the one client that can have no Web Push subscription — a
 * WKWebView has no `PushManager` at all — so `apnsPush` is its equivalent: the
 * shell holds the device token Apple issued, this hands it to the server, and the
 * server pushes to it (`app/server/src/apns.ts`). It is the only path that reaches
 * the phone while the app is not running, which is the state a notification is
 * for.
 *
 * The reason a MODULE flag lives here rather than the answer being recomputed:
 * once registration succeeds, the server will deliver the same alert twice — once
 * as a push and once over the live socket — so exactly one of them may be acted
 * on. `apnsDeliveryActive` is what `nativeShell.notificationsNeedNativeShell`'s
 * caller consults to stop raising the socket copy locally, and it can only be
 * known after the server has answered.
 */
import type {
  ApnsConfigResponse,
  ApnsDeliveryReport,
  ApnsDeviceInput,
} from "@assistant/shared";
import { createClientId } from "./clientId.ts";
import { notificationsNeedNativeShell } from "./nativeShell.ts";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

const INSTALL_ID_KEY = "assistant.apnsInstallId";

/**
 * True once the server has accepted a device token for this installation, i.e.
 * Apple will deliver these alerts and the socket copy must be left alone.
 */
let apnsActive = false;

export function apnsDeliveryActive(): boolean {
  return apnsActive;
}

/** Test seam, and the reset a failed re-registration needs. */
export function setApnsDeliveryActive(active: boolean): void {
  apnsActive = active;
}

/**
 * Whether THIS runtime is the one that has to raise an alert arriving over the
 * live socket (`appNotification`).
 *
 * The server sends that message to every connected client and lets each decide,
 * because only the client knows what it is capable of. A browser is subscribed to
 * Web Push and would notify twice. The macOS shell has neither push route and is
 * always the one. An iOS shell is the one only until its APNs registration takes —
 * after which Apple delivers the same alert, and this one must go quiet or every
 * finished turn buzzes twice.
 */
export function shouldRaiseAppNotification(): boolean {
  return notificationsNeedNativeShell() && !apnsActive;
}

/**
 * A stable id for THIS installation, minted once and kept in local storage.
 *
 * The device token cannot play this role: Apple mints a new one on reinstall or
 * restore while the old one keeps working, so the server needs something else to
 * recognise "same phone, new token" — otherwise every reinstall leaves a second
 * live registration and one alert arrives twice.
 *
 * Storage that is unavailable (hardened/private modes) yields a per-session id
 * instead of throwing: the caller only loses the deduplication it enables.
 */
export function apnsInstallId(): string {
  try {
    const existing = window.localStorage.getItem(INSTALL_ID_KEY);
    if (existing) return existing;
    const created = createClientId();
    window.localStorage.setItem(INSTALL_ID_KEY, created);
    return created;
  } catch {
    return createClientId();
  }
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

export async function fetchApnsConfig(): Promise<ApnsConfigResponse> {
  const response = await fetch(`${serverHttpOrigin()}/api/apns/config`, {
    headers: authHeaders(),
  });
  return jsonResponse<ApnsConfigResponse>(response);
}

/**
 * Hand this installation's token to the server.
 *
 * Called on every launch, not once: Apple reissues a device token when the app is
 * reinstalled or a backup is restored, so the server's copy is only as good as the
 * last one it was given. Re-registering an unchanged token is a no-op there.
 */
export async function registerApnsDevice(
  device: ApnsDeviceInput,
): Promise<void> {
  const response = await fetch(`${serverHttpOrigin()}/api/apns/device`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(device),
  });
  await jsonResponse<{ ok: true }>(response);
  apnsActive = true;
}

/**
 * Ask the server to push a real test alert to every registered installation.
 *
 * The only way to see an APNs rejection: Apple answers the SERVER, so a token
 * that has gone stale or a key for the wrong environment shows up here as a
 * reason string and on the device as nothing at all.
 */
export async function sendApnsTest(): Promise<ApnsDeliveryReport> {
  const response = await fetch(`${serverHttpOrigin()}/api/apns/test`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
  });
  return jsonResponse<ApnsDeliveryReport>(response);
}
