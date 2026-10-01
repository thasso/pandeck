/**
 * Recursive supporting-file listing and bounded reads for one selected skill
 * ([Task-615](pa://task/615), `docs/skills.md`). Paths are always relative to
 * the skill folder and every component is opened beneath the already-open
 * folder descriptor with no-follow semantics.
 */
import { Buffer } from "node:buffer";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import {
  isSafeSkillName,
  MAX_SKILL_FILE_PREVIEW_BYTES,
  MAX_SKILL_RAW_FILE_BYTES,
  MAX_SKILL_TREE_DEPTH,
  MAX_SKILL_TREE_ENTRIES,
  MAX_SKILL_TREE_METADATA_BYTES,
  type SkillFilePreviewResponse,
  type SkillFileTree,
  type SkillFileTreeEntry,
  type SkillFileTreeLimit,
} from "@assistant/shared";
import {
  scanSkillLibrary,
  skillSourceIdentity,
  type SkillLibraryScan,
} from "./skillLibraryScanner.ts";
import {
  skillLibraryStore,
  type SkillLibraryStore,
} from "./skillLibraryStore.ts";
import {
  iterateSkillDirectory,
  sameSkillSource,
  SKILL_FILE_NAME,
  IrregularSkillSourceError,
  SymlinkedSkillSourceError,
  withLibraryRoot,
  withSkillChild,
  withSkillSource,
  type SkillSource,
} from "./skillSource.ts";

const MAX_SKILL_RELATIVE_PATH_BYTES = 4 * 1024;
/**
 * How many names one directory listing ever holds at a time.
 *
 * Comfortably above every OTHER bound a walk can hit — the thousand entries it
 * may emit, and the diagnostics the metadata budget allows for entries it
 * cannot — so it changes no answer a real library produces, while a folder with
 * a million siblings costs this read a few thousand names instead of all of
 * them.
 */
const MAX_SKILL_TREE_LISTING = 4_096;

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".ndjson": "application/x-ndjson; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".toml": "text/plain; charset=utf-8",
  ".ini": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".jsx": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".bash": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
  ".rb": "text/plain; charset=utf-8",
  ".go": "text/plain; charset=utf-8",
  ".rs": "text/plain; charset=utf-8",
  ".java": "text/plain; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
};

export class InvalidSkillFilePathError extends Error {}
export class SkillFileNotFoundError extends Error {}
export class SkillFileTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly bytes: number,
  ) {
    super(`File "${path}" is too large to serve (${bytes} bytes).`);
  }
}

export interface SkillRawFile {
  path: string;
  mimeType: string;
  bytes: number;
  content: Buffer;
}

/** Strict skill-relative path validation, before any library scan or open. */
function normalizeSkillRelativePath(input: string): string {
  if (
    !input ||
    input !== input.trim() ||
    input.includes("\0") ||
    input.includes("\\") ||
    isAbsolute(input) ||
    /^[a-zA-Z]:/.test(input) ||
    Buffer.byteLength(input, "utf8") > MAX_SKILL_RELATIVE_PATH_BYTES
  ) {
    throw new InvalidSkillFilePathError("Invalid skill-relative path.");
  }
  const components = input.split("/");
  if (
    components.some(
      (component) => !component || component === "." || component === "..",
    )
  ) {
    throw new InvalidSkillFilePathError("Invalid skill-relative path.");
  }
  return components.join("/");
}

/** MIME classification shared by the tree metadata and raw response. */
function skillFileMimeType(path: string): string {
  return (
    CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"
  );
}

/** Build a deterministic, explicitly bounded tree under an open skill folder. */
export async function buildSkillFileTree(
  folder: FileHandle,
): Promise<SkillFileTree> {
  const state = {
    entryCount: 0,
    metadataBytes: 0,
    limits: new Set<SkillFileTreeLimit>(),
    diagnostics: [] as string[],
    stopped: false,
  };

  const stopForMetadata = () => {
    state.limits.add("metadata-bytes");
    state.stopped = true;
  };

  const reserveMetadata = (bytes: number): boolean => {
    if (state.metadataBytes + bytes > MAX_SKILL_TREE_METADATA_BYTES) {
      stopForMetadata();
      return false;
    }
    state.metadataBytes += bytes;
    return true;
  };

  const addDiagnostic = (message: string) => {
    // Diagnostics contain the listed path, so charge their UTF-8 bytes to the
    // same bound as entry names and paths. A pathological directory can then
    // stop the walk instead of turning a race or irregular entry into an
    // unbounded response.
    if (!reserveMetadata(Buffer.byteLength(message, "utf8"))) return;
    state.diagnostics.push(message);
  };

  const walk = async (
    directory: FileHandle,
    parentPath: string,
    depth: number,
  ): Promise<SkillFileTreeEntry[]> => {
    if (state.stopped) return [];
    let dirents;
    try {
      // Only as many entries as this walk could still emit are ever held. A
      // full listing would allocate a hand-authored million siblings before the
      // thousand-entry bound below could refuse a single one of them — the
      // bound has to apply to the READ, not just to the answer.
      const listing = await boundedListing(directory, MAX_SKILL_TREE_LISTING);
      dirents = listing.entries;
      if (listing.more) state.limits.add("entries");
    } catch {
      addDiagnostic(
        parentPath
          ? `${parentPath} could not be read while its files were listed.`
          : "The skill folder could not be read while its files were listed.",
      );
      return [];
    }

    const entries: SkillFileTreeEntry[] = [];
    for (const dirent of dirents) {
      if (state.stopped) break;
      if (state.entryCount >= MAX_SKILL_TREE_ENTRIES) {
        state.limits.add("entries");
        state.stopped = true;
        break;
      }
      const path = parentPath ? `${parentPath}/${dirent.name}` : dirent.name;
      const metadataCost =
        Buffer.byteLength(dirent.name, "utf8") +
        Buffer.byteLength(path, "utf8");
      if (state.metadataBytes + metadataCost > MAX_SKILL_TREE_METADATA_BYTES) {
        stopForMetadata();
        break;
      }

      const reserve = () => {
        state.entryCount += 1;
        // The capacity check above makes this reservation infallible.
        state.metadataBytes += metadataCost;
      };

      if (dirent.isSymbolicLink()) {
        reserve();
        entries.push({ type: "symlink", name: dirent.name, path, bytes: 0 });
        continue;
      }

      try {
        await withSkillChild(directory, dirent.name, async (child) => {
          reserve();
          if (!child.directory) {
            entries.push({
              type: "file",
              name: dirent.name,
              path,
              bytes: child.size,
              mimeType: skillFileMimeType(path),
            });
            return;
          }

          const entry: SkillFileTreeEntry = {
            type: "directory",
            name: dirent.name,
            path,
          };
          entries.push(entry);
          if (depth >= MAX_SKILL_TREE_DEPTH) {
            // Whether it has ANY child, which is one entry's worth of reading:
            // listing the whole directory to learn that it is non-empty is the
            // read this bound exists to avoid.
            const nested = await boundedListing(child.handle, 1);
            if (nested.entries.length > 0) state.limits.add("depth");
            return;
          }
          const children = await walk(child.handle, path, depth + 1);
          if (children.length > 0) entry.children = children;
        });
      } catch (error) {
        if (error instanceof SymlinkedSkillSourceError) {
          // A path swapped to a symlink after readdir is still visible but is
          // never followed.
          reserve();
          entries.push({ type: "symlink", name: dirent.name, path, bytes: 0 });
        } else if (error instanceof IrregularSkillSourceError) {
          addDiagnostic(`${path} is not a regular file or directory.`);
        } else {
          addDiagnostic(
            `${path} could not be read while its files were listed.`,
          );
        }
      }
    }
    return entries;
  };

  const entries = await walk(folder, "", 1);
  return {
    entries,
    entryCount: state.entryCount,
    metadataBytes: state.metadataBytes,
    truncated: state.limits.size > 0,
    limits: [...state.limits].sort(),
    diagnostics: state.diagnostics,
  };
}

/**
 * The first `capacity` entries of one directory, in the tree's own order,
 * without ever holding more than that many.
 *
 * The order is the answer's: `SKILL.md` first, so the defining document
 * survives a huge supporting subtree, then byte-lexical. Sorting normally means
 * reading everything first; keeping a sorted array of exactly the size the
 * caller could still use gives the same first N while the read stays bounded,
 * and `more` says whether anything was dropped for it.
 */
async function boundedListing(
  directory: FileHandle,
  capacity: number,
): Promise<{ entries: Dirent[]; more: boolean }> {
  const entries: Dirent[] = [];
  let more = false;
  for await (const dirent of iterateSkillDirectory(directory)) {
    if (capacity === 0) {
      more = true;
      break;
    }
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (comesFirst(entries[middle]!.name, dirent.name)) low = middle + 1;
      else high = middle;
    }
    if (low >= capacity) {
      more = true;
      continue;
    }
    entries.splice(low, 0, dirent);
    if (entries.length > capacity) {
      entries.pop();
      more = true;
    }
  }
  return { entries, more };
}

/** The listing order: `SKILL.md` first, then byte-lexical. */
function comesFirst(left: string, right: string): boolean {
  const leftRank = left === SKILL_FILE_NAME ? 0 : 1;
  const rightRank = right === SKILL_FILE_NAME ? 0 : 1;
  if (leftRank !== rightRank) return leftRank < rightRank;
  return left < right;
}

export async function readSkillRawFile(
  name: string,
  pathInput: string,
  library: SkillLibraryStore = skillLibraryStore,
): Promise<SkillRawFile | null> {
  const path = normalizeSkillRelativePath(pathInput);
  return withResolvedSkill(name, library, async (source) =>
    withRelativeFile(source.folder, path, async (file) => {
      if (file.size > MAX_SKILL_RAW_FILE_BYTES) {
        throw new SkillFileTooLargeError(path, file.size);
      }
      const content = await readBounded(file.handle, file.size);
      if (content.byteLength !== file.size) {
        throw new SkillFileNotFoundError(
          "The skill file does not exist or changed while it was read.",
        );
      }
      return {
        path,
        mimeType: skillFileMimeType(path),
        bytes: file.size,
        content,
      };
    }),
  );
}

export async function readSkillFilePreview(
  name: string,
  pathInput: string,
  library: SkillLibraryStore = skillLibraryStore,
): Promise<SkillFilePreviewResponse | null> {
  const path = normalizeSkillRelativePath(pathInput);
  return withResolvedSkill(name, library, async (source) =>
    withRelativeFile(source.folder, path, async (file) => {
      const mimeType = skillFileMimeType(path);
      const previewBytes = Math.min(file.size, MAX_SKILL_FILE_PREVIEW_BYTES);
      const content = await readBounded(file.handle, previewBytes);
      if (!isTextMimeType(mimeType) || looksBinary(content)) {
        return {
          kind: "binary",
          path,
          mimeType,
          bytes: file.size,
          truncated: false,
        };
      }
      return {
        kind: "text",
        path,
        mimeType,
        text: new TextDecoder("utf-8").decode(content, { stream: true }),
        bytes: file.size,
        truncated: file.size > MAX_SKILL_FILE_PREVIEW_BYTES,
      };
    }),
  );
}

/**
 * One agent-sized window of a supporting file's text.
 *
 * `bytes` is the whole file. `lineCount` counts only the lines this read could
 * see, which is the file's first {@link MAX_SKILL_FILE_PREVIEW_BYTES} bytes;
 * `truncated` says the window stops short of the file's end, whether because
 * more lines follow or because the file itself runs past that bound.
 */
export interface SkillTextWindow {
  path: string;
  mimeType: string;
  bytes: number;
  /** 1-based, inclusive. `lastLine` is `firstLine - 1` for an empty window. */
  firstLine: number;
  lastLine: number;
  lineCount: number;
  text: string;
  truncated: boolean;
}

/** Line window defaults and bounds for one supporting-file read. */
export const DEFAULT_SKILL_TEXT_WINDOW_LINES = 400;
export const MAX_SKILL_TEXT_WINDOW_LINES = 2_000;
/**
 * How much text one window may carry regardless of its line count. A generated
 * reference is free to hold a single 200 KiB line, and a line budget alone
 * would let it decide how big a model's context gets.
 */
export const MAX_SKILL_TEXT_WINDOW_BYTES = 64 * 1024;

/** A file that is not UTF-8 text cannot be served as, or edited as, text. */
export class SkillFileNotTextError extends Error {}

/**
 * Read one supporting file as a bounded window of lines.
 *
 * The window is what an agent reads before it edits: the text it returns is the
 * text an exact-match edit has to match, so it is served verbatim rather than
 * normalized — BOM included — and a file that is not text, or not valid UTF-8,
 * is refused instead of being decoded into replacement characters somebody
 * could then "edit".
 */
export async function readSkillTextWindow(
  name: string,
  pathInput: string,
  window: { offset?: number; limit?: number } = {},
  library: SkillLibraryStore = skillLibraryStore,
): Promise<SkillTextWindow | null> {
  const path = normalizeSkillRelativePath(pathInput);
  const offset = boundedOffset(window.offset);
  const limit = boundedLimit(window.limit);
  return withResolvedSkill(name, library, async (source) =>
    withRelativeFile(source.folder, path, async (file) => {
      const mimeType = skillFileMimeType(path);
      const readable = Math.min(file.size, MAX_SKILL_FILE_PREVIEW_BYTES);
      const content = await readBounded(file.handle, readable);
      if (!isTextMimeType(mimeType) || looksBinary(content)) {
        throw new SkillFileNotTextError(
          `"${path}" is ${mimeType} (${file.size} bytes), not UTF-8 text. Open it through the skills file route in Settings instead.`,
        );
      }
      const beyondBound = file.size > MAX_SKILL_FILE_PREVIEW_BYTES;
      const lines = textLines(
        decodeWindow(content, path, mimeType, beyondBound),
        beyondBound,
      );
      const emitted = emittedLines(lines, offset, limit);
      return {
        path,
        mimeType,
        bytes: file.size,
        firstLine: offset,
        lastLine: offset + emitted.lines.length - 1,
        lineCount: lines.length,
        text: emitted.lines.join("\n"),
        truncated:
          beyondBound ||
          emitted.clipped ||
          offset - 1 + emitted.lines.length < lines.length,
      };
    }),
  );
}

/**
 * Decode a window's bytes, refusing anything that is not valid UTF-8.
 *
 * A NUL scan catches a PNG; it does not catch a `.md` file holding one stray
 * Latin-1 byte, and a lossy decode would answer with a replacement character
 * standing where content used to be. That answer is not the file's text, so an
 * exact-match edit copied out of it would either miss or rewrite bytes nobody
 * looked at.
 *
 * `cutAtBound` is why the flush is conditional. An incomplete final character
 * means two different things, and the bytes are identical in both: content this
 * read chopped at 256 KiB, or a file that really ends mid-character. Streaming
 * suspends judgement on the tail, which is right only for the first — so the
 * decode FLUSHES whenever the whole file was read, and a truncated file is then
 * refused like any other invalid UTF-8.
 *
 * `ignoreBOM` keeps a leading U+FEFF in the answer: stripping it would make the
 * window disagree with the bytes on disk, which is the one thing this read may
 * not do.
 */
function decodeWindow(
  content: Uint8Array,
  path: string,
  mimeType: string,
  cutAtBound: boolean,
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      content,
      { stream: cutAtBound },
    );
  } catch {
    throw new SkillFileNotTextError(
      `"${path}" is declared ${mimeType} but is not valid UTF-8, so it cannot be served as text. Open it through the skills file route in Settings instead.`,
    );
  }
}

function boundedOffset(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isFinite(value) || value < 1) {
    throw new InvalidSkillFilePathError("offset must be a line number from 1.");
  }
  return Math.floor(value);
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SKILL_TEXT_WINDOW_LINES;
  if (!Number.isFinite(value) || value < 1) {
    throw new InvalidSkillFilePathError("limit must be a positive number.");
  }
  return Math.min(Math.floor(value), MAX_SKILL_TEXT_WINDOW_LINES);
}

/**
 * The addressable lines of a decoded prefix.
 *
 * A trailing newline ends the last line rather than starting an empty one, and
 * a prefix cut at the byte bound drops its final line: half a line is not a
 * line anybody can copy an edit out of.
 */
function textLines(text: string, cutAtBound: boolean): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  else if (cutAtBound) lines.pop();
  return lines;
}

/**
 * The requested lines, cut again at the window's own byte budget.
 *
 * A single line may be longer than the whole budget — a generated table row,
 * a minified asset — and refusing it would make the file unreadable through
 * this seam. It is clipped instead, at a character boundary, and `clipped`
 * makes that visible as truncation rather than as a complete last line.
 */
function emittedLines(
  lines: string[],
  offset: number,
  limit: number,
): { lines: string[]; clipped: boolean } {
  const emitted: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(offset - 1, offset - 1 + limit)) {
    // The separator this line will be joined with counts too.
    const separator = emitted.length > 0 ? 1 : 0;
    const cost = Buffer.byteLength(line, "utf8") + separator;
    if (bytes + cost > MAX_SKILL_TEXT_WINDOW_BYTES) {
      if (emitted.length > 0) break;
      emitted.push(clipToBytes(line, MAX_SKILL_TEXT_WINDOW_BYTES));
      return { lines: emitted, clipped: true };
    }
    emitted.push(line);
    bytes += cost;
    if (bytes >= MAX_SKILL_TEXT_WINDOW_BYTES) break;
  }
  return { lines: emitted, clipped: false };
}

/** A UTF-8 prefix that never ends mid-character. */
function clipToBytes(text: string, budget: number): string {
  const encoded = new TextEncoder().encode(text);
  // `stream: true` drops the trailing incomplete sequence rather than emitting
  // a replacement character for it. The input is already-validated text, and
  // `ignoreBOM` keeps a leading U+FEFF that survived the decode above.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    encoded.subarray(0, budget),
    { stream: true },
  );
}

async function withResolvedSkill<T>(
  name: string,
  library: SkillLibraryStore,
  use: (source: SkillSource) => Promise<T>,
): Promise<T | null> {
  if (!isSafeSkillName(name)) return null;
  await library.ensureInitialized();
  const scan = await scanSkillLibrary(library.root);
  return withResolvedSkillFromScan(library.root, scan, name, use);
}

async function withResolvedSkillFromScan<T>(
  root: string,
  scan: SkillLibraryScan,
  name: string,
  use: (source: SkillSource) => Promise<T>,
): Promise<T | null> {
  const summary = scan.skills.find((skill) => skill.name === name);
  if (!summary) return null;
  const identity = skillSourceIdentity(scan, summary.path);
  if (!identity) return null;
  const folder = summary.path.slice(0, summary.path.indexOf("/"));
  try {
    return await withLibraryRoot(root, (rootHandle) =>
      withSkillSource(rootHandle, folder, async (source) => {
        if (!sameSkillSource(source.identity, identity)) {
          throw new SkillFileNotFoundError(
            "The skill changed since it was scanned.",
          );
        }
        return use(source);
      }),
    );
  } catch (error) {
    if (
      error instanceof InvalidSkillFilePathError ||
      error instanceof SkillFileTooLargeError ||
      error instanceof SkillFileNotTextError
    ) {
      throw error;
    }
    throw new SkillFileNotFoundError(
      error instanceof SymlinkedSkillSourceError
        ? "Symlinked skill files are not served."
        : "The skill file does not exist or changed while it was read.",
    );
  }
}

async function withRelativeFile<T>(
  folder: FileHandle,
  path: string,
  use: (file: { handle: FileHandle; size: number }) => Promise<T>,
): Promise<T> {
  const components = path.split("/");
  const descend = async (directory: FileHandle, at: number): Promise<T> =>
    withSkillChild(directory, components[at]!, async (child) => {
      const last = at === components.length - 1;
      if (last) {
        if (child.directory)
          throw new SkillFileNotFoundError("Path is a directory.");
        return use({ handle: child.handle, size: child.size });
      }
      if (!child.directory)
        throw new SkillFileNotFoundError("Path is not a directory.");
      return descend(child.handle, at + 1);
    });
  return descend(folder, 0);
}

async function readBounded(handle: FileHandle, bytes: number): Promise<Buffer> {
  const content = Buffer.alloc(bytes);
  let position = 0;
  while (position < bytes) {
    const result = await handle.read(
      content,
      position,
      bytes - position,
      position,
    );
    if (result.bytesRead === 0) break;
    position += result.bytesRead;
  }
  return content.subarray(0, position);
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType.startsWith("application/json") ||
    mimeType.startsWith("application/x-ndjson")
  );
}

function looksBinary(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, 8 * 1024));
  for (const byte of sample) if (byte === 0) return true;
  return false;
}
