/**
 * Anchored, no-follow access to one skill's source files
 * ([Task-614](pa://task/614), `docs/skills.md`).
 *
 * This is the ONE way the library's bytes are reached, by the scan and by the
 * single-skill read alike. Both used to resolve a pathname twice — once to
 * check what was there, once to read it — and a pathname is not a thing but a
 * question the kernel re-answers every time it is asked. Between the two
 * answers a user script, a `git checkout`, or an attacker can replace `SKILL.md`
 * or its folder with a symlink, and the second answer is then a file outside the
 * library. A stress run reproduced exactly that: an outside file's frontmatter
 * appeared in a scan as a valid summary with no diagnostic.
 *
 * So the path is resolved ONCE. The library root is opened, each component
 * below it is opened relative to that descriptor through `/proc/self/fd` with
 * `O_NOFOLLOW`, and every subsequent operation — the identity `fstat`, the read
 * — goes to the open file description. A swap that lands after the open cannot
 * change which inode answers, and one that lands before it is refused rather
 * than followed. Identity therefore comes from the same handle the content
 * does, which is what makes a scan's recorded `dev`/`ino` worth comparing
 * against later.
 *
 * `O_NONBLOCK` is part of that safety, not a performance choice: opening a FIFO
 * for reading blocks until a writer arrives, so without it a named pipe left
 * where `SKILL.md` belongs would hang a scan or an HTTP read indefinitely. The
 * handle is checked for being a regular file before anything is read from it.
 *
 * The `/proc/self/fd` anchor makes this Linux-only by construction, which is
 * what the app deploys on; there is no silent pathname fallback, because a
 * fallback would be the very re-resolution this module exists to remove.
 */
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  opendir,
  readlink,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";

const PROC_FD = "/proc/self/fd";
const ROOT_DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY;
/**
 * Deliberately WITHOUT `O_DIRECTORY`: Linux answers `O_DIRECTORY|O_NOFOLLOW` on
 * a symlink with `ENOTDIR`, which would report a linked folder as an ordinary
 * unreadable entry and lose the one diagnostic that tells the user why their
 * link is not a skill. Opened plainly, a symlink is `ELOOP` and anything that is
 * not a directory is caught by the `fstat` below instead.
 */
const SOURCE_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
/**
 * Creating or replacing one authored file. `O_NOFOLLOW` is the same refusal the
 * read flags make: a tool never writes THROUGH a link, so a supporting file
 * that has been replaced by a symlink is a refusal rather than a write outside
 * the library.
 */
/** Reading and rewriting ONE already-open inode, never a re-resolved name. */
const UPDATE_FLAGS =
  fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
/** Create-or-fail: the file must not exist, which is the whole point. */
const EXCLUSIVE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  fsConstants.O_NOFOLLOW |
  fsConstants.O_NONBLOCK;
const WRITE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_TRUNC |
  fsConstants.O_NOFOLLOW |
  fsConstants.O_NONBLOCK;
/**
 * `O_PATH`: a descriptor that refers to an inode WITHOUT opening it for I/O.
 *
 * Node does not export the constant (it is Linux-only, like the `/proc/self/fd`
 * anchoring this whole module is built on), so it is spelled out here. It is the
 * one open that works on every kind of entry: a symlink can be pinned with
 * `O_PATH|O_NOFOLLOW`, where an ordinary open answers `ELOOP`, and a directory
 * stays usable as an anchor through `/proc/self/fd`. `fstat` is permitted on
 * it, which is all a pin is ever asked for.
 */
const O_PATH = 0o010000000;
/** Pinning an inode reached through a NAME: never through a link. */
const PIN_FLAGS = O_PATH | fsConstants.O_NOFOLLOW;

/** The one file a skill folder is recognized by. */
export const SKILL_FILE_NAME = "SKILL.md";

interface FileIdentity {
  dev: number;
  ino: number;
}

/**
 * What a scan observed, and what a later read must still find. Recorded from
 * the open handles rather than from a pathname, so it names the inodes that
 * actually answered.
 */
export interface SkillSourceIdentity {
  folder: FileIdentity;
  file: FileIdentity;
}

/** A source folder or `SKILL.md` that is a symlink; refused, never followed. */
export class SymlinkedSkillSourceError extends Error {}

/**
 * A source entry that exists but is not a directory or regular file. Exported
 * so the supporting-file tree can distinguish an irregular entry from a
 * transient unreadable or deleted entry and report the right diagnostic.
 */
export class IrregularSkillSourceError extends Error {}

export interface SkillSource {
  /** The open source folder, used for anchored supporting-file traversal. */
  folder: FileHandle;
  /** The open `SKILL.md`: the only place content is ever read from. */
  file: FileHandle;
  /** The identity of the folder and file these handles are open on. */
  identity: SkillSourceIdentity;
  /** Size of the open file, from the same `fstat` the identity came from. */
  size: number;
}

/**
 * Open the library root and hold it for the duration of `use`.
 *
 * A whole scan anchors on one root descriptor: every folder below is opened
 * relative to it, so replacing the root directory itself mid-scan cannot move
 * the scan into another tree.
 */
export async function withLibraryRoot<T>(
  root: string,
  use: (rootHandle: FileHandle) => Promise<T>,
): Promise<T> {
  const rootHandle = await open(root, ROOT_DIRECTORY_FLAGS);
  try {
    return await use(rootHandle);
  } finally {
    await closeQuietly(rootHandle);
  }
}

/**
 * Open `<folder>/SKILL.md` beneath an open library root and hand the caller the
 * live handle. Both handles are closed when `use` settles, so a caller must
 * finish reading inside it.
 *
 * Throws {@link SymlinkedSkillSourceError} when either component is a symlink,
 * {@link IrregularSkillSourceError} when either exists but is the wrong kind of
 * file, and the raw `ENOENT`/`ENOTDIR` node error when a component is gone.
 */
export async function withSkillSource<T>(
  rootHandle: FileHandle,
  folder: string,
  use: (source: SkillSource) => Promise<T>,
): Promise<T> {
  let folderHandle: FileHandle | undefined;
  let fileHandle: FileHandle | undefined;
  try {
    folderHandle = await openAnchored(
      `${PROC_FD}/${rootHandle.fd}/${folder}`,
      SOURCE_FLAGS,
    );
    const folderStat = await folderHandle.stat();
    if (!folderStat.isDirectory()) {
      throw new IrregularSkillSourceError("source folder is not a directory");
    }

    fileHandle = await openAnchored(
      `${PROC_FD}/${folderHandle.fd}/${SKILL_FILE_NAME}`,
      SOURCE_FLAGS,
    );
    const fileStat = await fileHandle.stat();
    if (!fileStat.isFile()) {
      throw new IrregularSkillSourceError(
        `${SKILL_FILE_NAME} is not a regular file`,
      );
    }

    return await use({
      folder: folderHandle,
      file: fileHandle,
      identity: {
        folder: { dev: folderStat.dev, ino: folderStat.ino },
        file: { dev: fileStat.dev, ino: fileStat.ino },
      },
      size: fileStat.size,
    });
  } finally {
    await closeQuietly(fileHandle);
    await closeQuietly(folderHandle);
  }
}

/**
 * Read one open skill directory without re-resolving the library pathname.
 * Names are sorted by the caller because directory iteration order is not a
 * filesystem contract.
 */
export async function readSkillDirectory(directory: FileHandle) {
  return readdir(`${PROC_FD}/${directory.fd}`, { withFileTypes: true });
}

/**
 * Iterate one open skill directory LAZILY, holding only a small buffer of
 * entries at a time.
 *
 * `readdir` materializes every name before the caller can look at one, so a
 * caller with a bound of its own cannot apply it to the read itself: a
 * hand-authored folder with a million siblings would be built into an array
 * before the first refusal. This reads through `opendir`, so a caller that
 * stops early has read only what it looked at. The iterator closes the
 * directory when it is left, by exhaustion, `break` or throw alike.
 */
export function iterateSkillDirectory(
  directory: FileHandle,
): AsyncIterable<Dirent> {
  return {
    async *[Symbol.asyncIterator]() {
      const dir = await opendir(`${PROC_FD}/${directory.fd}`, {
        bufferSize: DIRECTORY_BUFFER_ENTRIES,
      });
      yield* dir;
    },
  };
}

/** How many directory entries one lazy read holds at a time. */
const DIRECTORY_BUFFER_ENTRIES = 32;

/**
 * Open one already-validated child beneath an open skill directory with
 * no-follow semantics and keep the handle live through `use`.
 */
export async function withSkillChild<T>(
  directory: FileHandle,
  name: string,
  use: (child: {
    handle: FileHandle;
    size: number;
    directory: boolean;
  }) => Promise<T>,
): Promise<T> {
  assertPathComponent(name);
  const handle = await openAnchored(
    `${PROC_FD}/${directory.fd}/${name}`,
    SOURCE_FLAGS,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new IrregularSkillSourceError(
        "skill entry is not a regular file or directory",
      );
    }
    return await use({
      handle,
      size: stats.size,
      directory: stats.isDirectory(),
    });
  } finally {
    await closeQuietly(handle);
  }
}

/**
 * Anchored authoring ([Task-633](pa://task/633)). The agent tools write through
 * the SAME open-directory anchor the reads use: a path a tool was given is
 * resolved once, below a descriptor the caller already holds, so a component
 * swapped for a link between validation and write is refused instead of
 * followed. Nothing here creates a symlink, and nothing writes through one.
 */

/**
 * Create one child directory, or accept an existing regular directory. Returns
 * whether THIS call created it, which is how a caller knows the directory is
 * its own to remove if the mutation is rolled back.
 */
export async function ensureSkillChildDirectory(
  directory: FileHandle,
  name: string,
): Promise<SkillPin | undefined> {
  assertPathComponent(name);
  try {
    await mkdir(`${PROC_FD}/${directory.fd}/${name}`);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    // An existing child must be a real directory: `mkdir` reports a symlink as
    // EEXIST too, and descending into it would leave the library.
    await withSkillChild(directory, name, async (child) => {
      if (!child.directory) {
        throw new IrregularSkillSourceError(
          `"${name}" already exists and is not a directory`,
        );
      }
    });
    return undefined;
  }
  // Created by THIS call, so it is this mutation's to take back — and pinned,
  // because the undo that may do so runs after the commit was refused, when a
  // recorded inode number would fit a directory somebody else recreated here
  // just as well as this one. If pinning itself fails, take the empty creation
  // back now; otherwise no caller can register ownership-aware rollback for it.
  return pinCreatedSkillChildDirectory(directory, name);
}

async function pinCreatedSkillChildDirectory(
  directory: FileHandle,
  name: string,
): Promise<SkillPin> {
  try {
    return await pinSkillChild(directory, name);
  } catch (error) {
    await rmdir(`${PROC_FD}/${directory.fd}/${name}`).catch(() => undefined);
    throw error;
  }
}

/**
 * Create or replace one regular file beneath an open directory. Returns a pin
 * when this call CREATED the file, and nothing when it replaced one.
 *
 * The difference decides who may undo it. A file that was already there is
 * Git's to restore, from the content it has committed. A file this call brought
 * into existence is not in HEAD at all, so nothing but this mutation can take
 * it back — and it may only do so while it is still the inode created here,
 * which is what the pin is for. Creating is therefore attempted with
 * `O_CREAT|O_EXCL` FIRST, so the answer is the kernel's rather than a probe's.
 */
export async function writeSkillChildFile(
  directory: FileHandle,
  name: string,
  content: Uint8Array,
  /**
   * Called the moment this file's content is committed to changing, which is
   * the creating or truncating OPEN and not the write: a caller that has to
   * undo its own work needs to know the difference between "the open was
   * refused, nothing happened here" and "the bytes are already gone".
   */
  onTruncated?: () => void,
): Promise<SkillPin | undefined> {
  assertPathComponent(name);
  const created = await open(
    `${PROC_FD}/${directory.fd}/${name}`,
    EXCLUSIVE_FLAGS,
    0o644,
  ).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "EEXIST") return undefined;
    throw error;
  });
  if (created) {
    onTruncated?.();
    try {
      await created.writeFile(content);
      return await pinSkillHandle(created);
    } catch (error) {
      await unlinkCreatedChild(directory, name, created);
      throw error;
    } finally {
      await closeQuietly(created);
    }
  }
  const handle = await openAnchored(
    `${PROC_FD}/${directory.fd}/${name}`,
    WRITE_FLAGS,
    0o644,
  );
  onTruncated?.();
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new IrregularSkillSourceError(`"${name}" is not a regular file`);
    }
    await handle.writeFile(content);
    return undefined;
  } finally {
    await closeQuietly(handle);
  }
}

/**
 * Remove one regular file beneath an open directory; never a link or folder.
 *
 * Delegates to {@link unlinkSkillChildIfSame}, which is where the actual rule
 * lives: what gets destroyed is an inode this call verified, never whatever
 * holds a public name at the moment of the syscall.
 */
export async function removeSkillChildFile(
  directory: FileHandle,
  name: string,
): Promise<void> {
  assertPathComponent(name);
  // The whole removal happens while the file is OPEN. That is not incidental:
  // an inode NUMBER is reused the instant a file is deleted and another created
  // (measured on this filesystem), so comparing numbers only means something
  // while the original is pinned — an open descriptor guarantees that whatever
  // takes the name in the meantime is a different number.
  const removed = await withSkillChild(directory, name, async (child) => {
    if (child.directory) {
      throw new IrregularSkillSourceError(`"${name}" is a directory`);
    }
    return unlinkSkillChildIfSame(
      directory,
      name,
      await skillHandleIdentity(child.handle),
    );
  });
  if (!removed) {
    throw new IrregularSkillSourceError(
      `"${name}" changed while it was being removed`,
    );
  }
}

/**
 * Remove one child ONLY if it is still the inode the caller recorded, and
 * report whether it was.
 *
 * `unlink` takes a NAME, and the kernel offers no "unlink this inode", so an
 * `lstat` followed by an `unlink` of the same name is a guess: the name can be
 * something else by the time the second call runs, and that something else is
 * what would be destroyed. The name is therefore moved aside FIRST, to one this
 * call invents. Only then is it examined, and only then — under a name nothing
 * else addresses — is it unlinked.
 *
 * The caller must keep `expected` PINNED — by an open descriptor or by a second
 * hard link — for the comparison to mean anything: an inode number alone is
 * reused the moment its file is deleted, so an unpinned number can be matched
 * by a stranger's file. The rename pins by linking the file to the new name
 * before it drops the old one; {@link removeSkillChildFile} pins by holding it
 * open.
 *
 * A mismatch is put back: with `link` for anything that is not a directory,
 * because `link` refuses an occupied name and a `rename` would replace whatever
 * had appeared there, and with `rename` for a directory, which cannot be
 * linked. What cannot be put back is left under its private name and named in
 * the error, which the mutation's status check then reports.
 */
export async function unlinkSkillChildIfSame(
  directory: FileHandle,
  name: string,
  expected: { dev: number; ino: number },
  /**
   * Whether the entry still holds the CONTENT the caller means to take back.
   *
   * Given for anything whose bytes can change without its inode changing, which
   * is every regular file: an in-place rewrite keeps the number, and metadata
   * is no substitute — a size can be matched and an mtime can be restored with
   * `utimes`. The check runs on the entry under its PRIVATE name, where nothing
   * else can address it any more, so what it reads is what would be unlinked. A
   * symlink needs none: its target cannot change without the inode changing
   * with it.
   */
  holdsExpected?: (handle: FileHandle) => Promise<boolean>,
): Promise<boolean> {
  assertPathComponent(name);
  const aside = `.pa-skill-removing-${randomUUID()}`;
  try {
    await rename(
      `${PROC_FD}/${directory.fd}/${name}`,
      `${PROC_FD}/${directory.fd}/${aside}`,
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }

  const asidePath = `${PROC_FD}/${directory.fd}/${aside}`;
  const moved = await lstatQuietly(asidePath);
  if (moved && moved.dev === expected.dev && moved.ino === expected.ino) {
    // Read through a descriptor on the entry as it stands under the private
    // name — the only place where "what this check says" and "what gets
    // unlinked" cannot come apart by NAME. It can still come apart by
    // DESCRIPTOR: a writer holding this inode open from before the detach is
    // not stopped by the private name. So the check is bracketed by the
    // inode's own `ctime`, which every write moves and which `utimes` cannot
    // put back, and the `unlink` follows the second reading immediately, with
    // no read between them. What remains is a write landing inside that one
    // syscall gap, which POSIX offers no way to exclude: there is no
    // compare-and-unlink, and `unlinkat` takes no "only if unchanged" flag.
    const holds =
      holdsExpected === undefined ||
      (await withSkillChild(directory, aside, (child) =>
        holdsExpected(child.handle),
      ).catch(() => false));
    const still = holds ? await lstatQuietly(asidePath) : undefined;
    if (
      still &&
      still.dev === expected.dev &&
      still.ino === expected.ino &&
      still.changed === moved.changed
    ) {
      await unlink(asidePath);
      return true;
    }
  }
  await restoreDetachedChild(directory, aside, name, moved?.directory === true);
  return false;
}

async function restoreDetachedChild(
  directory: FileHandle,
  aside: string,
  name: string,
  isDirectory: boolean,
): Promise<void> {
  try {
    if (isDirectory) {
      await restoreDetachedDirectory(directory, aside, name);
      return;
    }
    await link(
      `${PROC_FD}/${directory.fd}/${aside}`,
      `${PROC_FD}/${directory.fd}/${name}`,
    );
    await unlink(`${PROC_FD}/${directory.fd}/${aside}`);
  } catch (error) {
    throw new IrregularSkillSourceError(
      `"${name}" changed while it was being removed, and what was moved aside could not be put back (${
        isNodeError(error) ? error.code : String(error)
      }); it is at "${aside}" in the same folder`,
    );
  }
}

/**
 * Put a moved-aside DIRECTORY back without replacing anything.
 *
 * A directory cannot be hard-linked, so a `rename` back is the obvious restore
 * — and it replaces an empty directory that appeared at the name meanwhile,
 * which is undoing one accident by causing another. The tree is therefore
 * REASSEMBLED at the name instead, out of the same create-or-fail calls a
 * rename uses: `mkdir` claims the name or fails, and every file below is hard-
 * linked across, so the restored tree holds the very same inodes. The emptied
 * aside is then removed under its private name.
 *
 * When the name is taken, nothing is forced: the tree stays under the aside and
 * the caller reports where it is.
 */
async function restoreDetachedDirectory(
  directory: FileHandle,
  aside: string,
  name: string,
): Promise<void> {
  await mkdir(`${PROC_FD}/${directory.fd}/${name}`);
  // In passes, because the aside is not sealed: a hand author holding it open
  // from before the detach can create in it while this runs, and an entry that
  // appeared after the relink walk was never linked to the public name. Each
  // pass links what it finds and then removes ONLY what it linked, so the
  // content of anything it drops still lives at the public name. A pass that
  // finds nothing new ends it; a racer that keeps adding ends at the bound, and
  // what is left stays under the aside for the caller to name.
  for (let pass = 0; pass < MAX_RESTORE_PASSES; pass += 1) {
    const linked = new Map<string, { dev: number; ino: number }>();
    await withSkillChild(directory, aside, (moved) =>
      withSkillChild(directory, name, (restored) =>
        relinkSkillTree(moved.handle, restored.handle, linked),
      ),
    );
    if (linked.size === 0) break;
    await withSkillChild(directory, aside, (moved) =>
      clearLinkedAside(moved.handle, linked),
    );
  }
  await rmdir(`${PROC_FD}/${directory.fd}/${aside}`);
}

/** How many times a restore will chase entries appearing under the aside. */
const MAX_RESTORE_PASSES = 4;

/**
 * Empty an aside of exactly the entries a relink pass carried across.
 *
 * The proof is the INODE, and here that is the whole of it: what is unlinked is
 * a second link to a file that is now also at the public name, so its content
 * survives the removal whatever it holds. Anything else — an entry created
 * after the relink walk passed — is left, which is what keeps the aside
 * non-empty and stops the `rmdir` that would otherwise hide it.
 */
async function clearLinkedAside(
  directory: FileHandle,
  linked: ReadonlyMap<string, { dev: number; ino: number }>,
  prefix = "",
): Promise<void> {
  for (const entry of await readSkillDirectory(directory)) {
    const path = `${PROC_FD}/${directory.fd}/${entry.name}`;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await withSkillChild(directory, entry.name, async (child) => {
        if (child.directory) {
          await clearLinkedAside(child.handle, linked, relative);
        }
      });
      // Only when nothing was left in it, which `rmdir` decides for itself.
      await rmdir(path).catch(() => undefined);
      continue;
    }
    const carried = linked.get(relative);
    const current = await lstatQuietly(path);
    if (
      carried &&
      current &&
      current.dev === carried.dev &&
      current.ino === carried.ino
    ) {
      await unlink(path);
    }
  }
}

/** Recreate one tree under another open directory, linking every file across. */
async function relinkSkillTree(
  from: FileHandle,
  to: FileHandle,
  /** Records what each pass carried across, so the aside is emptied of that. */
  linked: Map<string, { dev: number; ino: number }>,
  prefix = "",
): Promise<void> {
  for (const entry of await readSkillDirectory(from)) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // `EEXIST` here is this restore's own earlier pass, never somebody else's
      // directory: the public name itself was claimed by a `mkdir` that refuses
      // an occupied name, so everything below it was made by this restore.
      await mkdir(`${PROC_FD}/${to.fd}/${entry.name}`).catch(
        (error: unknown) => {
          if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        },
      );
      await withSkillChild(from, entry.name, (child) =>
        withSkillChild(to, entry.name, (target) =>
          relinkSkillTree(child.handle, target.handle, linked, relative),
        ),
      );
      continue;
    }
    await link(
      `${PROC_FD}/${from.fd}/${entry.name}`,
      `${PROC_FD}/${to.fd}/${entry.name}`,
    );
    const carried = await lstatQuietly(`${PROC_FD}/${to.fd}/${entry.name}`);
    if (carried) linked.set(relative, { dev: carried.dev, ino: carried.ino });
  }
}

async function lstatQuietly(path: string): Promise<
  | {
      dev: number;
      ino: number;
      directory: boolean;
      /** `ctime`: moved by every write, and not settable backwards. */
      changed: bigint;
    }
  | undefined
> {
  try {
    const stats = await lstat(path, { bigint: true });
    return {
      dev: Number(stats.dev),
      ino: Number(stats.ino),
      directory: (stats.mode & BigInt(0o170000)) === BigInt(0o040000),
      changed: stats.ctimeNs,
    };
  } catch {
    return undefined;
  }
}

/**
 * Empty one open directory through its OWN descriptor, then let the caller
 * remove the now-empty name.
 *
 * This is what binds a recursive delete to the inode the caller verified: every
 * child is opened below the handle that was checked, so a directory swapped in
 * behind the pathname afterwards cannot be descended into, and nothing outside
 * the verified tree is reachable. Symlinks are unlinked, never followed.
 */
async function clearSkillDirectory(
  directory: FileHandle,
  /** Called the first time anything is actually gone, so a failure halfway
   * through can be reported as the partial removal it is. */
  onRemoved: () => void,
  /**
   * What each file's `ctime` was when its CONTENT was proved, by tree-relative
   * path.
   *
   * Proving a tree and emptying it are two walks, and the first can take
   * arbitrarily long — one large sibling is enough to make it so. A writer who
   * already holds an early file open can therefore rewrite it after its proof
   * and before its unlink, and nothing in the second walk would notice. Each
   * unlink is preceded by one `lstat` against the value recorded here, so the
   * only gap left is between that reading and the `unlink` next to it.
   */
  proved?: ReadonlyMap<string, bigint>,
  prefix = "",
): Promise<void> {
  // The directory's OWN reading first, before anything in it is listed. Adding
  // an entry moves a directory's `ctime`, so this is what catches a file that
  // appeared after the proof walk passed — a hand author holding this directory
  // open from before the detach can still create in it, and the private name
  // stops opens by name, not that.
  if (proved !== undefined) {
    await mustStillHold(prefix, proved, await selfChangedAt(directory));
  }
  for (const entry of await readSkillDirectory(directory)) {
    const path = `${PROC_FD}/${directory.fd}/${entry.name}`;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await withSkillChild(directory, entry.name, async (child) => {
        if (!child.directory) {
          // It changed kind between the listing and the open; the unlink below
          // is then the right removal for whatever it now is.
          return;
        }
        await clearSkillDirectory(child.handle, onRemoved, proved, relative);
      });
      await rmdir(path);
      onRemoved();
      continue;
    }
    if (proved !== undefined) {
      // Every entry must answer, and an entry with NO reading recorded answers
      // loudest: it was not there when the tree was proved, so it is not this
      // removal's to take. "Nothing was recorded" and "nothing needs checking"
      // are not the same thing, and treating them alike is how a file created
      // in the proof-to-clear window got unlinked.
      await mustStillHold(
        relative,
        proved,
        (await lstatQuietly(path))?.changed,
      );
    }
    // A regular file, a symlink, or any other non-directory entry: `unlink`
    // removes the NAME, so a link is destroyed rather than its target.
    await unlink(path);
    onRemoved();
  }
}

/** Refuse unless this entry reads exactly as it did when it was proved. */
async function mustStillHold(
  relative: string,
  proved: ReadonlyMap<string, bigint>,
  changed: bigint | undefined,
): Promise<void> {
  const provedAt = proved.get(relative);
  if (provedAt === undefined || changed === undefined || changed !== provedAt) {
    throw new SkillContentChangedError(relative || ".");
  }
}

/** A directory's own `ctime`, read through the descriptor rather than a name. */
async function selfChangedAt(
  directory: FileHandle,
): Promise<bigint | undefined> {
  try {
    return (await directory.stat({ bigint: true })).ctimeNs;
  } catch {
    return undefined;
  }
}

/** One entry changed between the proof of its content and its removal. */
class SkillContentChangedError extends Error {
  constructor(readonly entry: string) {
    super(`"${entry}" changed after its content was checked`);
  }
}

/**
 * Reserve a top-level name with `mkdir` and hold the created directory open.
 *
 * `mkdir` cannot overwrite, so the reservation fails when ANY entry already
 * holds the name. What it cannot do is hand back a descriptor: there is no
 * "make a directory and open it" syscall, so between the `mkdir` and the `open`
 * a hand author can remove the new directory and put their own there, and this
 * function would then be holding THEIRS.
 *
 * Two things bound that. The directory must be EMPTY when it is opened, so an
 * adopted directory can never be one with content in it — writing a skill into
 * a user's populated folder, silently replacing same-named files, is the one
 * outcome that must be impossible. And the handle is the ONLY way anything is
 * written here: callers never re-open the name, so what they write goes into
 * the inode this checked, whatever happens to the name afterwards.
 *
 * Holding it open also pins the inode, which is what makes a later identity
 * comparison meaningful — an inode number alone is reusable the instant a
 * directory is removed.
 */
export async function withReservedSkillFolder<T>(
  rootHandle: FileHandle,
  folder: string,
  use: (reserved: {
    handle: FileHandle;
    identity: { dev: number; ino: number };
  }) => Promise<T>,
): Promise<T | null> {
  assertPathComponent(folder);
  try {
    await mkdir(`${PROC_FD}/${rootHandle.fd}/${folder}`);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return null;
    throw error;
  }
  // Everything between the `mkdir` and handing the reservation to the caller
  // can still fail — the open needs a descriptor, the emptiness check a read —
  // and until the caller HAS it, nothing has registered the name with the
  // commit or with a rollback. An empty directory is also invisible to Git
  // status, so a failure here would leave it behind silently. It is therefore
  // taken back on the spot, with `rmdir`, which refuses a directory anything
  // was put into in the meantime.
  let handedOver = false;
  try {
    return await withSkillChild(rootHandle, folder, async (child) => {
      if (!child.directory) {
        throw new IrregularSkillSourceError(
          `"${folder}" is not a directory just after it was created`,
        );
      }
      if ((await readSkillDirectory(child.handle)).length > 0) {
        throw new IrregularSkillSourceError(
          `"${folder}" was replaced by a directory with content just after it was created`,
        );
      }
      const identity = await skillHandleIdentity(child.handle);
      handedOver = true;
      return use({ handle: child.handle, identity });
    });
  } catch (error) {
    // Once the caller has run, the undo is the caller's: it knows what it put
    // in the folder and holds the pins that prove it.
    if (!handedOver) {
      await rmdir(`${PROC_FD}/${rootHandle.fd}/${folder}`).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

/**
 * The no-replace placement primitives ([Task-633](pa://task/633)).
 *
 * POSIX `rename` REPLACES its destination, and this runtime cannot reach
 * `renameat2(RENAME_NOREPLACE)`, so a check followed by a rename is not a
 * collision guarantee — it is a guess with a window in it. Every primitive
 * below fails with `EEXIST` instead: `mkdir`, `link` and `O_CREAT|O_EXCL` are
 * create-or-fail in one syscall. A tree assembled out of only these can never
 * take a name that something else already holds, whatever happens between the
 * calls.
 *
 * `link` also makes the placement free and provable: the new name is the SAME
 * inode, so no bytes are copied, and "did this call create that name?" is
 * answered later by comparing inodes rather than by trusting a path.
 */

/** A name that is already taken. Refused, never replaced. */
export class SkillNameTakenError extends Error {}

/**
 * An inode this process has PINNED, and the identity that pin makes meaningful.
 *
 * `dev`/`ino` alone prove nothing across time: the kernel hands a freed inode
 * number straight back to the next entry created, so a file removed and
 * recreated under the same name compares EQUAL to the one that is gone
 * (measured, for files and for directories alike). An open descriptor is what
 * makes the number an identity — while it is held the inode cannot be freed, so
 * no replacement can ever be given that number, and "the name still resolves to
 * this identity" therefore means "this is still the entry we created".
 *
 * A mutation pins everything it creates and keeps the pins until its commit has
 * settled, because that is when its undo needs the answer. `handle` carries no
 * I/O rights ({@link O_PATH}); it exists only to hold the number.
 */
export interface SkillPin {
  handle: FileHandle;
  identity: { dev: number; ino: number };
}

/** Pin the inode an open handle already refers to, resolving no name at all. */
export async function pinSkillHandle(handle: FileHandle): Promise<SkillPin> {
  // The magic link under `/proc/self/fd` resolves to the inode the descriptor
  // holds, not by walking the path it was opened through, so nothing that
  // happened to its NAME since can redirect this. Deliberately without
  // `O_NOFOLLOW`, which would refuse the magic link itself (`ELOOP`).
  return pinnedFrom(await open(`${PROC_FD}/${handle.fd}`, O_PATH));
}

/** Pin the entry at `name` below an open directory, following no link. */
async function pinSkillChild(
  directory: FileHandle,
  name: string,
): Promise<SkillPin> {
  assertPathComponent(name);
  return pinnedFrom(
    await open(`${PROC_FD}/${directory.fd}/${name}`, PIN_FLAGS),
  );
}

async function pinnedFrom(handle: FileHandle): Promise<SkillPin> {
  try {
    const stats = await handle.stat();
    return { handle, identity: { dev: stats.dev, ino: stats.ino } };
  } catch (error) {
    await closeQuietly(handle);
    throw error;
  }
}

/**
 * Create one child directory; the name must be free. The returned pin is the
 * caller's to close.
 *
 * `mkdir` cannot hand back a descriptor — no syscall creates a directory and
 * opens it in one step — so the pin is taken by re-opening the name, and the
 * directory must be EMPTY when it arrives. That is the same reservation
 * contract {@link withReservedSkillFolder} makes: a directory another actor
 * slipped into the gap is harmless while it holds nothing, and from the pin
 * onwards its inode cannot be recycled behind our back.
 */
export async function createSkillChildDirectory(
  directory: FileHandle,
  name: string,
): Promise<SkillPin> {
  assertPathComponent(name);
  try {
    await mkdir(`${PROC_FD}/${directory.fd}/${name}`);
  } catch (error) {
    throw asNameTaken(error, name);
  }
  // Taking the pin can itself fail — `EMFILE` under descriptor pressure is the
  // realistic one — and a created name nothing can prove ownership of is worse
  // than a refusal: no undo would dare remove it later. So the creation is
  // taken back here, while this call still knows it just made it. `rmdir`
  // removes only an empty directory, so the worst this can cost is an empty
  // directory another actor put at the name in the same instant.
  const pin = await pinCreatedSkillChildDirectory(directory, name);
  try {
    if ((await readSkillDirectory(pin.handle)).length > 0) {
      throw new IrregularSkillSourceError(
        `"${name}" was replaced by a directory with content just after it was created`,
      );
    }
    return pin;
  } catch (error) {
    await closeQuietly(pin.handle);
    // The read can fail on its own too, and the same rule holds after it as
    // before it: a directory this call made and cannot hand back goes.
    await rmdir(`${PROC_FD}/${directory.fd}/${name}`).catch(() => undefined);
    throw error;
  }
}

/**
 * Create one file with exactly this content; the name must be free. The
 * returned pin is the caller's to close.
 *
 * The pin comes from the descriptor the file was CREATED through, so it is the
 * inode this call made and not whatever the name resolves to a moment later.
 */
export async function createSkillChildFile(
  directory: FileHandle,
  name: string,
  content: Uint8Array,
): Promise<SkillPin> {
  assertPathComponent(name);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      `${PROC_FD}/${directory.fd}/${name}`,
      EXCLUSIVE_FLAGS,
      0o644,
    );
  } catch (error) {
    throw asNameTaken(error, name);
  }
  try {
    await handle.writeFile(content);
    return await pinSkillHandle(handle);
  } catch (error) {
    // The file exists but this call cannot hand back a pin for it, so it takes
    // it back instead of leaving a name no undo may touch. The creating
    // descriptor still holds the inode, which makes the removal exact.
    await unlinkCreatedChild(directory, name, handle);
    throw error;
  } finally {
    await closeQuietly(handle);
  }
}

/** Undo one just-created file, identified through the descriptor that made it. */
async function unlinkCreatedChild(
  directory: FileHandle,
  name: string,
  created: FileHandle,
): Promise<void> {
  try {
    const stats = await created.stat();
    await unlinkSkillChildIfSame(directory, name, {
      dev: stats.dev,
      ino: stats.ino,
    });
  } catch {
    // Nothing more can be done here; the caller's error is the one that matters
    // and the leftover, if any, is reported by the post-rollback status check.
  }
}

/**
 * Link one child into another open directory under the same name.
 *
 * The destination name must be free. A symlink is linked as the symlink it is —
 * Linux `link` does not dereference — so a supporting link keeps pointing where
 * it pointed.
 */
export async function linkSkillChild(
  fromDirectory: FileHandle,
  name: string,
  toDirectory: FileHandle,
): Promise<SkillPin> {
  assertPathComponent(name);
  try {
    await link(
      `${PROC_FD}/${fromDirectory.fd}/${name}`,
      `${PROC_FD}/${toDirectory.fd}/${name}`,
    );
  } catch (error) {
    throw asNameTaken(error, name);
  }
  // The two names are the same inode by definition of `link`, and the SOURCE
  // name still holds it, so it cannot have been recycled: comparing the pin
  // against the source is therefore a real check and not a guess. It fails only
  // if something took the destination name over in between, which is a refusal
  // — the pin must never end up on somebody else's entry.
  const linked = await skillChildIdentity(fromDirectory, name);
  let pin: SkillPin;
  try {
    pin = await pinSkillChild(toDirectory, name);
  } catch (error) {
    // As everywhere else: a name this call made but cannot pin is taken back
    // rather than left for an undo that could not prove it owns it. The source
    // link still holds the inode, so this unlinks that inode and nothing else.
    if (linked) {
      await unlinkSkillChildIfSame(toDirectory, name, linked).catch(
        () => false,
      );
    }
    throw error;
  }
  if (
    !linked ||
    linked.dev !== pin.identity.dev ||
    linked.ino !== pin.identity.ino
  ) {
    await closeQuietly(pin.handle);
    throw new IrregularSkillSourceError(
      `"${name}" was replaced while it was being linked into the new folder`,
    );
  }
  return pin;
}

function asNameTaken(error: unknown, name: string): Error {
  if (isNodeError(error) && error.code === "EEXIST") {
    return new SkillNameTakenError(`"${name}" already exists`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** When this open directory last changed (`ctime`), through its descriptor. */
export async function directoryChangedAt(
  directory: FileHandle,
): Promise<bigint | undefined> {
  return selfChangedAt(directory);
}

/**
 * When one child last changed (`ctime`), without following or opening it.
 *
 * The reading a later recheck compares against, and the only one available for
 * a symlink: it cannot be opened, and its target cannot change while its inode
 * does not, so the timestamp is all a removal needs from it.
 */
export async function skillChildChangedAt(
  directory: FileHandle,
  name: string,
): Promise<bigint | undefined> {
  assertPathComponent(name);
  try {
    return (await lstat(`${PROC_FD}/${directory.fd}/${name}`, { bigint: true }))
      .ctimeNs;
  } catch {
    return undefined;
  }
}

/**
 * What one child symlink POINTS AT, with the reading that held while it was
 * read — or `undefined` for anything that is not a symlink any more.
 *
 * A symlink cannot be opened and cannot be written through, so this is the only
 * way to ask what is in one. It is still bracketed, because it can be REPLACED:
 * `unlink` plus `symlink` puts a different target at the same name, and the two
 * calls of a read that was not bracketed would then be about two different
 * inodes. The `ctime` before and after must be the same one, and it is the
 * reading a later recheck compares against.
 *
 * The target comes back as BYTES: it is the content Git stores for a symlink,
 * and a path is not required to be valid UTF-8.
 */
export async function readSkillChildLink(
  directory: FileHandle,
  name: string,
): Promise<{ target: Uint8Array; changed: bigint } | undefined> {
  assertPathComponent(name);
  const path = `${PROC_FD}/${directory.fd}/${name}`;
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isSymbolicLink()) return undefined;
    const target = await readlink(path, { encoding: "buffer" });
    const after = await lstat(path, { bigint: true });
    if (!after.isSymbolicLink() || after.ctimeNs !== before.ctimeNs) {
      return undefined;
    }
    return { target, changed: after.ctimeNs };
  } catch {
    return undefined;
  }
}

/** No-follow identity of one child, or undefined when nothing is there. */
export async function skillChildIdentity(
  directory: FileHandle,
  name: string,
): Promise<{ dev: number; ino: number } | undefined> {
  assertPathComponent(name);
  try {
    const stats = await lstat(`${PROC_FD}/${directory.fd}/${name}`);
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
}

/**
 * Remove one child directory, which `rmdir` does only while it is EMPTY.
 *
 * That refusal is the point: an undo may take back a directory this code
 * created, and must leave one that somebody has since written into.
 */
export async function rmdirSkillChild(
  directory: FileHandle,
  name: string,
): Promise<void> {
  assertPathComponent(name);
  await rmdir(`${PROC_FD}/${directory.fd}/${name}`);
}

/**
 * Remove one whole directory tree, but only after moving it out of reach.
 *
 * `unlink` and `rmdir` take NAMES, and nothing stops another writer rebinding a
 * name between the check and the call. So the tree is first renamed to one this
 * call invents: everything below it then resolves through a name nothing else
 * addresses, and the recursive removal has no windows left in it at all. Only
 * after the move is the directory identified, and — when the caller supplies
 * `contentsExpected` — inspected, so a file a hand edit added to the tree stops
 * the removal instead of vanishing with it.
 *
 * Anything unexpected is renamed back and reported. That restore is the one
 * call here that can replace something, and only an EMPTY directory, which
 * `rename` is limited to; leaving a user's folder under an invented name would
 * be the worse of the two.
 */
export type SkillTreeRemoval =
  | "removed"
  | "absent"
  | "not-ours"
  | "unexpected-content"
  /**
   * Something WAS removed and then the removal failed. Reported separately
   * because it is the one outcome the caller cannot treat as "nothing
   * happened": the surviving entries are put back at the public name, but
   * committed files are missing from it, and only Git still has them.
   */
  | "partial";

/**
 * What a contents check concluded, and what it proved while concluding it.
 *
 * `provedAt` carries the `ctime` each file had when its content was verified,
 * by tree-relative path. Proving and emptying are separate walks and the first
 * has no bound — a single large sibling stretches it — so the second one
 * rechecks each of these immediately before the unlink that would destroy it.
 */
export type SkillTreeContents =
  { holds: false } | { holds: true; provedAt?: ReadonlyMap<string, bigint> };

export async function removeVerifiedSkillTree(
  parent: FileHandle,
  name: string,
  expected: { dev: number; ino: number },
  contentsExpected?: (tree: FileHandle) => Promise<SkillTreeContents>,
): Promise<SkillTreeRemoval> {
  assertPathComponent(name);
  const aside = `.pa-skill-removing-${randomUUID()}`;
  try {
    await rename(
      `${PROC_FD}/${parent.fd}/${name}`,
      `${PROC_FD}/${parent.fd}/${aside}`,
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "absent";
    throw error;
  }

  let removedAny = false;
  const outcome = await withSkillChild(parent, aside, async (child) => {
    if (!child.directory) return "not-ours" as const;
    const identity = await skillHandleIdentity(child.handle);
    if (identity.dev !== expected.dev || identity.ino !== expected.ino) {
      return "not-ours" as const;
    }
    const contents: SkillTreeContents = contentsExpected
      ? await contentsExpected(child.handle)
      : { holds: true };
    if (!contents.holds) return "unexpected-content" as const;
    await clearSkillDirectory(
      child.handle,
      () => {
        removedAny = true;
      },
      contents.provedAt,
    );
    return "removed" as const;
  }).catch((error: unknown) => {
    // An entry that changed after its content was proved is not a broken tree
    // and not somebody else's: it is content this removal may no longer take.
    if (error instanceof SkillContentChangedError) {
      return removedAny
        ? ("partial" as const)
        : ("unexpected-content" as const);
    }
    // A failure once entries are already gone is NOT "this was never ours":
    // saying so would let the caller report a refusal over a tree it has
    // already broken, with no restore of the files it took.
    return removedAny ? ("partial" as const) : ("not-ours" as const);
  });

  if (outcome === "removed") {
    await rmdir(`${PROC_FD}/${parent.fd}/${aside}`);
    return outcome;
  }
  await restoreDetachedChild(parent, aside, name, true);
  return outcome;
}

/** Whether the entry at `name` is still the exact one an earlier step created. */
export async function skillChildStillIs(
  directory: FileHandle,
  name: string,
  expected: { dev: number; ino: number },
): Promise<boolean> {
  try {
    return await withSkillChild(directory, name, async (child) => {
      const identity = await skillHandleIdentity(child.handle);
      return identity.dev === expected.dev && identity.ino === expected.ino;
    });
  } catch {
    // Gone, replaced by a link, or otherwise unopenable: not the same entry.
    return false;
  }
}

/** The identity of one open directory or file, for comparison against a scan. */
export async function skillHandleIdentity(
  handle: FileHandle,
): Promise<{ dev: number; ino: number }> {
  const stats = await handle.stat();
  return { dev: stats.dev, ino: stats.ino };
}

/**
 * Open one child for READ-THEN-WRITE and keep the single handle live through
 * `use`, so a caller reads and rewrites the SAME inode.
 *
 * `SKILL.md` is edited by replacing text that was read a moment earlier. Doing
 * that as read-by-name then create-by-name would truncate whatever holds the
 * name at write time, which need not be the file whose text was matched; one
 * handle removes the question.
 */
export async function withSkillChildForUpdate<T>(
  directory: FileHandle,
  name: string,
  use: (file: {
    handle: FileHandle;
    size: number;
    identity: { dev: number; ino: number };
    /** Replace the whole file through this same open description. */
    replace: (content: Uint8Array) => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  assertPathComponent(name);
  const handle = await openAnchored(
    `${PROC_FD}/${directory.fd}/${name}`,
    UPDATE_FLAGS,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new IrregularSkillSourceError(`"${name}" is not a regular file`);
    }
    return await use({
      handle,
      size: stats.size,
      identity: { dev: stats.dev, ino: stats.ino },
      replace: async (content) => {
        await handle.truncate(0);
        if (content.byteLength > 0)
          await handle.write(content, 0, content.byteLength, 0);
      },
    });
  } finally {
    await closeQuietly(handle);
  }
}

function assertPathComponent(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error("Invalid skill path component.");
  }
}

/** Whether an identity still names the same inodes a scan recorded. */
export function sameSkillSource(
  actual: SkillSourceIdentity,
  expected: SkillSourceIdentity,
): boolean {
  return (
    actual.folder.dev === expected.folder.dev &&
    actual.folder.ino === expected.folder.ino &&
    actual.file.dev === expected.file.dev &&
    actual.file.ino === expected.file.ino
  );
}

/**
 * `O_NOFOLLOW` on a symlink is `ELOOP` on Linux and `EMLINK` on the BSDs; both
 * mean the same refusal, and neither should reach a caller as a raw errno.
 */
async function openAnchored(
  path: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  try {
    return await open(path, flags, mode);
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "ELOOP" || error.code === "EMLINK")
    ) {
      throw new SymlinkedSkillSourceError("symlinked skill source");
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // A handle that cannot be closed is already gone; nothing to recover.
  }
}
