import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DATA_DIR } from "./config.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { childProcessEnv } from "./subprocessEnv.ts";

/**
 * PA-owned account-profile registry. The JSON registry is deliberately limited
 * to non-secret labels and paths derived from the profile id; provider tokens
 * stay in pi's auth.json or Claude's own config directory.
 */
export type CredentialProfileProvider = "openai-codex" | "claude";
export type CredentialProfileStatus =
  "disconnected" | "connecting" | "ready" | "error";

export interface CredentialProfile {
  id: string;
  name: string;
  provider: CredentialProfileProvider;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialProfileSummary extends CredentialProfile {
  status: CredentialProfileStatus;
  /** Safe, user-actionable setup guidance. Never contains a token. */
  setup?: {
    path: string;
    command: string;
    detail: string;
    verificationUri?: string;
    userCode?: string;
  };
  error?: string;
}

const DEFAULT_OPENAI_PROFILE_ID = "default";
export const DEFAULT_CLAUDE_PROFILE_ID = "claude-default";
const ROOT = join(DATA_DIR, "credential-profiles");
const REGISTRY = join(ROOT, "profiles.json");
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
interface TransientCredentialProfileState {
  status: CredentialProfileStatus;
  error?: string;
  verificationUri?: string;
  userCode?: string;
  /** Non-secret file revision used to notice OAuth persistence before pi's post-login refresh settles. */
  credentialRevisionAtStart?: string;
}
const transient = new Map<string, TransientCredentialProfileState>();
let credentialProfileDeletedHandler: ((id: string) => void) | undefined;
const credentialProfileDeletedListeners = new Set<(id: string) => void>();

/** Register cache cleanup owned by a provider runtime module. */
export function setCredentialProfileDeletedHandler(
  handler: ((id: string) => void) | undefined,
): void {
  credentialProfileDeletedHandler = handler;
}

const credentialProfileChangeListeners = new Set<(id: string) => void>();

/**
 * Hear about every change to an account: created, renamed, enabled or
 * disabled, deleted, or its login state moved (a login that finished clears
 * it). Settings-input sign-in cards resolve from this ([Task-729](pa://task/729)).
 */
export function subscribeCredentialProfileChanges(
  listener: (id: string) => void,
): () => void {
  credentialProfileChangeListeners.add(listener);
  return () => credentialProfileChangeListeners.delete(listener);
}

function credentialProfileChanged(id: string): void {
  for (const listener of credentialProfileChangeListeners) {
    try {
      listener(id);
    } catch (err) {
      console.warn("[credential-profiles] change listener failed:", err);
    }
  }
}

/** Subscribe another lifecycle owner that must cancel profile-scoped work before private files are removed. */
export function subscribeCredentialProfileDeleted(
  listener: (id: string) => void,
): () => void {
  credentialProfileDeletedListeners.add(listener);
  return () => credentialProfileDeletedListeners.delete(listener);
}

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function privateFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* the file may not exist yet */
  }
}

function privateTree(path: string): void {
  privateDir(path);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) privateTree(child);
    else privateFile(child);
  }
}

function readRegistry(): CredentialProfile[] {
  if (!existsSync(REGISTRY)) return [];
  try {
    const raw = JSON.parse(readFileSync(REGISTRY, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item): CredentialProfile[] => {
      if (!item || typeof item !== "object") return [];
      const p = item as Partial<CredentialProfile>;
      const createdAt = p.createdAt;
      const updatedAt = p.updatedAt;
      if (
        !p.id ||
        !SAFE_ID.test(p.id) ||
        !p.name ||
        (p.provider !== "openai-codex" && p.provider !== "claude") ||
        !Number.isFinite(createdAt) ||
        !Number.isFinite(updatedAt)
      )
        return [];
      return [
        {
          id: p.id,
          name: p.name.slice(0, 80),
          provider: p.provider,
          enabled: p.enabled !== false,
          createdAt: createdAt as number,
          updatedAt: updatedAt as number,
        },
      ];
    });
  } catch {
    return [];
  }
}

function writeRegistry(profiles: CredentialProfile[]): void {
  privateDir(ROOT);
  const tmp = `${REGISTRY}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(profiles, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  privateFile(tmp);
  renameSync(tmp, REGISTRY);
  privateFile(REGISTRY);
}

function profileRoot(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error("Invalid credential profile id.");
  const path = resolve(ROOT, id);
  if (!path.startsWith(`${resolve(ROOT)}${"/"}`))
    throw new Error("Invalid credential profile path.");
  return path;
}

/** The whole pi agent directory is PA-owned, including models/auth/settings. */
export function piAgentDir(profileId = "default"): string {
  const dir = join(profileRoot(profileId), "pi-agent");
  privateDir(dir);
  return dir;
}

/** Claude CLI state: the protected default follows the user's normal ~/.claude login; named profiles stay PA-isolated. */
export function claudeConfigDir(profileId: string): string {
  if (profileId === DEFAULT_CLAUDE_PROFILE_ID)
    return join(homedir(), ".claude");
  const dir = join(profileRoot(profileId), "claude");
  privateDir(dir);
  return dir;
}

/** Scrub inherited Claude credentials and bind the SDK only to this profile. */
export function claudeProfileEnvironment(
  profileId: string,
): Record<string, string> {
  const profile = credentialProfileById(profileId);
  if (!profile || profile.provider !== "claude")
    throw new Error("That credential profile cannot run Claude.");
  // Provider switches and credentials must never leak from the service into a
  // profile. Keep ordinary process settings (PATH, locale, proxy, etc.) only.
  const env = Object.fromEntries(
    Object.entries(childProcessEnv()).filter(
      ([key, value]) =>
        value !== undefined &&
        !key.startsWith("ANTHROPIC_") &&
        !key.startsWith("CLAUDE_") &&
        !key.startsWith("AWS_") &&
        !key.startsWith("VERTEXAI_") &&
        key !== "GOOGLE_APPLICATION_CREDENTIALS",
    ),
  ) as Record<string, string>;
  return profileId === DEFAULT_CLAUDE_PROFILE_ID
    ? env
    : { ...env, CLAUDE_CONFIG_DIR: claudeConfigDir(profileId) };
}

function openAiCredentialRevision(id: string): string | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(join(piAgentDir(id), "auth.json"), "utf8"),
    ) as Record<string, unknown>;
    const credential = raw["openai-codex"];
    if (!credential || typeof credential !== "object") return undefined;
    return createHash("sha256")
      .update(JSON.stringify(credential))
      .digest("hex");
  } catch {
    return undefined;
  }
}

/** Non-secret readiness hint for the profile-local OpenAI credential. */
export function openAiProfileHasCredential(id: string): boolean {
  try {
    const raw = JSON.parse(
      readFileSync(join(piAgentDir(id), "auth.json"), "utf8"),
    ) as Record<string, unknown>;
    return Boolean(
      raw["openai-codex"] && typeof raw["openai-codex"] === "object",
    );
  } catch {
    return false;
  }
}

/** Whether the active device flow has already replaced this profile's credential. */
export function openAiProfileLoginCredentialPersisted(id: string): boolean {
  const pending = transient.get(id);
  return (
    pending !== undefined &&
    openAiProfileHasCredential(id) &&
    pending.credentialRevisionAtStart !== openAiCredentialRevision(id)
  );
}

export function claudeProfileHasCredential(id: string): boolean {
  // Claude owns this format. Presence is enough for a non-secret readiness hint;
  // the SDK remains the final authority when it starts a query.
  return existsSync(join(claudeConfigDir(id), ".credentials.json"));
}

function summary(profile: CredentialProfile): CredentialProfileSummary {
  const pending = transient.get(profile.id);
  const configured =
    profile.provider === "openai-codex"
      ? openAiProfileHasCredential(profile.id)
      : claudeProfileHasCredential(profile.id);
  // pi persists OAuth before ModelRuntime.login() performs its post-login model
  // refresh. That refresh has no SDK timeout, so a changed profile-local auth
  // file is the authoritative completion signal even while the SDK promise is
  // still settling. An existing credential does not short-circuit reconnect:
  // its file revision must change before the device-code guidance disappears.
  const openAiCredentialUpdated =
    profile.provider === "openai-codex" &&
    openAiProfileLoginCredentialPersisted(profile.id);
  const loginStillConnecting =
    pending?.status === "connecting" &&
    (profile.provider === "claude" || !openAiCredentialUpdated);
  const status = loginStillConnecting
    ? "connecting"
    : configured
      ? "ready"
      : pending?.status === "error"
        ? "error"
        : "disconnected";
  if (profile.provider === "claude") {
    const path = claudeConfigDir(profile.id);
    return {
      ...profile,
      status,
      ...(pending?.error ? { error: pending.error } : {}),
      ...(status !== "ready"
        ? {
            setup: {
              path,
              command:
                profile.id === DEFAULT_CLAUDE_PROFILE_ID
                  ? "claude"
                  : `CLAUDE_CONFIG_DIR=${shellQuote(path)} claude`,
              detail:
                profile.id === DEFAULT_CLAUDE_PROFILE_ID
                  ? "Use Connect to complete the official Claude CLI login in this browser, or run plain claude in a terminal. This profile uses normal ~/.claude."
                  : "Use Connect to complete the official Claude CLI login in this browser. The command below remains available as a terminal fallback for this isolated profile.",
            },
          }
        : {}),
    };
  }
  return {
    ...profile,
    status,
    ...(pending?.error ? { error: pending.error } : {}),
    ...(status === "connecting"
      ? {
          setup: {
            path: piAgentDir(profile.id),
            command: "",
            detail:
              "Open the verification link and enter the one-time code. PA stores the resulting OAuth credential privately.",
            ...(pending?.verificationUri !== undefined
              ? { verificationUri: pending.verificationUri }
              : {}),
            ...(pending?.userCode !== undefined
              ? { userCode: pending.userCode }
              : {}),
          },
        }
      : {}),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * One-time compatibility seed: copies the former pi agent state into PA-owned
 * storage before the SDK is initialized. No later runtime path reads `~/.pi`.
 */
export function migrateLegacyDefaultPiProfile(legacyAgentDir?: string): void {
  const source =
    legacyAgentDir ??
    process.env.ASSISTANT_LEGACY_PI_AGENT_DIR ??
    join(homedir(), ".pi", "agent");
  const destination = piAgentDir(DEFAULT_OPENAI_PROFILE_ID);
  const marker = join(
    profileRoot(DEFAULT_OPENAI_PROFILE_ID),
    ".legacy-pi-imported-v1",
  );
  if (existsSync(marker)) return;
  if (existsSync(source) && readdirSync(destination).length === 0) {
    // Keep login/config plus supported PA customizations, never old terminal
    // transcripts or caches (which would bloat DATA_DIR backups).
    for (const entry of [
      "auth.json",
      "models.json",
      "models-store.json",
      "settings.json",
      "extensions",
      "skills",
      "prompt-templates",
    ]) {
      const from = join(source, entry);
      if (existsSync(from))
        cpSync(from, join(destination, entry), {
          recursive: true,
          force: false,
          errorOnExist: false,
          preserveTimestamps: true,
        });
    }
    privateTree(destination);
  }
  writeFileSync(marker, "seeded\n", { encoding: "utf8", mode: 0o600 });
  privateFile(marker);
}

/** Ensure PA has isolated default profiles for interactive and automatic work. */
export function ensureDefaultPiProfile(): CredentialProfile {
  const profiles = readRegistry();
  const now = Date.now();
  let changed = false;
  let openai = profiles.find(
    (profile) => profile.id === DEFAULT_OPENAI_PROFILE_ID,
  );
  if (!openai) {
    openai = {
      id: DEFAULT_OPENAI_PROFILE_ID,
      name: "Default OpenAI",
      provider: "openai-codex",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    profiles.unshift(openai);
    changed = true;
  }
  if (!profiles.some((profile) => profile.id === DEFAULT_CLAUDE_PROFILE_ID)) {
    profiles.push({
      id: DEFAULT_CLAUDE_PROFILE_ID,
      name: "Default Claude",
      provider: "claude",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    changed = true;
  }
  if (changed) writeRegistry(profiles);
  piAgentDir(openai.id);
  migrateLegacyDefaultPiProfile();
  return openai;
}

let defaultProfilesEnsured = false;

function ensureDefaultProfilesOnce(): void {
  if (defaultProfilesEnsured) return;
  ensureDefaultPiProfile();
  defaultProfilesEnsured = true;
}

/**
 * The account automatic (unpinned) work runs on: the first enabled profile of
 * that provider in registry order, else the protected default. `excludeId`
 * answers "where would this move if that account were disabled?".
 */
export function automaticProfileIdFor(
  provider: CredentialProfileProvider,
  excludeId?: string,
): string {
  ensureDefaultProfilesOnce();
  const protectedId =
    provider === "claude"
      ? DEFAULT_CLAUDE_PROFILE_ID
      : DEFAULT_OPENAI_PROFILE_ID;
  return (
    readRegistry().find(
      (profile) =>
        profile.provider === provider &&
        profile.enabled &&
        profile.id !== excludeId,
    )?.id ?? protectedId
  );
}

/** Enabled OpenAI profile used by non-browser session creation paths. */
export function defaultOpenAiProfileId(): string {
  return automaticProfileIdFor("openai-codex");
}

/** Enabled Claude profile used by non-browser session creation paths. */
export function defaultClaudeProfileId(): string {
  return automaticProfileIdFor("claude");
}

function isProtectedProfile(id: string): boolean {
  return id === DEFAULT_OPENAI_PROFILE_ID || id === DEFAULT_CLAUDE_PROFILE_ID;
}

export function listCredentialProfiles(): CredentialProfileSummary[] {
  ensureDefaultPiProfile();
  return readRegistry()
    .map(summary)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function createCredentialProfile(input: {
  name: string;
  provider: CredentialProfileProvider;
}): CredentialProfileSummary {
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) throw new Error("A profile name is required.");
  const profiles = readRegistry();
  const now = Date.now();
  const profile: CredentialProfile = {
    id: `cp_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    name,
    provider: input.provider,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  profiles.push(profile);
  writeRegistry(profiles);
  if (profile.provider === "openai-codex") piAgentDir(profile.id);
  else claudeConfigDir(profile.id);
  credentialProfileChanged(profile.id);
  return summary(profile);
}

export function setCredentialProfileEnabled(
  id: string,
  enabled: boolean,
): CredentialProfileSummary {
  const profiles = readRegistry();
  const index = profiles.findIndex((profile) => profile.id === id);
  if (index < 0) throw new Error("Credential profile not found.");
  const profile = { ...profiles[index]!, enabled, updatedAt: Date.now() };
  profiles[index] = profile;
  writeRegistry(profiles);
  credentialProfileChanged(id);
  return summary(profile);
}

export function renameCredentialProfile(
  id: string,
  rawName: string,
): CredentialProfileSummary {
  if (isProtectedProfile(id))
    throw new Error("A default profile cannot be renamed.");
  const name = rawName.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) throw new Error("A profile name is required.");
  const profiles = readRegistry();
  const index = profiles.findIndex((profile) => profile.id === id);
  if (index < 0) throw new Error("Credential profile not found.");
  const profile = { ...profiles[index]!, name, updatedAt: Date.now() };
  profiles[index] = profile;
  writeRegistry(profiles);
  credentialProfileChanged(id);
  return summary(profile);
}

export function deleteCredentialProfile(id: string): void {
  if (isProtectedProfile(id))
    throw new Error("A default profile cannot be deleted.");
  // Every scope: a profile an internal or subagent session is still bound to is
  // just as much in use as one the user's own session holds.
  if (
    sessionStore
      .list({ scopes: "all" })
      .some((session) => session.credentialProfileId === id)
  ) {
    throw new Error("This profile is still bound to one or more sessions.");
  }
  const profiles = readRegistry();
  if (!profiles.some((profile) => profile.id === id))
    throw new Error("Credential profile not found.");
  writeRegistry(profiles.filter((profile) => profile.id !== id));
  transient.delete(id);
  credentialProfileDeletedHandler?.(id);
  for (const listener of credentialProfileDeletedListeners) listener(id);
  rmSync(profileRoot(id), { recursive: true, force: true });
  credentialProfileChanged(id);
}

export function setCredentialProfileLoginState(
  id: string,
  state: {
    status: CredentialProfileStatus;
    error?: string;
    verificationUri?: string;
    userCode?: string;
  },
): void {
  const current = transient.get(id);
  const credentialRevisionAtStartValue = openAiCredentialRevision(id);
  transient.set(id, {
    ...current,
    ...state,
    ...(current?.credentialRevisionAtStart === undefined &&
    state.status === "connecting"
      ? {
          ...(credentialRevisionAtStartValue !== undefined
            ? { credentialRevisionAtStart: credentialRevisionAtStartValue }
            : {}),
        }
      : {}),
  });
  credentialProfileChanged(id);
}

/** Clear terminal login state once provider-owned credentials are on disk. */
export function clearCredentialProfileLoginState(id: string): void {
  transient.delete(id);
  credentialProfileChanged(id);
}

/** One account as the Settings page shows it, with its current status. */
export function credentialProfileSummaryById(
  id: string,
): CredentialProfileSummary | undefined {
  const profile = credentialProfileById(id);
  return profile ? summary(profile) : undefined;
}

export function credentialProfileById(
  id: string,
): CredentialProfile | undefined {
  return readRegistry().find((profile) => profile.id === id);
}

/** Resolve a profile only when it is eligible for new work. */
export function enabledCredentialProfileById(
  id: string,
): CredentialProfile | undefined {
  const profile = credentialProfileById(id);
  return profile?.enabled ? profile : undefined;
}
