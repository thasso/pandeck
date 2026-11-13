/**
 * Non-secret macOS login evidence for direct local mode. The official CLI reads
 * only its profile's Keychain entry; PA retains a boolean, never a credential.
 * Gateway modes remain file-backed (or use the remote account mirror).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  bundledClaudeCliPath,
  claudeLoginEnvironmentFrom,
} from "./claudeLoginDriver.ts";
import { GATEWAY_ENABLED, GATEWAY_RELAY } from "./config.ts";
import {
  claudeConfigDir,
  claudeProfileEnvironment,
  credentialProfileById,
  credentialProfilesOfKind,
  setClaudeStoredLoginPresence,
} from "./credentialProfiles.ts";
import { brokerExecFile } from "./spawnBroker.ts";
import { userHomeDir } from "./userHome.ts";

const pending = new Map<string, Promise<void>>();
const POLL_MS = 30_000;
const supportsKeychain = () =>
  process.platform === "darwin" && !GATEWAY_ENABLED && !GATEWAY_RELAY;

/** Re-check one profile after login, without exporting its Keychain credential. */
export async function refreshClaudeCredentialStatus(
  profileId: string,
): Promise<void> {
  if (
    !supportsKeychain() ||
    credentialProfileById(profileId)?.provider !== "claude"
  )
    return;
  const existing = pending.get(profileId);
  if (existing) return existing;
  const check = probe(profileId);
  pending.set(profileId, check);
  try {
    await check;
  } finally {
    pending.delete(profileId);
  }
}

async function probe(profileId: string): Promise<void> {
  if (existsSync(join(claudeConfigDir(profileId), ".credentials.json"))) {
    setClaudeStoredLoginPresence(profileId, false);
    return;
  }
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
