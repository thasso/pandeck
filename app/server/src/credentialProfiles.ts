import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DATA_DIR } from "./config.ts";
import { sessionStore } from "./db/sessionStore.ts";
import {
  CREDENTIAL_PROFILES_ROOT,
  credentialProfileRoot,
  isSafeCredentialProfileId,
} from "./credentialProfilePaths.ts";
import {
  normalizeOpenAiCompatibleEndpoint,
  openAiCompatibleEndpointPath,
  openAiCompatibleEndpointReady,
  openAiCompatibleEndpointSummary,
  patchedOpenAiCompatibleEndpoint,
  readOpenAiCompatibleEndpoint,
  testOpenAiCompatibleEndpoint,
  writeOpenAiCompatibleEndpoint,
  type OpenAiCompatibleEndpointPatch,
} from "./openAiCompatibleAccounts.ts";
import { childProcessEnv } from "./subprocessEnv.ts";
import {
  claudeChildEnvironment,
  type ClaudeProfileRuntime,
} from "./claudeChildEnvironment.ts";
import {
  readAccountHealth,
  reportAccountLoginCompleted,
  withAccountHealthProfiles,
} from "./accountHealth.ts";
import {
  ACCOUNT_KINDS,
  isAccountKind,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  OPENAI_COMPATIBLE_THINKING_FORMATS,
  type AccountHealth,
  type CredentialProfileProvider,
  type CredentialProfileStatus,
  type OpenAiCompatibleConnectionStatus,
  type OpenAiCompatibleEndpointSummary,
} from "@assistant/shared";

/**
 * PA-owned account-profile registry. The JSON registry is deliberately limited
 * to non-secret labels and paths derived from the profile id; provider tokens
 * stay in pi's auth.json or Claude's own config directory, and an
 * OpenAI-compatible account's endpoint and key in its own `endpoint.json`
 * (`openAiCompatibleAccounts.ts`).
 */
export type { CredentialProfileProvider };

export interface CredentialProfile {
  id: string;
  name: string;
  provider: CredentialProfileProvider;
  enabled: boolean;
  enterprise: boolean;
  /** Automatic prefers higher among eligible accounts; absent means 0. */
  priority?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialProfileSummary extends CredentialProfile {
  status: CredentialProfileStatus;
  health: AccountHealth;
  /** Safe, user-actionable setup guidance. Never contains a token. */
  setup?: {
    path: string;
    command: string;
    detail: string;
    verificationUri?: string;
    userCode?: string;
  };
  error?: string;
  /** An OpenAI-compatible account's endpoint, without its key. */
  endpoint?: OpenAiCompatibleEndpointSummary;
  /** An unfinished login holds this login account (`loginHolds.ts`). */
  loginStuck?: true;
}

export const DEFAULT_OPENAI_PROFILE_ID = "default";
export const DEFAULT_CLAUDE_PROFILE_ID = "claude-default";
const ROOT = CREDENTIAL_PROFILES_ROOT;
const REGISTRY = join(ROOT, "profiles.json");
/** A health that says nothing: an account that is no subscription login has none. */
const NO_HEALTH: AccountHealth = { state: "unknown", since: null };
interface TransientCredentialProfileState {
  status: CredentialProfileStatus;
  error?: string;
  verificationUri?: string;
  userCode?: string;
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

let loginStuckReader: ((profile: CredentialProfile) => boolean) | undefined;

/**
 * Who says whether a login account is login-stuck (`loginHolds.ts`, which
 * imports this module and so cannot be imported by it).
 */
export function setCredentialProfileLoginStuckReader(
  reader: ((profile: CredentialProfile) => boolean) | undefined,
): void {
  loginStuckReader = reader;
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

/**
 * Client mode (`gatewayClientLink.ts`): the gateway owns the accounts, and
 * the registry is their mirror, metadata only. No token file, no write: an
 * account is neither created, changed, deleted nor logged in from here.
 * Undefined in the self-hosted (server-master) mode.
 */
let remoteProfiles: CredentialProfile[] | undefined;
/** The mirrored accounts the gateway says need a login. */
const remoteNeedsLogin = new Set<string>();

/** A gateway account as gateway client 1.0 lists it. */
export interface RemoteCredentialProfile {
  id: string;
  provider: "claude" | "openai-codex";
  name: string;
  enabled: boolean;
  needsLogin: boolean;
}

/**
 * Replaces the mirror with the gateway's accounts (client mode), or leaves
 * client mode with `undefined`. Every account that came, went or changed is
 * reported as a change.
 */
export function mirrorRemoteCredentialProfiles(
  accounts: readonly RemoteCredentialProfile[] | undefined,
): void {
  const before = new Map((remoteProfiles ?? []).map((p) => [p.id, p]));
  const neededBefore = new Set(remoteNeedsLogin);
  const now = Date.now();
  remoteNeedsLogin.clear();
  remoteProfiles = accounts?.flatMap((account, index): CredentialProfile[] => {
    if (!isSafeCredentialProfileId(account.id)) return [];
    if (account.needsLogin) remoteNeedsLogin.add(account.id);
    const known = before.get(account.id);
    const createdAt = known?.createdAt ?? now + index;
    const same =
      known?.name === account.name.slice(0, 80) &&
      known.enabled === account.enabled &&
      known.provider === account.provider;
    return [
      {
        id: account.id,
        name: account.name.slice(0, 80),
        provider: account.provider,
        enabled: account.enabled,
        enterprise: false,
        priority: 0,
        createdAt,
        updatedAt: same ? known.updatedAt : now,
      },
    ];
  });
  const after = new Map((remoteProfiles ?? []).map((p) => [p.id, p]));
  // An account the gateway dropped is deleted here as well: its caches go.
  if (accounts)
    for (const id of before.keys())
      if (!after.has(id)) {
        transient.delete(id);
        credentialProfileDeletedHandler?.(id);
        for (const listener of credentialProfileDeletedListeners) listener(id);
      }
  for (const id of new Set([...before.keys(), ...after.keys()]))
    if (
      before.get(id)?.updatedAt !== after.get(id)?.updatedAt ||
      neededBefore.has(id) !== remoteNeedsLogin.has(id)
    )
      credentialProfileChanged(id);
}

/** A mirrored account the gateway holds a working login for; none keeps a file here. */
function remoteAccountReady(id: string): boolean {
  return (
    remoteProfiles?.some((profile) => profile.id === id) === true &&
    !remoteNeedsLogin.has(id)
  );
}

/** Client mode only: whether any mirrored OpenAI account has a working login. */
export function remoteOpenAiAccountReady(): boolean {
  return (
    remoteProfiles?.some(
      (profile) =>
        profile.provider === "openai-codex" && remoteAccountReady(profile.id),
    ) === true
  );
}

function readRegistry(): CredentialProfile[] {
  if (remoteProfiles) return remoteProfiles.map((profile) => ({ ...profile }));
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
        !isSafeCredentialProfileId(p.id) ||
        !p.name ||
        !isAccountKind(p.provider) ||
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
          enterprise: p.enterprise === true,
          priority: Number.isSafeInteger(p.priority) ? p.priority! : 0,
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
  if (remoteProfiles)
    throw new Error("The gateway manages the accounts of this Pandeck.");
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

const profileRoot = credentialProfileRoot;

/** The whole pi agent directory is PA-owned, including models/auth/settings. */
export function piAgentDir(profileId = "default"): string {
  const dir = join(profileRoot(profileId), "pi-agent");
  privateDir(dir);
  return dir;
}

/**
 * Claude CLI state: every Claude account, the protected default included, is
 * PA-isolated under its own profile directory. Nothing reads the user's
 * `~/.claude` (`docs/credential-distribution.md`).
 */
export function claudeConfigDir(profileId: string): string {
  const dir = join(profileRoot(profileId), "claude");
  privateDir(dir);
  return dir;
}

/**
 * The non-secret half of a profile that runs Claude: only its config
 * directory, which a query's host applies over its own base environment
 * (`claudeChildEnvironment`). The CLI reads its credentials from there.
 */
export function claudeProfileRuntime(profileId: string): ClaudeProfileRuntime {
  const profile = credentialProfileById(profileId);
  if (!profile || profile.provider !== "claude")
    throw new Error("That credential profile cannot run Claude.");
  return { configDir: claudeConfigDir(profileId) };
}

/** Scrub inherited Claude credentials and bind the SDK only to this profile. */
export function claudeProfileEnvironment(
  profileId: string,
): Record<string, string> {
  return claudeChildEnvironment(
    childProcessEnv(),
    claudeProfileRuntime(profileId),
  );
}

/** Non-secret readiness hint for the profile-local OpenAI credential. */
export function openAiProfileHasCredential(id: string): boolean {
  if (remoteProfiles) return remoteAccountReady(id);
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

export function claudeProfileHasCredential(id: string): boolean {
  if (remoteProfiles) return remoteAccountReady(id);
  // Claude owns this format. Presence is enough for a non-secret readiness hint;
  // the SDK remains the final authority when it starts a query.
  return existsSync(join(claudeConfigDir(id), ".credentials.json"));
}

/** File presence is independent of transient login/setup state. */
export function credentialProfileHasCredential(id: string): boolean {
  const profile = credentialProfileById(id);
  if (!profile) return false;
  switch (profile.provider) {
    case "claude":
      return claudeProfileHasCredential(id);
    case "openai-codex":
      return openAiProfileHasCredential(id);
    case "openai-compatible":
      return openAiCompatibleEndpointReady(readOpenAiCompatibleEndpoint(id));
  }
}

/**
 * An endpoint account has no login: it is ready once it has a base URL and
 * models, and its health is constant (no subscription signal reaches it).
 */
function endpointSummary(profile: CredentialProfile): CredentialProfileSummary {
  const endpoint = readOpenAiCompatibleEndpoint(profile.id);
  return {
    ...profile,
    status: openAiCompatibleEndpointReady(endpoint) ? "ready" : "disconnected",
    health: NO_HEALTH,
    endpoint: openAiCompatibleEndpointSummary(endpoint),
  };
}

function summary(profile: CredentialProfile): CredentialProfileSummary {
  if (ACCOUNT_KINDS[profile.provider].credential === "endpoint")
    return endpointSummary(profile);
  if (remoteProfiles) {
    // The gateway holds the credential: no file here says anything. A login
    // it runs for this account shows as today's (`remoteLogins.ts`).
    const ready = !remoteNeedsLogin.has(profile.id);
    const pending = transient.get(profile.id);
    const status =
      pending?.status === "connecting"
        ? "connecting"
        : ready
          ? "ready"
          : pending?.status === "error"
            ? "error"
            : "disconnected";
    return {
      ...profile,
      status,
      health: readAccountHealth(profile.id, ready),
      ...(pending?.error ? { error: pending.error } : {}),
      ...(status === "connecting" && profile.provider === "openai-codex"
        ? {
            setup: {
              path: "",
              command: "",
              detail:
                "Open the verification link and enter the one-time code. The gateway stores the resulting OAuth credential.",
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
  const pending = transient.get(profile.id);
  const configured =
    profile.provider === "openai-codex"
      ? openAiProfileHasCredential(profile.id)
      : claudeProfileHasCredential(profile.id);
  // The login owner clears connecting only on its own successful commit.
  const loginStillConnecting = pending?.status === "connecting";
  const status = loginStillConnecting
    ? "connecting"
    : configured
      ? "ready"
      : pending?.status === "error"
        ? "error"
        : "disconnected";
  const loginStuck = loginStuckReader?.(profile)
    ? { loginStuck: true as const }
    : {};
  if (profile.provider === "claude") {
    const path = claudeConfigDir(profile.id);
    return {
      ...profile,
      status,
      health: readAccountHealth(profile.id, configured),
      ...(pending?.error ? { error: pending.error } : {}),
      ...loginStuck,
      ...(status !== "ready"
        ? {
            setup: {
              path,
              command: `CLAUDE_CONFIG_DIR=${shellQuote(path)} claude`,
              detail:
                "Use Connect to complete the official Claude CLI login in this browser. The command below remains available as a terminal fallback for this isolated profile.",
            },
          }
        : {}),
    };
  }
  return {
    ...profile,
    status,
    health: readAccountHealth(profile.id, configured),
    ...(pending?.error ? { error: pending.error } : {}),
    ...loginStuck,
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
 * storage only from an explicit argument or ASSISTANT_LEGACY_PI_AGENT_DIR.
 * A fresh DATA_DIR never silently imports credentials from the user's home.
 */
export function migrateLegacyDefaultPiProfile(legacyAgentDir?: string): void {
  const source = legacyAgentDir ?? process.env.ASSISTANT_LEGACY_PI_AGENT_DIR;
  if (!source) return;
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

/** The single endpoint's former settings file, read only by the migration below. */
export const LEGACY_OPENAI_COMPATIBLE_SETTINGS_PATH = join(
  DATA_DIR,
  "settings",
  "openai-compatible.json",
);

/** The points a test may stop the migration at, as a crash would. */
export type OpenAiCompatibleMigrationStep =
  "endpoint-written" | "endpoint-verified" | "registry-committed";

/**
 * Move the former single endpoint (`settings/openai-compatible.json`) to the
 * account `openai-compatible`, verify, then delete the old file
 * (`docs/settings.md`). The registry entry is the commit point, and only this
 * migration creates that id (every later compatible id has a hex suffix):
 *
 * 1. No old file: done. An old file with no base URL, key or models holds
 *    nothing to keep and is deleted.
 * 2. The registry has the account already (a crash after the commit, or a
 *    failed delete): its `endpoint.json` must equal the old file's endpoint
 *    and be 0600; then the old file goes. Otherwise both stay as they are:
 *    the user may have edited the account since.
 * 3. Otherwise write `endpoint.json`, check its mode and read it back, then
 *    add the registry entry (enterprise copied from Default OpenAI) and read
 *    that back. Only then is the old file deleted.
 *
 * Any failure leaves the old file for the next boot to retry, and is logged
 * without the key or the URL. It never throws: boot goes on either way.
 */
export function migrateOpenAiCompatibleSettingsToAccount(
  options: { afterStep?: (step: OpenAiCompatibleMigrationStep) => void } = {},
): void {
  const legacy = LEGACY_OPENAI_COMPATIBLE_SETTINGS_PATH;
  const id = OPENAI_COMPATIBLE_PROVIDER_ID;
  try {
    if (!existsSync(legacy)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(legacy, "utf8")) as unknown;
    } catch {
      // The parse error can quote the file, key included.
      console.warn(
        "[credential-profiles] settings/openai-compatible.json is unreadable; left for manual review.",
      );
      return;
    }
    const endpoint = normalizeOpenAiCompatibleEndpoint(raw);
    if (!endpoint.baseUrl && !endpoint.apiKey && endpoint.models.length === 0) {
      unlinkSync(legacy);
      return;
    }
    const existing = readRegistry().find((profile) => profile.id === id);
    if (existing) {
      if (
        existing.provider === "openai-compatible" &&
        endpointStored(id, endpoint)
      )
        unlinkSync(legacy);
      else
        console.warn(
          "[credential-profiles] The OpenAI-compatible account differs from settings/openai-compatible.json; the file is left for manual review.",
        );
      return;
    }
    writeOpenAiCompatibleEndpoint(id, endpoint);
    options.afterStep?.("endpoint-written");
    if (!endpointStored(id, endpoint))
      throw new Error("The written endpoint did not read back unchanged.");
    options.afterStep?.("endpoint-verified");
    const settings = (raw ?? {}) as { enabled?: unknown; name?: unknown };
    const now = Date.now();
    const profiles = readRegistry();
    profiles.push({
      id,
      name:
        (typeof settings.name === "string" &&
          settings.name.trim().replace(/\s+/g, " ").slice(0, 80)) ||
        ACCOUNT_KINDS["openai-compatible"].label,
      provider: "openai-compatible",
      enabled: settings.enabled === true,
      enterprise:
        profiles.find((profile) => profile.id === DEFAULT_OPENAI_PROFILE_ID)
          ?.enterprise === true,
      priority: 0,
      createdAt: now,
      updatedAt: now,
    });
    writeRegistry(profiles);
    if (
      readRegistry().find((profile) => profile.id === id)?.provider !==
      "openai-compatible"
    )
      throw new Error("The registry did not read back the new account.");
    options.afterStep?.("registry-committed");
    unlinkSync(legacy);
  } catch (err) {
    console.warn(
      `[credential-profiles] The OpenAI-compatible endpoint was not migrated; settings/openai-compatible.json stays for the next boot: ${migrationFailure(err)}`,
    );
  }
}

/**
 * A failure as the log may name it: a filesystem code, or this migration's own
 * text. Neither can carry the file's content.
 */
function migrationFailure(err: unknown): string {
  if (!(err instanceof Error)) return "failed";
  return (err as NodeJS.ErrnoException).code ?? err.message;
}

/** Whether the account's own file holds exactly `endpoint`, privately. */
function endpointStored(
  id: string,
  endpoint: ReturnType<typeof normalizeOpenAiCompatibleEndpoint>,
): boolean {
  const path = openAiCompatibleEndpointPath(id);
  try {
    if ((statSync(path).mode & 0o777) !== 0o600) return false;
    return isDeepStrictEqual(
      normalizeOpenAiCompatibleEndpoint(
        JSON.parse(readFileSync(path, "utf8")) as unknown,
      ),
      endpoint,
    );
  } catch {
    return false;
  }
}

/** Ensure PA has isolated default profiles for interactive and automatic work. */
export function ensureDefaultPiProfile(): CredentialProfile {
  const profiles = readRegistry();
  const now = Date.now();
  // Client mode creates no account: the gateway's are all there is.
  if (remoteProfiles)
    return (
      profiles.find((profile) => profile.provider === "openai-codex") ?? {
        id: DEFAULT_OPENAI_PROFILE_ID,
        name: "Default OpenAI",
        provider: "openai-codex",
        enabled: false,
        enterprise: false,
        createdAt: now,
        updatedAt: now,
      }
    );
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
      enterprise: false,
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
      enterprise: false,
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
 * First-enabled information for non-routing UI (login/usage defaults and
 * account-management hints), else the protected default. New sessions and
 * background work use accountRouter instead.
 */
function automaticProfileIdFor(provider: "openai-codex" | "claude"): string {
  ensureDefaultProfilesOnce();
  const protectedId =
    provider === "claude"
      ? DEFAULT_CLAUDE_PROFILE_ID
      : DEFAULT_OPENAI_PROFILE_ID;
  return (
    readRegistry().find(
      (profile) => profile.provider === provider && profile.enabled,
    )?.id ?? protectedId
  );
}

/** Default OpenAI account for non-routing login/usage UI. */
export function defaultOpenAiProfileId(): string {
  return automaticProfileIdFor("openai-codex");
}

/** Default Claude account for non-routing login/usage UI. */
export function defaultClaudeProfileId(): string {
  return automaticProfileIdFor("claude");
}

function isProtectedProfile(id: string): boolean {
  return id === DEFAULT_OPENAI_PROFILE_ID || id === DEFAULT_CLAUDE_PROFILE_ID;
}

export function listCredentialProfiles(): CredentialProfileSummary[] {
  ensureDefaultPiProfile();
  return withAccountHealthProfiles(() =>
    readRegistry()
      .map(summary)
      .sort((a, b) => a.createdAt - b.createdAt),
  );
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
    id: newProfileId(input.provider),
    name,
    provider: input.provider,
    enabled: true,
    enterprise: false,
    createdAt: now,
    updatedAt: now,
  };
  profiles.push(profile);
  writeRegistry(profiles);
  if (profile.provider === "claude") claudeConfigDir(profile.id);
  else piAgentDir(profile.id);
  credentialProfileChanged(profile.id);
  return summary(profile);
}

/**
 * A new account's id. Only an OpenAI-compatible account is ever given an id in
 * the `openai-compatible-<12 hex>` grammar: it is also its models' pi provider
 * id, and the Worker tells a pi account's kind from it (`accountKinds.ts`).
 */
function newProfileId(provider: CredentialProfileProvider): string {
  const hex = randomUUID().replace(/-/g, "");
  return provider === "openai-compatible"
    ? `${OPENAI_COMPATIBLE_PROVIDER_ID}-${hex.slice(0, 12)}`
    : `cp_${hex.slice(0, 16)}`;
}

function openAiCompatibleProfile(id: string): CredentialProfile {
  const profile = credentialProfileById(id);
  if (!profile) throw new Error("Credential profile not found.");
  if (profile.provider !== "openai-compatible")
    throw new Error("That account has no endpoint.");
  return profile;
}

/** Validate an untrusted endpoint edit as a whole before one write. */
function endpointPatch(input: {
  baseUrl?: unknown;
  apiKey?: unknown;
  clearApiKey?: unknown;
  thinkingFormat?: unknown;
}): OpenAiCompatibleEndpointPatch {
  const patch: OpenAiCompatibleEndpointPatch = {};
  if (input.baseUrl !== undefined) {
    if (typeof input.baseUrl !== "string")
      throw new Error("A base URL must be a string.");
    patch.baseUrl = input.baseUrl;
  }
  if (input.apiKey !== undefined) {
    if (typeof input.apiKey !== "string")
      throw new Error("An API key must be a string.");
    patch.apiKey = input.apiKey;
  }
  if (input.clearApiKey !== undefined) {
    if (typeof input.clearApiKey !== "boolean")
      throw new Error("clearApiKey must be a boolean.");
    patch.clearApiKey = input.clearApiKey;
  }
  if (input.thinkingFormat !== undefined) {
    const format = OPENAI_COMPATIBLE_THINKING_FORMATS.find(
      (known) => known === input.thinkingFormat,
    );
    if (!format) throw new Error("Unknown thinking format.");
    patch.thinkingFormat = format;
  }
  if (!Object.keys(patch).length)
    throw new Error(
      "A base URL, API key, clearApiKey or thinking format is required.",
    );
  return patch;
}

/** Edit an OpenAI-compatible account's endpoint; the key is write-only. */
export function patchOpenAiCompatibleEndpoint(
  id: string,
  input: {
    baseUrl?: unknown;
    apiKey?: unknown;
    clearApiKey?: unknown;
    thinkingFormat?: unknown;
  },
): CredentialProfileSummary {
  const patch = endpointPatch(input);
  const profile = openAiCompatibleProfile(id);
  writeOpenAiCompatibleEndpoint(
    id,
    patchedOpenAiCompatibleEndpoint(readOpenAiCompatibleEndpoint(id), patch),
  );
  credentialProfileChanged(id);
  return summary(profile);
}

/** Rediscover an OpenAI-compatible account's models from its endpoint. */
export async function testOpenAiCompatibleProfile(
  id: string,
  signal?: AbortSignal,
): Promise<{
  status: OpenAiCompatibleConnectionStatus;
  profile: CredentialProfileSummary;
}> {
  openAiCompatibleProfile(id);
  const status = await testOpenAiCompatibleEndpoint(id, {
    ...(signal ? { signal } : {}),
    stillExists: () => credentialProfileById(id) !== undefined,
  });
  credentialProfileChanged(id);
  return { status, profile: summary(openAiCompatibleProfile(id)) };
}

/** Validate the whole HTTP metadata patch before one write/publication. */
export function patchCredentialProfile(
  id: string,
  input: {
    name?: unknown;
    enabled?: unknown;
    enterprise?: unknown;
    priority?: unknown;
  },
): CredentialProfileSummary {
  const changes: Partial<
    Pick<CredentialProfile, "name" | "enabled" | "enterprise" | "priority">
  > = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string")
      throw new Error("A profile name must be a string.");
    if (isProtectedProfile(id))
      throw new Error("A default profile cannot be renamed.");
    const name = input.name.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!name) throw new Error("A profile name is required.");
    changes.name = name;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean")
      throw new Error("Enabled must be a boolean.");
    changes.enabled = input.enabled;
  }
  if (input.enterprise !== undefined) {
    if (typeof input.enterprise !== "boolean")
      throw new Error("Enterprise must be a boolean.");
    changes.enterprise = input.enterprise;
  }
  if (input.priority !== undefined) {
    if (!Number.isSafeInteger(input.priority))
      throw new Error("Priority must be an integer.");
    changes.priority = input.priority as number;
  }
  if (!Object.keys(changes).length)
    throw new Error(
      "A profile name, enabled state, enterprise flag or priority is required.",
    );
  const profiles = readRegistry();
  const index = profiles.findIndex((profile) => profile.id === id);
  if (index < 0) throw new Error("Credential profile not found.");
  const profile = { ...profiles[index]!, ...changes, updatedAt: Date.now() };
  profiles[index] = profile;
  writeRegistry(profiles);
  credentialProfileChanged(id);
  return summary(profile);
}

export function setCredentialProfileEnabled(
  id: string,
  enabled: boolean,
): CredentialProfileSummary {
  return patchCredentialProfile(id, { enabled });
}

export function renameCredentialProfile(
  id: string,
  rawName: string,
): CredentialProfileSummary {
  return patchCredentialProfile(id, { name: rawName });
}

/** Throws unless the account may be deleted: not a default, not bound. */
export function assertCredentialProfileDeletable(id: string): void {
  if (isProtectedProfile(id))
    throw new Error("A default profile cannot be deleted.");
  // Every scope: a profile an internal session is still bound to is just as
  // much in use as one the user's own session holds.
  if (
    sessionStore
      .list({ scopes: "all" })
      .some((session) => session.credentialProfileId === id)
  ) {
    throw new Error("This profile is still bound to one or more sessions.");
  }
}

export function deleteCredentialProfile(id: string): void {
  assertCredentialProfileDeletable(id);
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
  transient.set(id, { ...transient.get(id), ...state });
  credentialProfileChanged(id);
}

/** Cleanup is not evidence of a successful login: reconnect start/cancel also uses it. */
export function clearCredentialProfileLoginState(id: string): void {
  transient.delete(id);
  credentialProfileChanged(id);
}

/** Called only by a provider-owned flow that completed or replaced its credential. */
export function completeCredentialProfileLogin(id: string): void {
  transient.delete(id);
  if (credentialProfileSummaryById(id)?.status === "ready")
    reportAccountLoginCompleted(id);
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

/** Every account of one kind, enabled or not, without status or health. */
export function credentialProfilesOfKind(
  provider: CredentialProfileProvider,
): CredentialProfile[] {
  return readRegistry().filter((profile) => profile.provider === provider);
}

/** Resolve a profile only when it is eligible for new work. */
export function enabledCredentialProfileById(
  id: string,
): CredentialProfile | undefined {
  const profile = credentialProfileById(id);
  return profile?.enabled ? profile : undefined;
}
