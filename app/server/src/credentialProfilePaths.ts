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

/** The profile's private directory; throws for an id that could leave the root. */
export function credentialProfileRoot(id: string): string {
  if (!isSafeCredentialProfileId(id))
    throw new Error("Invalid credential profile id.");
  const path = resolve(CREDENTIAL_PROFILES_ROOT, id);
  if (!path.startsWith(`${resolve(CREDENTIAL_PROFILES_ROOT)}${"/"}`))
    throw new Error("Invalid credential profile path.");
  return path;
}
