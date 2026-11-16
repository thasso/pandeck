/**
 * Non-secret macOS login evidence for direct local mode. The official CLI reads
 * only its profile's Keychain entry; PA retains a boolean, never a credential.
 * Gateway modes remain file-backed (or use the remote account mirror).
 */
import {
  bundledClaudeCliPath,
  claudeLoginEnvironmentFrom,
} from "./claudeLoginDriver.ts";
import { GATEWAY_ENABLED, GATEWAY_RELAY } from "./config.ts";
import {
  claudeCredentialFileExists,
  claudeProfileEnvironment,
  credentialProfileById,
  credentialProfileLoginStateMark,
  credentialProfilesOfKind,
  setClaudeStoredLoginPresence,
} from "./credentialProfiles.ts";
import { brokerExecFile } from "./spawnBroker.ts";
import { userHomeDir } from "./userHome.ts";

const pending = new Map<string, Promise<void>>();
const POLL_MS = 30_000;
const supportsKeychain = () =>
  process.platform === "darwin" && !GATEWAY_ENABLED && !GATEWAY_RELAY;

/**
 * Re-check one profile without exporting its Keychain credential. Callers join
 * a probe already running; `fresh` instead queues a new one behind it, for an
 * answer observed after the call (a login child that just closed).
 */
export async function refreshClaudeCredentialStatus(
  profileId: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<void> {
  if (
    !supportsKeychain() ||
    credentialProfileById(profileId)?.provider !== "claude"
  )
    return;
  const existing = pending.get(profileId);
  if (existing && !fresh) return existing;
  // Queued, not parallel: an earlier probe can never overwrite a later answer.
  const check = existing
    ? existing.then(() => probe(profileId))
    : probe(profileId);
  pending.set(profileId, check);
  try {
    await check;
  } finally {
    if (pending.get(profileId) === check) pending.delete(profileId);
  }
}

async function probe(profileId: string): Promise<void> {
  // A queued probe may start after the profile was deleted: its directory
  // must not be recreated.
  if (credentialProfileById(profileId)?.provider !== "claude") return;
  if (claudeCredentialFileExists(profileId)) {
    setClaudeStoredLoginPresence(profileId, false);
    return;
  }
  const observed = credentialProfileLoginStateMark(profileId);
  try {
    const result = await brokerExecFile({
      file: bundledClaudeCliPath(),
      args: ["auth", "status", "--json"],
      cwd: userHomeDir(),
      env: claudeLoginEnvironmentFrom(claudeProfileEnvironment(profileId)),
      encoding: "utf8",
      maxBuffer: 32_768,
      signal: AbortSignal.timeout(10_000),
    });
    // Exit 1 is the documented not-logged-in status. Other failures and
    // malformed output leave previous evidence alone, rather than imply logout.
    if (result.error && result.error.code !== 1) return;
    const status = JSON.parse(result.stdout) as Record<string, unknown>;
    if (typeof status.loggedIn !== "boolean") return;
    setClaudeStoredLoginPresence(
      profileId,
      !result.error && status.loggedIn && status.authMethod === "claude.ai",
      observed,
    );
  } catch {
    // Never log CLI output/errors: they can contain account-identifying data.
  }
}

/** Discover profile-scoped Keychain logins at boot, then external login/logout. */
export async function startClaudeCredentialStatusChecks(): Promise<void> {
  if (!supportsKeychain()) return;
  const refresh = () =>
    Promise.all(
      credentialProfilesOfKind("claude").map((profile) =>
        refreshClaudeCredentialStatus(profile.id),
      ),
    );
  await refresh();
  const timer = setInterval(() => void refresh(), POLL_MS);
  timer.unref();
}
