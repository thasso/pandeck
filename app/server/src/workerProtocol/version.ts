/**
 * The worker protocol's version, `major.minor`, separate from the app release
 * (`docs/workers.md`). Adding a method or an optional field bumps the minor;
 * renaming, removing or changing what a method means bumps the major. Two
 * versions work together exactly when their majors are equal.
 */
export const WORKER_PROTOCOL_VERSION = "1.8";

const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/** The major of a well-formed `major.minor`, or undefined. */
function protocolMajor(version: string): number | undefined {
  const match = VERSION.exec(version);
  return match ? Number(match[1]) : undefined;
}

/** Whether a peer speaking `version` can talk to this side. */
export function compatibleProtocolVersion(version: string): boolean {
  const major = protocolMajor(version);
  return (
    major !== undefined && major === protocolMajor(WORKER_PROTOCOL_VERSION)
  );
}
