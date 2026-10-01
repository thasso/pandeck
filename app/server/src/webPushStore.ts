import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { WebPushSubscriptionInput } from "@assistant/shared";
import { DATA_DIR } from "./config.ts";

const STORE_VERSION = 1;
const WEB_PUSH_DIR = join(DATA_DIR, "web-push");
const VAPID_PATH = join(WEB_PUSH_DIR, "vapid.json");
const SUBSCRIPTIONS_PATH = join(WEB_PUSH_DIR, "subscriptions.json");
const MAX_ENDPOINT_CHARS = 4_096;
const MAX_KEY_CHARS = 512;
const MAX_ORIGIN_CHARS = 2_048;
const BASE64_URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

export interface StoredVapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface StoredWebPushSubscription extends WebPushSubscriptionInput {
  origin: string;
  createdAt: number;
  updatedAt: number;
}

interface StoredSubscriptionsFile {
  version: 1;
  subscriptions: StoredWebPushSubscription[];
}

function ensureStoreDir(): void {
  mkdirSync(WEB_PUSH_DIR, { recursive: true, mode: 0o700 });
  chmodSync(WEB_PUSH_DIR, 0o700);
}

function writePrivateJson(path: string, value: unknown): void {
  ensureStoreDir();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

function nonEmptyBounded(
  value: unknown,
  field: string,
  maxChars: number,
): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxChars)
    throw new Error(`${field} must be between 1 and ${maxChars} characters.`);
  return trimmed;
}

function normalizeEndpoint(value: unknown): string {
  const endpoint = nonEmptyBounded(
    value,
    "subscription.endpoint",
    MAX_ENDPOINT_CHARS,
  );
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("subscription.endpoint must be a valid URL.");
  }
  if (url.protocol !== "https:")
    throw new Error("subscription.endpoint must use HTTPS.");
  return url.toString();
}

function normalizeKey(value: unknown, field: string): string {
  const key = nonEmptyBounded(value, field, MAX_KEY_CHARS);
  if (!BASE64_URL_RE.test(key))
    throw new Error(`${field} must be base64url encoded.`);
  return key;
}

export function normalizeWebPushOrigin(value: unknown): string {
  const raw = nonEmptyBounded(value, "origin", MAX_ORIGIN_CHARS);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("origin must be a valid URL.");
  }
  const localHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp)
    throw new Error("origin must use HTTPS.");
  if (url.username || url.password)
    throw new Error("origin must not include credentials.");
  return url.origin;
}

export function normalizeWebPushSubscription(
  value: unknown,
): WebPushSubscriptionInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("subscription must be an object.");
  const input = value as { endpoint?: unknown; keys?: unknown };
  if (
    !input.keys ||
    typeof input.keys !== "object" ||
    Array.isArray(input.keys)
  )
    throw new Error("subscription.keys must be an object.");
  const keys = input.keys as { p256dh?: unknown; auth?: unknown };
  return {
    endpoint: normalizeEndpoint(input.endpoint),
    keys: {
      p256dh: normalizeKey(keys.p256dh, "subscription.keys.p256dh"),
      auth: normalizeKey(keys.auth, "subscription.keys.auth"),
    },
  };
}

function normalizeVapidKeys(value: unknown): StoredVapidKeys {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Stored VAPID keys are malformed.");
  const keys = value as { publicKey?: unknown; privateKey?: unknown };
  return {
    publicKey: normalizeKey(keys.publicKey, "publicKey"),
    privateKey: normalizeKey(keys.privateKey, "privateKey"),
  };
}

export function getOrCreateVapidKeys(
  generate: () => StoredVapidKeys,
): StoredVapidKeys {
  if (existsSync(VAPID_PATH))
    return normalizeVapidKeys(
      JSON.parse(readFileSync(VAPID_PATH, "utf8")) as unknown,
    );
  const keys = normalizeVapidKeys(generate());
  writePrivateJson(VAPID_PATH, keys);
  return keys;
}

function normalizeStoredSubscription(
  value: unknown,
): StoredWebPushSubscription {
  const subscription = normalizeWebPushSubscription(value);
  const record = value as {
    origin?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
  };
  const createdAt = Number(record.createdAt);
  const updatedAt = Number(record.updatedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt))
    throw new Error("Stored Web Push subscription timestamps are malformed.");
  return {
    ...subscription,
    origin: normalizeWebPushOrigin(record.origin),
    createdAt,
    updatedAt,
  };
}

function readSubscriptionsFile(): StoredSubscriptionsFile {
  if (!existsSync(SUBSCRIPTIONS_PATH))
    return { version: STORE_VERSION, subscriptions: [] };
  const parsed = JSON.parse(readFileSync(SUBSCRIPTIONS_PATH, "utf8")) as {
    version?: unknown;
    subscriptions?: unknown;
  };
  if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.subscriptions))
    throw new Error("Stored Web Push subscriptions are malformed.");
  return {
    version: STORE_VERSION,
    subscriptions: parsed.subscriptions.map(normalizeStoredSubscription),
  };
}

function writeSubscriptions(subscriptions: StoredWebPushSubscription[]): void {
  writePrivateJson(SUBSCRIPTIONS_PATH, {
    version: STORE_VERSION,
    subscriptions,
  } satisfies StoredSubscriptionsFile);
}

export function listWebPushSubscriptions(): StoredWebPushSubscription[] {
  return readSubscriptionsFile().subscriptions;
}

export function upsertWebPushSubscription(
  subscriptionValue: unknown,
  originValue: unknown,
  now = Date.now(),
): StoredWebPushSubscription {
  const subscription = normalizeWebPushSubscription(subscriptionValue);
  const origin = normalizeWebPushOrigin(originValue);
  const subscriptions = listWebPushSubscriptions();
  const existing = subscriptions.find(
    (item) => item.endpoint === subscription.endpoint,
  );
  const record: StoredWebPushSubscription = {
    ...subscription,
    origin,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writeSubscriptions([
    ...subscriptions.filter((item) => item.endpoint !== subscription.endpoint),
    record,
  ]);
  return record;
}

export function removeWebPushSubscription(endpointValue: unknown): boolean {
  const endpoint = normalizeEndpoint(endpointValue);
  const subscriptions = listWebPushSubscriptions();
  const next = subscriptions.filter((item) => item.endpoint !== endpoint);
  if (next.length === subscriptions.length) return false;
  writeSubscriptions(next);
  return true;
}
