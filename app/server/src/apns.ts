/**
 * Delivering an alert to the iOS app through Apple Push Notification service.
 *
 * The third delivery route, alongside Web Push and the live socket
 * (`webPush.ts` owns the choice between them). It exists because the iOS shell is
 * a WKWebView: it implements neither `Notification` nor `PushManager`, so the
 * Declarative Web Push subscription a browser makes cannot be created there at
 * all, and the live socket dies within seconds of the app being backgrounded.
 * APNs is the only channel that reaches a phone whose app is not running — which
 * is the only state a notification is actually FOR.
 *
 * Written against `node:http2` and `node:crypto` rather than an APNs library
 * because the whole protocol is one POST and one ES256 JWT, and a dependency here
 * would be more code to audit than the thing it wraps.
 */
import { createSign } from "node:crypto";
import { connect, constants, type ClientHttp2Session } from "node:http2";
import type { ApnsDeliveryReport, ApnsEnvironment } from "@assistant/shared";
import {
  getApnsCredential,
  listApnsDevices,
  removeApnsDevice,
  type ApnsCredential,
  type StoredApnsDevice,
} from "./apnsStore.ts";

/** Where a tap should go. The key the iOS shell reads out of `userInfo`. */
const TARGET_KEY = "paTarget";

const HOSTS: Record<ApnsEnvironment, string> = {
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/**
 * How long a provider token is reused. Apple rejects one older than an hour and
 * throttles a provider that mints a fresh one per request, so the window sits
 * comfortably inside both.
 */
const TOKEN_TTL_MS = 45 * 60_000;

/** Give up on a single push rather than holding a turn's completion open. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Bounded so a long session title cannot push a body past what iOS will show. */
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 240;

export interface ApnsAlert {
  title: string;
  body: string;
  /** App-relative path a tap should open, e.g. `/session/42`. */
  navigatePath: string;
}

/** The JSON APNs delivers, and the iOS shell reads back on a tap. */
export function apnsPayload(alert: ApnsAlert): Record<string, unknown> {
  return {
    aps: {
      alert: {
        title: alert.title.slice(0, MAX_TITLE_CHARS),
        body: alert.body.slice(0, MAX_BODY_CHARS),
      },
      sound: "default",
      // Collapses in Notification Center as one conversation rather than a stack
      // of unrelated banners, and matches what the local fallback groups under.
      "thread-id": "assistant",
    },
    // NOT inside `aps`: everything outside it is the app's, and `userInfo` on the
    // device is this whole object — so the shell finds the target at the same key
    // whether the notification came from Apple or was raised locally. Keep in step
    // with `app/shell/src/ios.rs`'s `TARGET_KEY`.
    [TARGET_KEY]: alert.navigatePath,
  };
}

/**
 * A signed provider token, cached until it nears Apple's one-hour limit.
 *
 * The signature is over a bare JWT with `alg: ES256` and the key id in the
 * header; `iss` is the team and `iat` the issue time. Apple's ES256 wants the raw
 * 64-byte r||s pair, which is what `dsaEncoding: "ieee-p1363"` produces —
 * OpenSSL's default DER encoding is silently rejected as an invalid token.
 *
 * A key created in the portal as "Topic Specific" is bound to one bundle ID and
 * additionally names that topic in `sub`; a "Team Scoped (All Topics)" key must
 * not. Which one this is comes from the credential rather than being guessed,
 * because both mistakes land as `InvalidProviderToken` with no further detail.
 */
let cachedToken: { value: string; issuedAt: number; keyId: string } | null =
  null;

export function providerToken(
  credential: ApnsCredential,
  now = Date.now(),
): string {
  if (
    cachedToken &&
    cachedToken.keyId === credential.keyId &&
    now - cachedToken.issuedAt < TOKEN_TTL_MS
  )
    return cachedToken.value;

  const header = base64Url(
    JSON.stringify({ alg: "ES256", kid: credential.keyId }),
  );
  const claims = base64Url(
    JSON.stringify({
      iss: credential.teamId,
      iat: Math.floor(now / 1000),
      ...(credential.keyScope === "topic" ? { sub: credential.bundleId } : {}),
    }),
  );
  const signing = `${header}.${claims}`;
  const signature = createSign("SHA256")
    .update(signing)
    .sign({ key: credential.privateKey, dsaEncoding: "ieee-p1363" });
  const value = `${signing}.${signature.toString("base64url")}`;
  cachedToken = { value, issuedAt: now, keyId: credential.keyId };
  return value;
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export interface ApnsResponse {
  status: number;
  /** Apple's `reason` string, when it sent an error body. */
  reason?: string;
}

/**
 * One POST to Apple for one device token.
 *
 * A fresh HTTP/2 session per push rather than a pooled one. Apple prefers a
 * long-lived connection and this server sends a handful of notifications a day,
 * so the trade is a few hundred milliseconds against a connection that has to be
 * kept healthy across the server's sleep/wake and Apple's idle GOAWAY — code that
 * would only ever be exercised by the failure it is there to handle.
 */
async function postToApns(
  credential: ApnsCredential,
  device: StoredApnsDevice,
  payload: Record<string, unknown>,
): Promise<ApnsResponse> {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return new Promise<ApnsResponse>((resolve, reject) => {
    let session: ClientHttp2Session;
    try {
      session = connect(HOSTS[device.environment]);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let settled = false;
    const finish = (outcome: ApnsResponse | Error) => {
      if (settled) return;
      settled = true;
      session.close();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    session.on("error", finish);
    session.setTimeout(REQUEST_TIMEOUT_MS, () =>
      finish(new Error("APNs did not answer in time.")),
    );

    const request = session.request({
      [constants.HTTP2_HEADER_METHOD]: "POST",
      [constants.HTTP2_HEADER_PATH]: `/3/device/${device.token}`,
      authorization: `bearer ${providerToken(credential)}`,
      "apns-topic": credential.bundleId,
      // `alert` means "show this to the user", which is the only kind of push
      // this app sends: a background/silent push would need a
      // `remote-notification` background mode and buys nothing, since the shell
      // has no work to do before the banner appears.
      "apns-push-type": "alert",
      "apns-priority": "10",
      // An alert about a turn that finished an hour ago is noise, so Apple is told
      // to drop it rather than store and forward it.
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
      [constants.HTTP2_HEADER_CONTENT_TYPE]: "application/json",
      [constants.HTTP2_HEADER_CONTENT_LENGTH]: body.byteLength,
    });
    let status = 0;
    const chunks: Buffer[] = [];
    request.on("response", (headers) => {
      status = Number(headers[constants.HTTP2_HEADER_STATUS]) || 0;
    });
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", finish);
    request.on("end", () => {
      let reason: string | undefined;
      if (chunks.length > 0) {
        try {
          reason = (
            JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              reason?: string;
            }
          ).reason;
        } catch {
          // Apple always sends JSON on an error; a body we cannot read is not
          // worth failing the send over.
        }
      }
      finish({ status, ...(reason ? { reason } : {}) });
    });
    request.end(body);
  });
}

/**
 * A device token that is well-formed and belongs to nobody. See
 * [`probeApnsCredential`].
 */
const NOWHERE_DEVICE_TOKEN = "0".repeat(64);

export interface ApnsCredentialProbe {
  /** Whether Apple ACCEPTED the provider token, whatever it thought of the device. */
  authenticated: boolean;
  status: number;
  reason?: string;
  /** What to do about it, in one line. */
  verdict: string;
}

/**
 * Ask Apple whether it accepts our provider token, without needing a device.
 *
 * The one thing that cannot be checked locally: whether `keyScope` matches how the
 * `.p8` was created in the portal, since neither choice is readable off the key
 * and both mistakes come back as `InvalidProviderToken`. The trick is to push to a
 * well-formed token that belongs to no device — Apple authenticates FIRST, so
 * `BadDeviceToken` is the success case here. It proves the key, team, topic and
 * scope all line up while sending a notification to nobody.
 */
export async function probeApnsCredential(
  credential: ApnsCredential,
  environment: ApnsEnvironment = "development",
  post = postToApns,
): Promise<ApnsCredentialProbe> {
  const device: StoredApnsDevice = {
    token: NOWHERE_DEVICE_TOKEN,
    environment,
    createdAt: 0,
    updatedAt: 0,
  };
  const response = await post(
    credential,
    device,
    apnsPayload({ title: "Probe", body: "Probe", navigatePath: "/" }),
  );
  return { ...response, ...interpretProbe(credential, response) };
}

function interpretProbe(
  credential: ApnsCredential,
  response: ApnsResponse,
): { authenticated: boolean; verdict: string } {
  const other = credential.keyScope === "topic" ? "team" : "topic";
  switch (response.reason) {
    case "BadDeviceToken":
      return {
        authenticated: true,
        verdict:
          "The credential is good: Apple authenticated it and only rejected the throwaway device token.",
      };
    case "InvalidProviderToken":
      return {
        authenticated: false,
        verdict: `Apple refused the token. Most likely keyScope is wrong — try "${other}" — or keyId/teamId do not match this .p8.`,
      };
    case "ExpiredProviderToken":
      return {
        authenticated: false,
        verdict:
          "The token was already expired on arrival; check this machine's clock.",
      };
    case "TopicDisallowed":
    case "DeviceTokenNotForTopic":
      return {
        authenticated: false,
        verdict: `Apple will not serve topic ${credential.bundleId} with this key. Check bundleId, and that the key covers this app.`,
      };
    case "MissingTopic":
      return {
        authenticated: false,
        verdict: "The request carried no topic; bundleId is empty.",
      };
    case "BadEnvironmentKeyInToken":
      // The portal can also restrict a key to ONE of Apple's two environments, so
      // this is the expected answer from the host the key is not for. Only a
      // fault if it comes from the host the app's device tokens actually use.
      return {
        authenticated: false,
        verdict:
          "This key is restricted to the other environment — expected, unless the app's device tokens live here.",
      };
    default:
      return {
        authenticated: response.status === 200,
        verdict:
          response.status === 200
            ? "Apple accepted a push to a device token that should not exist, which should not happen — treat this as inconclusive."
            : "Unrecognised answer from Apple; the status and reason above are what it said.",
      };
  }
}

/** Reasons that mean this token will never work again, whatever we send. */
const RETIRED_REASONS = new Set([
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
]);

interface SendDependencies {
  credential?: ApnsCredential | null;
  devices?: StoredApnsDevice[];
  post?: typeof postToApns;
  removeDevice?: (token: string) => boolean;
}

/**
 * Send one alert to every registered iOS installation.
 *
 * Best effort for its real caller: a push that cannot be delivered is logged and
 * the report is discarded, never surfaced as a failure of the work it was
 * announcing. The report exists for the one caller that IS asking about
 * delivery — the settings page's test — because APNs failures are otherwise
 * completely silent from the device's side.
 *
 * The one side effect is retiring a token Apple has told us is dead, which is what
 * keeps a reinstalled app from being pushed to forever.
 */
export async function sendApnsNotification(
  alert: ApnsAlert,
  dependencies: SendDependencies = {},
): Promise<ApnsDeliveryReport> {
  const credential = dependencies.credential ?? getApnsCredential();
  if (!credential)
    return { delivered: 0, failures: ["No Apple push key is configured."] };
  const devices = dependencies.devices ?? listApnsDevices();
  if (devices.length === 0)
    return { delivered: 0, failures: ["No iOS installation is registered."] };
  const post = dependencies.post ?? postToApns;
  const removeDevice = dependencies.removeDevice ?? removeApnsDevice;
  const payload = apnsPayload(alert);

  const outcomes = await Promise.all(
    devices.map(async (device): Promise<string | null> => {
      try {
        const response = await post(credential, device, payload);
        if (response.status === 200) return null;
        const detail = `${response.status}${response.reason ? ` ${response.reason}` : ""}`;
        // The one rejection worth explaining: Apple says nothing about WHY a
        // provider token is invalid, and the likeliest cause here is the key's
        // portal scope disagreeing with `keyScope` — the only part of the
        // credential that cannot be read off the key itself.
        if (response.reason === "InvalidProviderToken")
          return `Apple rejected the provider token (${detail}). Check that keyScope is "${credential.keyScope === "topic" ? "team" : "topic"}" if the key was created as ${credential.keyScope === "topic" ? "Team Scoped (All Topics)" : "Topic Specific"} in the portal, and that keyId/teamId match the .p8.`;
        if (
          response.status === 410 ||
          (response.reason && RETIRED_REASONS.has(response.reason))
        ) {
          console.warn(`[apns] retiring a dead device token (${detail}).`);
          removeDevice(device.token);
          return `A stale device token was retired (${detail}).`;
        }
        console.warn(`[apns] delivery failed (${detail}).`);
        return `Apple rejected the push (${detail}).`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[apns] delivery failed:", message);
        return message;
      }
    }),
  );
  const failures = outcomes.filter(
    (outcome): outcome is string => outcome !== null,
  );
  return { delivered: outcomes.length - failures.length, failures };
}
