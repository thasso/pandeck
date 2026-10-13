/**
 * The bounded read of ONE library entry ([Task-614](pa://task/614), `docs/skills.md`).
 *
 * An entry is addressed by its DECLARED name and by nothing else. The caller
 * never supplies a path: the name is checked against `isSafeEntryName`, then
 * resolved through a fresh working-tree scan, and the file that is read is the
 * one that scan reported.
 */
import { Buffer } from "node:buffer";
import type { FileHandle } from "node:fs/promises";
import {
  isSafeEntryName,
  MAX_ENTRY_BODY_BYTES,
  type EntryDetailResponse,
} from "@assistant/shared";
import { buildEntryFileTree } from "./entryFiles.ts";
import { manifestSizeIssue } from "./entryManifest.ts";
import {
  scanLibrary,
  entrySourceIdentity,
  type LibraryScan,
} from "./libraryScanner.ts";
import type { LibraryKind } from "./libraryKind.ts";
import type { LibraryStore } from "./libraryStore.ts";
import {
  sameEntrySource,
  withLibraryRoot,
  withEntrySource,
} from "./entrySource.ts";

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Read one entry by declared name.
 *
 * Returns `null` when the library has nothing to say about the name at all —
 * an unsafe name, or one no folder declares. An invalid state is reserved for
 * a name the library DOES know and cannot serve.
 */
export async function readEntryDetail(
  name: string,
  library: LibraryStore,
): Promise<EntryDetailResponse | null> {
  if (!isSafeEntryName(name)) return null;
  await library.ensureInitialized();
  const scan = await scanLibrary(library.kind, library.root);
  return resolveEntryDetail(library, scan, name);
}

/**
 * Resolve one declared name against a scan result and read its bounded body.
 *
 * The scanner retains the directory and file identities it observed. The read
 * opens each path component with no-follow semantics through a directory file
 * descriptor, then compares those identities before serving anything. This
 * turns a folder replacement or symlink swap into an invalid answer rather
 * than allowing an unrelated directory to answer for the scanned entry.
 */
export async function resolveEntryDetail(
  library: LibraryStore,
  scan: LibraryScan,
  name: string,
): Promise<EntryDetailResponse | null> {
  if (!isSafeEntryName(name)) return null;

  const summary = scan.entries.find((entry) => entry.name === name);
  if (!summary) {
    const diagnostic = scan.diagnostics.find(
      (entry) => entry.declaredName === name,
    );
    if (!diagnostic) return null;
    return {
      kind: "invalid",
      name,
      folder: diagnostic.folder,
      path: diagnostic.path,
      error: diagnostic.error,
    };
  }

  const identity = entrySourceIdentity(scan, summary.path);
  if (!identity) {
    return unavailable(
      summary,
      `${summary.path} has no stable source identity from its scan.`,
    );
  }

  try {
    return await withLibraryRoot(library.root, (rootHandle) =>
      withEntrySource(
        rootHandle,
        folderOf(summary.path),
        library.kind.manifestFile,
        async (source) => {
          if (!sameEntrySource(source.identity, identity)) {
            return unavailable(
              summary,
              `${summary.path} changed since it was scanned.`,
            );
          }

          const read = await readBounded(source.file);
          try {
            validateReread(library.kind, read, summary, summary.path);
          } catch {
            return unavailable(
              summary,
              `${summary.path} no longer matches the scan or its ${library.kind.noun} rule; the library changed since it was scanned.`,
            );
          }

          const files = await buildEntryFileTree(library.kind, source.folder);
          return {
            kind: "entry",
            name: summary.name,
            description: summary.description,
            folder: folderOf(summary.path),
            path: summary.path,
            markdown: read.body.trim(),
            bytes: read.bytes,
            truncated: read.truncated,
            files,
          };
        },
      ),
    );
  } catch (error) {
    if (error instanceof InvalidFrontmatterError) {
      return unavailable(
        summary,
        `${summary.path} no longer starts with valid frontmatter; the library changed since it was scanned.`,
      );
    }
    if (
      isNodeError(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return unavailable(
        summary,
        `${summary.path} no longer exists; the library changed since it was scanned.`,
      );
    }
    return unavailable(
      summary,
      `${summary.path} could not be read consistently; the library changed since it was scanned.`,
    );
  }
}

function unavailable(
  summary: { name: string; path: string },
  error: string,
): EntryDetailResponse {
  return {
    kind: "invalid",
    name: summary.name,
    folder: folderOf(summary.path),
    path: summary.path,
    error,
  };
}

function folderOf(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(0, slash);
}

interface BoundedRead {
  /** The complete frontmatter section, including its fences. */
  frontmatter: string;
  /** The body below the closing fence, bounded by the body byte limit. */
  body: string;
  /** Size of the whole file on disk, which may exceed what was read. */
  bytes: number;
  truncated: boolean;
}

/**
 * Read the complete frontmatter and at most {@link MAX_ENTRY_BODY_BYTES} of the
 * bytes below its closing fence. The handle is already anchored beneath the
 * directory identity checked by {@link resolveEntryDetail}.
 */
async function readBounded(handle: FileHandle): Promise<BoundedRead> {
  const { size } = await handle.stat();
  let data = Buffer.alloc(0);
  let position = 0;
  let bodyStart: number | undefined;

  while (position < size && bodyStart === undefined) {
    const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - position));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    data = Buffer.concat([data, chunk.subarray(0, bytesRead)]);
    position += bytesRead;
    bodyStart = findBodyStart(data, position === size);
  }

  if (bodyStart === undefined) throw new InvalidFrontmatterError();

  const bodyBytes = size - bodyStart;
  const bodyReadLimit = Math.min(MAX_ENTRY_BODY_BYTES, bodyBytes);
  const targetBytes = bodyStart + bodyReadLimit;
  while (position < targetBytes) {
    const chunk = Buffer.alloc(targetBytes - position);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    data = Buffer.concat([data, chunk.subarray(0, bytesRead)]);
    position += bytesRead;
  }

  const frontmatter = new TextDecoder("utf-8").decode(
    data.subarray(0, bodyStart),
  );
  const body = new TextDecoder("utf-8").decode(
    data.subarray(bodyStart, targetBytes),
    { stream: true },
  );
  return {
    frontmatter,
    body,
    bytes: size,
    truncated: bodyBytes > MAX_ENTRY_BODY_BYTES,
  };
}

/** Return the byte offset immediately after the closing fence and newline. */
function findBodyStart(data: Buffer, atEof: boolean): number | undefined {
  const openingEnd =
    data[0] === 45 && data[1] === 45 && data[2] === 45
      ? data[3] === 10
        ? 4
        : data[3] === 13 && data[4] === 10
          ? 5
          : undefined
      : undefined;
  if (openingEnd === undefined) return undefined;

  for (let newline = openingEnd - 1; newline < data.length; newline++) {
    if (data[newline] !== 10) continue;
    const dashes = newline + 1;
    if (
      data[dashes] !== 45 ||
      data[dashes + 1] !== 45 ||
      data[dashes + 2] !== 45
    ) {
      continue;
    }
    const afterDashes = dashes + 3;
    if (afterDashes === data.length) {
      return atEof ? afterDashes : undefined;
    }
    if (data[afterDashes] === 10) return afterDashes + 1;
    if (data[afterDashes] === 13 && data[afterDashes + 1] === 10) {
      return afterDashes + 2;
    }
  }
  return undefined;
}

/**
 * The reread must still satisfy the kind's WHOLE rule and still declare what
 * the scan reported: a same-inode rewrite that breaks a kind-specific field
 * leaves `name` and `description` alone, and serving it would show as valid an
 * entry the library would now report as broken.
 */
function validateReread(
  kind: LibraryKind,
  read: BoundedRead,
  summary: { name: string; description: string },
  path: string,
): void {
  // Size from the real file, not from the clipped body the rule is handed.
  const parsed = kind.parseManifest(read.frontmatter + read.body, path);
  if (
    manifestSizeIssue(kind, read.bytes, path) !== undefined ||
    !parsed.ok ||
    parsed.manifest.name !== summary.name ||
    parsed.manifest.description !== summary.description
  ) {
    throw new Error("frontmatter metadata changed");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

class InvalidFrontmatterError extends Error {}
