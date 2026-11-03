/**
 * The gateway's profile registry (`docs/workers.md` "Credentials"): the
 * accounts the server syncs over control, each naming its provider and token
 * file. A grant binds its lease from here, never from the request (C5).
 *
 * `enabled` and `name` are recorded and never enforced: disabling an account
 * takes effect at the server's next turn, so the gateway never ends a running
 * one for it. Only removing a profile revokes its leases, which the control
 * endpoint does.
 */
import { isAbsolute } from "node:path";
import type { LeaseProvider } from "./leases.ts";

export interface GatewayProfile {
  id: string;
  provider: LeaseProvider;
  name: string;
  enabled: boolean;
  /** Absolute path of the profile's token file. */
  tokenFile: string;
}

const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME_LENGTH = 200;
const MAX_PATH_LENGTH = 4096;

export function isProfileId(value: unknown): value is string {
  return typeof value === "string" && PROFILE_ID_RE.test(value);
}

export function isLeaseProvider(value: unknown): value is LeaseProvider {
  return value === "claude" || value === "openai-codex";
}

/** Whether `value` is a well-formed absolute path of bounded length. */
export function isAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_PATH_LENGTH &&
    !value.includes("\0") &&
    isAbsolute(value)
  );
}

/** A profile from the wire or the state file, or undefined when malformed. */
export function parseProfile(value: unknown): GatewayProfile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const { id, provider, name, enabled, tokenFile } = value as Record<
    string,
    unknown
  >;
  if (
    !isProfileId(id) ||
    !isLeaseProvider(provider) ||
    typeof name !== "string" ||
    name.length > MAX_NAME_LENGTH ||
    typeof enabled !== "boolean" ||
    !isAbsolutePath(tokenFile)
  )
    return undefined;
  return { id, provider, name, enabled, tokenFile };
}

/**
 * The registry, keyed by profile id. With `persist`, every change is saved
 * after it takes effect in memory; a change stays in memory when saving
 * throws, and the server's next sync settles both.
 */
export class ProfileRegistry {
  private readonly profiles = new Map<string, GatewayProfile>();

  constructor(
    private readonly persist?: (profiles: GatewayProfile[]) => void,
  ) {}

  /** Loads saved profiles into an empty registry, without saving. */
  restore(profiles: readonly GatewayProfile[]): void {
    for (const profile of profiles)
      this.profiles.set(profile.id, { ...profile });
  }

  /** Replaces every profile. */
  sync(profiles: readonly GatewayProfile[]): void {
    this.profiles.clear();
    this.restore(profiles);
    this.save();
  }

  upsert(profile: GatewayProfile): void {
    this.profiles.set(profile.id, { ...profile });
    this.save();
  }

  remove(id: string): void {
    if (this.profiles.delete(id)) this.save();
  }

  get(id: string): GatewayProfile | undefined {
    const profile = this.profiles.get(id);
    return profile ? { ...profile } : undefined;
  }

  has(id: string): boolean {
    return this.profiles.has(id);
  }

  private save(): void {
    this.persist?.([...this.profiles.values()].map((p) => ({ ...p })));
  }
}
