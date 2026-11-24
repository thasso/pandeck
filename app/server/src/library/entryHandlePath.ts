/**
 * Paths to an OPEN inode, never to the name it was opened through.
 *
 * Linux procfs follows a descriptor. macOS volfs addresses a device/inode pair;
 * the caller's live FileHandle pins that inode so its number cannot be reused.
 * Neither path changes when a library directory is renamed or replaced. macOS
 * /dev/fd is NOT a directory traversal anchor and must not be used here.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, type FileHandle } from "node:fs/promises";

/**
 * Linux O_PATH and Darwin O_EVTONLY pin without data I/O. On Darwin O_SYMLINK
 * opens the symlink itself, and must NOT be combined with O_NOFOLLOW.
 * Node exports neither O_PATH nor O_EVTONLY.
 */
export const ENTRY_PIN_FLAGS =
  process.platform === "darwin"
    ? 0x8000 | fsConstants.O_SYMLINK | fsConstants.O_NONBLOCK
    : 0o010000000 | fsConstants.O_NOFOLLOW;

const anchors = new WeakMap<FileHandle, string>();

/** Fail clearly at the library boundary, not as a misleading missing manifest. */
export async function verifyLibraryAnchor(handle: FileHandle): Promise<void> {
  if (process.platform !== "darwin") return;
  // Resource, permission and interrupted-read failures are not evidence that
  // the filesystem lacks volfs. Keep fstat errors outside the lstat classifier.
  const expected = await handle.stat();
  const path = await entryHandlePath(handle);
  const unsupported = () =>
    new Error(
      "This macOS filesystem does not support inode-anchored library access (volfs). Move the agents/skills library to a supported local volume.",
    );
  let actual;
  try {
    actual = await lstat(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOTDIR"].includes(
        String(error.code),
      )
    ) {
      throw unsupported();
    }
    throw error;
  }
  if (
    !actual.isDirectory() ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw unsupported();
  }
}

/** The caller must keep the handle open until all uses of this path finish. */
export async function entryHandlePath(handle: FileHandle): Promise<string> {
  if (process.platform === "linux") return `/proc/self/fd/${handle.fd}`;
  if (process.platform !== "darwin") {
    throw new Error(
      `Anchored library access is unsupported on ${process.platform}.`,
    );
  }
  const cached = anchors.get(handle);
  if (cached) return cached;
  const { dev, ino } = await handle.stat();
  const path = `/.vol/${dev}/${ino}`;
  anchors.set(handle, path);
  return path;
}
