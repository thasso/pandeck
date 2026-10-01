/**
 * The APNs credential and the device tokens it may push to.
 *
 * Deliberately shaped like `webPushStore.ts`, because it answers the same
 * question for a different transport: which installations asked to be told, and
 * what does this server need to tell them. The differences are the ones Apple
 * imposes — a signing key we cannot generate for ourselves (unlike VAPID), and a
 * token that is only valid against ONE of Apple's two hosts.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ApnsEnvironment } from "@assistant/shared";
import { APNS_CREDENTIAL_PATH, DATA_DIR } from "./config.ts";

const STORE_VERSION = 1;
const APNS_DIR = join(DATA_DIR, "apns");
/**
 * The credential is READ-ONLY here and may live outside `DATA_DIR` (a secret
 * manager's own directory); the device list is ours to write and always sits
 * under `DATA_DIR` with the rest of the runtime state.
 */
const CREDENTIAL_PATH = APNS_CREDENTIAL_PATH;
const DEVICES_PATH = join(APNS_DIR, "devices.json");
/** A device token is 32 bytes of hex today; Apple reserves the right to grow it. */
const TOKEN_RE = /^[0-9a-f]{64,200}$/;
const KEY_ID_RE = /^[A-Z0-9]{10}$/;
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{1,155}$/;
const MAX_LABEL_CHARS = 120;

/**
 * What is needed to sign an APNs request. There is no self-service path to this:
 * the `.p8` is downloaded once from the Apple developer portal and cannot be
 * re-downloaded, so the server stores it and never asks for it again.
 */
export interface ApnsCredential {
  /** Key ID of the `.p8` auth key (10 chars, from the portal). */
  keyId: string;
  /** The Apple developer team that owns the key. */
  teamId: string;
  /** The app's bundle identifier — APNs calls it the topic. */
  bundleId: string;
  /** PEM contents of the `.p8` ES256 private key. */
  privateKey: string;
  /**
   * Which of the portal's two key scopes this `.p8` was created with.
   *
   * `team` is "Team Scoped (All Topics)" and signs the plain provider token every
   * APNs example shows. `topic` is "Topic Specific", bound to one bundle ID, and
   * additionally needs that topic named in the token's `sub` claim — so the scope
   * has to be recorded here rather than inferred, because a key signed the wrong
   * way is rejected as `InvalidProviderToken` and nothing more specific.
   */
  keyScope: ApnsKeyScope;
}

type ApnsKeyScope = "team" | "topic";

export interface StoredApnsDevice {
  /** Lowercase hex device token, as Apple issued it to this installation. */
  token: string;
  /** Which of Apple's hosts this token is valid against. */
  environment: ApnsEnvironment;
  /**
   * The installation this token belongs to, when the client reported one. Absent
   * on rows written before installations were identified, which is why the token
   * is still the fallback key.
   */
  installId?: string;
  /** Free text for the settings page, e.g. the device model. */
  label?: string;
  createdAt: number;
  updatedAt: number;
}

interface StoredDevicesFile {
  version: 1;
  devices: StoredApnsDevice[];
}

function ensureStoreDir(): void {
  mkdirSync(APNS_DIR, { recursive: true, mode: 0o700 });
  chmodSync(APNS_DIR, 0o700);
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

function matching(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  if (!pattern.test(trimmed)) throw new Error(`${field} is malformed.`);
  return trimmed;
}

export function normalizeApnsEnvironment(value: unknown): ApnsEnvironment {
  if (value === "development" || value === "production") return value;
  throw new Error("environment must be 'development' or 'production'.");
}

export function normalizeApnsToken(value: unknown): string {
  if (typeof value !== "string") throw new Error("token must be a string.");
  return matching(value.trim().toLowerCase(), TOKEN_RE, "token");
}

function normalizeApnsKeyScope(value: unknown): ApnsKeyScope {
  // Absent means the plain provider token, which is what an existing key and
  // every APNs example use — so a credential written before topic-specific keys
  // existed keeps working untouched.
  if (value === undefined || value === null || value === "") return "team";
  if (value === "team" || value === "topic") return value;
  throw new Error("keyScope must be 'team' or 'topic'.");
}

function normalizeCredential(value: unknown): ApnsCredential {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The stored APNs credential is malformed.");
  const record = value as Record<string, unknown>;
  const privateKey =
    typeof record.privateKey === "string" ? record.privateKey.trim() : "";
  if (!privateKey.includes("BEGIN PRIVATE KEY"))
    throw new Error("privateKey must be the PEM contents of the .p8 auth key.");
  return {
    keyId: matching(record.keyId, KEY_ID_RE, "keyId"),
    teamId: matching(record.teamId, TEAM_ID_RE, "teamId"),
    bundleId: matching(record.bundleId, BUNDLE_ID_RE, "bundleId"),
    privateKey,
    keyScope: normalizeApnsKeyScope(record.keyScope),
  };
}

/**
 * The stored credential, or null when push is simply not set up.
 *
 * A malformed file is null too rather than a throw: a notification is
 * best-effort, and a server that refused to start — or to answer the settings
 * page — because a push key was mistyped would be worse than one that reports
 * push as unconfigured.
 */
export function getApnsCredential(): ApnsCredential | null {
  if (!existsSync(CREDENTIAL_PATH)) return null;
  try {
    return normalizeCredential(
      JSON.parse(readFileSync(CREDENTIAL_PATH, "utf8")) as unknown,
    );
  } catch (error) {
    console.warn(
      "[apns] ignoring the stored credential:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

function normalizeStoredDevice(value: unknown): StoredApnsDevice {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("A stored APNs device is malformed.");
  const record = value as Record<string, unknown>;
  const createdAt = Number(record.createdAt);
  const updatedAt = Number(record.updatedAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt))
    throw new Error("Stored APNs device timestamps are malformed.");
  const label =
    typeof record.label === "string" && record.label.trim()
      ? record.label.trim().slice(0, MAX_LABEL_CHARS)
      : undefined;
  const installId =
    typeof record.installId === "string" && record.installId.trim()
      ? record.installId.trim().slice(0, MAX_LABEL_CHARS)
      : undefined;
  return {
    token: normalizeApnsToken(record.token),
    environment: normalizeApnsEnvironment(record.environment),
    ...(installId ? { installId } : {}),
    ...(label ? { label } : {}),
    createdAt,
    updatedAt,
  };
}

function readDevicesFile(): StoredDevicesFile {
  if (!existsSync(DEVICES_PATH)) return { version: STORE_VERSION, devices: [] };
  const parsed = JSON.parse(readFileSync(DEVICES_PATH, "utf8")) as {
    version?: unknown;
    devices?: unknown;
  };
  if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.devices))
    throw new Error("Stored APNs devices are malformed.");
  return {
    version: STORE_VERSION,
    devices: parsed.devices.map(normalizeStoredDevice),
  };
}

function writeDevices(devices: StoredApnsDevice[]): void {
  writePrivateJson(DEVICES_PATH, {
    version: STORE_VERSION,
    devices,
  } satisfies StoredDevicesFile);
}

export function listApnsDevices(): StoredApnsDevice[] {
  try {
    return readDevicesFile().devices;
  } catch (error) {
    console.warn(
      "[apns] ignoring the stored device list:",
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

/**
 * Remember one installation's device token, replacing whatever that installation
 * was registered with before.
 *
 * Keyed on the INSTALLATION rather than the token, because a device token is not
 * an identity: Apple mints a fresh one on reinstall or restore and keeps
 * delivering to the old one for a while afterwards. Keyed on the token, every
 * reinstall left a second live row and the phone buzzed twice per alert —
 * observed, not theoretical. The 410/`BadDeviceToken` retirement in `apns.ts` does
 * eventually collect those, but on Apple's schedule rather than ours.
 *
 * Falls back to the token when the client reports no installation, which is what
 * keeps rows written by an older client addressable.
 */
export function upsertApnsDevice(
  input: {
    token: unknown;
    environment: unknown;
    installId?: unknown;
    label?: unknown;
  },
  now = Date.now(),
): StoredApnsDevice {
  const token = normalizeApnsToken(input.token);
  const environment = normalizeApnsEnvironment(input.environment);
  const installId =
    typeof input.installId === "string" && input.installId.trim()
      ? input.installId.trim().slice(0, MAX_LABEL_CHARS)
      : undefined;
  const label =
    typeof input.label === "string" && input.label.trim()
      ? input.label.trim().slice(0, MAX_LABEL_CHARS)
      : undefined;
  const devices = listApnsDevices();
  const supersedes = (device: StoredApnsDevice): boolean =>
    installId !== undefined && device.installId !== undefined
      ? device.installId === installId
      : device.token === token;
  const existing = devices.find(supersedes);
  const record: StoredApnsDevice = {
    token,
    environment,
    ...(installId ? { installId } : {}),
    ...(label ? { label } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writeDevices([...devices.filter((device) => !supersedes(device)), record]);
  return record;
}

export function removeApnsDevice(tokenValue: unknown): boolean {
  const token = normalizeApnsToken(tokenValue);
  const devices = listApnsDevices();
  const next = devices.filter((device) => device.token !== token);
  if (next.length === devices.length) return false;
  writeDevices(next);
  return true;
}
