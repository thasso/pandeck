/**
 * Handing a foreign-owned tree back to the server, using the runtime that took
 * it away (Task 659).
 *
 * A container started with a bind mount and no `--user` runs as uid 0, so
 * whatever it writes into the mounted checkout belongs to root. The server runs
 * as an ordinary user and can then neither chmod nor delete it: a managed
 * worktree becomes unremovable, and the only classic way out is a `sudo` the
 * user has to be told to run.
 *
 * The docker daemon is already effective root, and it is how the files got
 * their owner in the first place. So the repair is one throwaway container that
 * chowns the tree back — no privileged server, no sudo, no credentials.
 *
 * That is a real privilege, so the invariants are narrow and each one is
 * covered by `containerResidue.test.ts`:
 *
 * - The path comes from the APP (a registered worktree row), never from an
 *   agent or a client, and it must resolve inside one of the `allowedRoots` the
 *   caller names. A path that is exactly an allowed root, or outside all of
 *   them, is refused rather than chowned.
 * - The mount is that ONE directory. Nothing else on the host is reachable from
 *   inside, and the container gets no network, no environment and no stdin.
 * - The ownership written is the SERVER'S OWN uid/gid. There is no parameter
 *   for it, so this can never hand a tree to a third user.
 * - It CHOWNS, never deletes. Deletion stays on the host path with its git
 *   guards intact, and a failed reclaim leaves a tree that is merely owned
 *   again.
 * - The DEVICE AND INODE are verified inside the container, after the mount and
 *   before the chown. A path is not an object: between our check and the
 *   daemon's mount, a live agent child (same uid as this server) could rename
 *   the checkout and leave a symlink to `/etc` in its place, and the chown
 *   would land there. So the expected identity travels into the container,
 *   which compares it against the mounted `/target` in the daemon's own
 *   namespace and exits without touching anything on a mismatch.
 *
 *   BOTH numbers are needed, and an inode alone would be a hole: inode numbers
 *   are unique only WITHIN a filesystem, and `/dev`, `/dev/shm`, `/proc`, `/sys`
 *   and `/run` all carry inode 1, while an attacker-writable tmpfs hands out
 *   low, guessable numbers that could be made to collide with the checkout's.
 *   Measured on the real daemon: a bind mount preserves both (`65024 27550826`
 *   on the host, the same inside), and the same-inode decoys keep their own
 *   devices (`6 1` for `/dev`, `32 1` for `/dev/shm`), so the pair separates
 *   them.
 *
 * It is a cleanup step on a removal the user already asked for, so it runs
 * without a separate confirmation.
 */
import { realpathSync, statSync } from "node:fs";
import { relative, isAbsolute, sep } from "node:path";
import {
  containerRuntimeStatus,
  execContainerCommand,
  parseImageRef,
  pullContainerImage,
  redactRegistrySecrets,
} from "./containerImages.ts";
import type { TreeReclaimOutcome } from "./managedTreeRemoval.ts";

/**
 * Small, ubiquitous, and needs nothing but `chown`. Overridable because a host
 * without Docker Hub access has to be able to name an image it already holds.
 */
const DEFAULT_RECLAIM_IMAGE =
  process.env.ASSISTANT_CONTAINER_RECLAIM_IMAGE?.trim() || "alpine:3.22";

/** A `chown -R` over an installed checkout is IO-bound; a minute is plenty. */
const RECLAIM_TIMEOUT_MS = 120_000;

/** Where the tree is mounted inside the throwaway container. */
const MOUNT_TARGET = "/target";

export interface ReclaimContainerResidueOptions {
  /** The directory to hand back; app-derived, never caller-supplied. */
  path: string;
  /** Directories the path must live under, exclusive of the roots themselves. */
  allowedRoots: string[];
  image?: string;
  signal?: AbortSignal;
}

/**
 * Chown one tree back to the server's uid/gid through the container runtime.
 *
 * Never throws: every failure is an `unavailable` outcome whose reason is meant
 * to be shown to the user next to the `sudo` fallback, because a reclaim that
 * cannot run is not an error in the removal that asked for it.
 */
export async function reclaimContainerResidue(
  options: ReclaimContainerResidueOptions,
): Promise<TreeReclaimOutcome> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined)
    return unavailable("this platform has no uid to hand ownership back to");

  const first = resolveTarget(options);
  if ("reason" in first) return unavailable(first.reason);

  let image: string;
  try {
    image = parseImageRef(options.image ?? DEFAULT_RECLAIM_IMAGE).normalized;
  } catch (err) {
    return unavailable(
      `the reclaim image is not a usable reference: ${text(err)}`,
    );
  }

  const runtime = await containerRuntimeStatus(options.signal);
  if (!runtime.available)
    return unavailable(
      `no usable container runtime: ${runtime.reason || "docker is unavailable"}`,
    );
  try {
    await pullContainerImage({
      image,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    return unavailable(
      `the reclaim image ${image} is unavailable: ${text(err)}`,
    );
  }

  // Resolved AGAIN, right before the mount: the runtime probe and the pull are
  // awaits, and the path could have been replaced during them. What the daemon
  // mounts is decided by this resolution and proven by the inode check below.
  const target = resolveTarget(options);
  if ("reason" in target) return unavailable(target.reason);

  try {
    const res = await execContainerCommand({
      args: [
        "run",
        "--rm",
        "--network",
        "none",
        // The chown itself needs root INSIDE the container; the image's own
        // default user is not something this may depend on.
        "--user",
        "0:0",
        "--entrypoint",
        "sh",
        "--volume",
        `${target.path}:${MOUNT_TARGET}`,
        image,
        "-c",
        reclaimScript(target, uid, gid),
      ],
      timeoutMs: RECLAIM_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (res.code === MOUNT_IDENTITY_MISMATCH_EXIT) {
      console.warn(
        `[container] refused to reclaim ${target.path}: it is no longer the directory that was checked.`,
      );
      return unavailable(
        "the directory changed between the check and the mount, so nothing was reclaimed",
      );
    }
    if (res.code !== 0)
      return unavailable(
        `docker could not reclaim ${target.path}: ${firstLine(redactRegistrySecrets(res.stderr || res.stdout)) || `exit ${res.code}`}`,
      );
  } catch (err) {
    return unavailable(`docker could not reclaim ${target.path}: ${text(err)}`);
  }
  console.info(
    `[container] reclaimed ownership of ${target.path} for uid ${uid}:${gid}.`,
  );
  return { status: "reclaimed" };
}

/** What `sh` exits with when the mounted directory is not the one we checked. */
const MOUNT_IDENTITY_MISMATCH_EXIT = 3;

/**
 * Compare the mounted directory's device AND inode with the expected pair
 * BEFORE chowning anything. Either number alone identifies nothing: inodes
 * repeat across filesystems, and a device holds many inodes.
 *
 * Every interpolated value is a number this process computed — `st_dev` and
 * `st_ino` from `statSync`, our own uid and gid — and each is asserted here to
 * be a non-negative integer, so nothing in this string can carry shell syntax.
 */
function reclaimScript(
  identity: TargetIdentity,
  uid: number,
  gid: number,
): string {
  for (const value of [identity.dev, identity.inode, uid, gid])
    if (!Number.isInteger(value) || value < 0)
      throw new Error(`reclaim refuses a non-numeric argument: ${value}`);
  return [
    `test "$(stat -c "%d %i" ${MOUNT_TARGET})" = "${identity.dev} ${identity.inode}" || exit ${MOUNT_IDENTITY_MISMATCH_EXIT}`,
    `exec chown -R ${uid}:${gid} -- ${MOUNT_TARGET}`,
  ].join("\n");
}

/** What the container has to find at the other end of the mount. */
interface TargetIdentity {
  path: string;
  dev: number;
  inode: number;
}

/**
 * Resolve the path and re-check containment, returning the identity the
 * container verifies after the mount.
 */
function resolveTarget(
  options: ReclaimContainerResidueOptions,
): TargetIdentity | { reason: string } {
  let path: string;
  let dev: number;
  let inode: number;
  try {
    path = realpathSync(options.path);
    const stat = statSync(path);
    if (!stat.isDirectory())
      return { reason: "the path to reclaim is not a directory" };
    dev = Number(stat.dev);
    inode = Number(stat.ino);
  } catch (err) {
    return {
      reason: `the path to reclaim could not be resolved: ${text(err)}`,
    };
  }
  if (!containedInAllowedRoot(path, options.allowedRoots))
    return {
      reason: "the path to reclaim is not inside a managed worktree root",
    };
  return { path, dev, inode };
}

/**
 * Strictly INSIDE one of the roots. A path equal to a root would mount the
 * directory every worktree of that project lives in, which is never what a
 * single removal is cleaning up.
 */
function containedInAllowedRoot(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    let resolved: string;
    try {
      resolved = realpathSync(root);
    } catch {
      return false;
    }
    const rel = relative(resolved, target);
    return (
      rel !== "" &&
      !rel.startsWith(`..${sep}`) &&
      rel !== ".." &&
      !isAbsolute(rel)
    );
  });
}

function unavailable(reason: string): TreeReclaimOutcome {
  return { status: "unavailable", reason };
}

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}
