import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DATA_DIR } from "./config.ts";

/**
 * Where credential profiles keep their private state: one directory per
 * account under {@link CREDENTIAL_PROFILES_ROOT}, beside the non-secret
 * registry. A leaf, so the registry (`credentialProfiles.ts`) and the stores
 * it summarizes (`openAiCompatibleAccounts.ts`) share it without a cycle.
 */
export const CREDENTIAL_PROFILES_ROOT = join(DATA_DIR, "credential-profiles");

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function isSafeCredentialProfileId(id: string): boolean {
  return SAFE_ID.test(id);
}

/**
 * A Claude account's CLI transcripts under any credential-profiles root (this
 * process's {@link CREDENTIAL_PROFILES_ROOT}, or another data dir's for the
 * measurement CLIs): `<root>/<id>/claude/projects`. Pure; throws for an id
 * that could leave the root.
 */
export function claudeProjectsDirIn(
  profilesRoot: string,
  profileId: string,
): string {
  if (!isSafeCredentialProfileId(profileId))
    throw new Error("Invalid credential profile id.");
  return join(profilesRoot, profileId, "claude", "projects");
}

/**
 * Every account's Claude CLI transcript directory under a credential-profiles
 * root, in name order: `<root>/<account>/claude/projects` where it exists.
 */
export function claudeProjectsDirsUnder(profilesRoot: string): string[] {
  if (!existsSync(profilesRoot)) return [];
  return readdirSync(profilesRoot)
    .filter(isSafeCredentialProfileId)
    .sort()
    .map((account) => claudeProjectsDirIn(profilesRoot, account))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
}

/** The profile's private directory; throws for an id that could leave the root. */
export function credentialProfileRoot(id: string): string {
  if (!isSafeCredentialProfileId(id))
    throw new Error("Invalid credential profile id.");
  const path = resolve(CREDENTIAL_PROFILES_ROOT, id);
  if (!path.startsWith(`${resolve(CREDENTIAL_PROFILES_ROOT)}${"/"}`))
    throw new Error("Invalid credential profile path.");
  return path;
}
