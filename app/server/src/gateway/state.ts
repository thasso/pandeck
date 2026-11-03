/**
 * The gateway's state directory (`docs/workers.md` "Credentials"):
 * `leases.json` and `profiles.json`, each a `{ v: 1, … }` document written
 * whole through the private atomic writer (directory 0700, file 0600, temp
 * file plus rename). Neither holds a token, a lease token or its secret: a
 * lease is saved with its secret's hash, a profile with its token file's path.
 *
 * Both load when the gateway starts, so it forwards with the server down. A
 * missing file is empty. An unreadable file, or one of another version, is
 * logged by name and loaded as empty, so an unreadable `leases.json` refuses
 * every old token. A record that does not validate is skipped and logged the
 * same way. No log line holds file content. The next save replaces the file.
 */
import { join } from "node:path";
import { createPrivateJsonFile } from "../privateJsonFile.ts";
import { isLeaseId, type LeaseOwnership, type LeaseRecord } from "./leases.ts";
import {
  isAbsolutePath,
  isLeaseProvider,
  isProfileId,
  parseProfile,
  type GatewayProfile,
} from "./profiles.ts";
import type { RevokeReason } from "./refusals.ts";

const STATE_VERSION = 1;
const SECRET_HASH_RE = /^[0-9a-f]{64}$/;
const MAX_OWNER_ID_LENGTH = 256;
const REVOKE_REASONS: readonly RevokeReason[] = [
  "profile-removed",
  "account-switch",
  "session-ended",
];

/** A state file could not be written; the control answer says so. */
export class StateWriteError extends Error {}

export interface GatewayState {
  leases: LeaseRecord[];
  profiles: GatewayProfile[];
  persistLeases(records: LeaseRecord[]): void;
  persistProfiles(profiles: GatewayProfile[]): void;
}

/** Whether `value` is a non-empty owner id of bounded length. */
export function isOwnerId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.length <= MAX_OWNER_ID_LENGTH
  );
}

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parseOwnership(
  kind: unknown,
  owner: unknown,
): LeaseOwnership | undefined {
  if (typeof owner !== "object" || owner === null) return undefined;
  const { workerId, sessionId, serverBootId } = owner as Record<
    string,
    unknown
  >;
  if (kind === "engine" && isOwnerId(workerId)) {
    if (sessionId === undefined) return { kind, owner: { workerId } };
    return isOwnerId(sessionId)
      ? { kind, owner: { workerId, sessionId } }
      : undefined;
  }
  if (kind === "server" && isOwnerId(serverBootId))
    return { kind, owner: { serverBootId } };
  return undefined;
}

function parseLeaseRecord(value: unknown): LeaseRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const r = value as Record<string, unknown>;
  const ownership = parseOwnership(r.kind, r.owner);
  if (
    !ownership ||
    !isLeaseId(r.leaseId) ||
    typeof r.secretHash !== "string" ||
    !SECRET_HASH_RE.test(r.secretHash) ||
    !isProfileId(r.profileId) ||
    !isLeaseProvider(r.provider) ||
    !isAbsolutePath(r.tokenFile) ||
    !isTime(r.grantedAt)
  )
    return undefined;
  const record: LeaseRecord = {
    leaseId: r.leaseId,
    secretHash: r.secretHash,
    profileId: r.profileId,
    provider: r.provider,
    tokenFile: r.tokenFile,
    ...ownership,
    grantedAt: r.grantedAt,
  };
  if (r.revoked === undefined && r.revokedAt === undefined) return record;
  if (
    !REVOKE_REASONS.includes(r.revoked as RevokeReason) ||
    !isTime(r.revokedAt)
  )
    return undefined;
  return {
    ...record,
    revoked: r.revoked as RevokeReason,
    revokedAt: r.revokedAt,
  };
}

/**
 * Loads one state file's records, or none when it is unreadable. Duplicate
 * keys keep the first record.
 */
function loadRecords<T>(
  file: ReturnType<typeof createPrivateJsonFile>,
  name: string,
  field: string,
  parse: (value: unknown) => T | undefined,
  key: (record: T) => string,
  log: (line: string) => void,
): T[] {
  let values: unknown[];
  try {
    values = file.read<unknown, unknown[]>((stored) => {
      if (stored === undefined) return [];
      const document = stored as Record<string, unknown> | null;
      const records = document?.[field];
      if (document?.v !== STATE_VERSION || !Array.isArray(records))
        throw new Error("not a version 1 document");
      return records;
    });
  } catch {
    log(`${name} unreadable; starting without it`);
    return [];
  }
  const records = new Map<string, T>();
  let skipped = 0;
  for (const value of values) {
    const record = parse(value);
    if (record === undefined || records.has(key(record))) skipped++;
    else records.set(key(record), record);
  }
  if (skipped > 0)
    log(`${name}: skipped ${skipped} unreadable record(s); loading the rest`);
  return [...records.values()];
}

function writer(
  file: ReturnType<typeof createPrivateJsonFile>,
  name: string,
  field: string,
): (records: unknown[]) => void {
  return (records) => {
    try {
      file.write({ v: STATE_VERSION, [field]: records });
    } catch {
      throw new StateWriteError(`The gateway could not write ${name}.`);
    }
  };
}

/** Loads `stateDir`'s files and returns their writers. */
export function openGatewayState(
  stateDir: string,
  log: (line: string) => void,
): GatewayState {
  const leasesFile = createPrivateJsonFile(
    join(stateDir, "leases.json"),
    "gateway leases",
    { privateDirectory: "enforce" },
  );
  const profilesFile = createPrivateJsonFile(
    join(stateDir, "profiles.json"),
    "gateway profiles",
    { privateDirectory: "enforce" },
  );
  return {
    leases: loadRecords(
      leasesFile,
      "leases.json",
      "leases",
      parseLeaseRecord,
      (record) => record.leaseId,
      log,
    ),
    profiles: loadRecords(
      profilesFile,
      "profiles.json",
      "profiles",
      parseProfile,
      (profile) => profile.id,
      log,
    ),
    persistLeases: writer(leasesFile, "leases.json", "leases"),
    persistProfiles: writer(profilesFile, "profiles.json", "profiles"),
  };
}
