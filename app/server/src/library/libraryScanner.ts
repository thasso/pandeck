import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type {
  EntryDiagnostic,
  EntryDiagnosticCode,
  EntrySummary,
} from "@assistant/shared";
import { manifestSizeIssue, readManifestHandle } from "./entryManifest.ts";
import type { LibraryKind } from "./libraryKind.ts";
import {
  SymlinkedEntrySourceError,
  withLibraryRoot,
  withEntrySource,
  type EntrySourceIdentity,
} from "./entrySource.ts";

/**
 * One scan of the library working tree. The summaries and diagnostics are the
 * shared wire model (`@assistant/shared`): the browser shows exactly what the
 * scanner found, so a second server-only shape would only be a chance for the
 * two to disagree.
 */
export interface LibraryScan {
  entries: EntrySummary[];
  diagnostics: EntryDiagnostic[];
}

/**
 * How many folders one scan reads at a time. Each holds two descriptors while
 * it runs, so an unbounded fan-out over a directly authored library asks the
 * process for as many as it has folders, all at once.
 */
const SCAN_CONCURRENCY = 8;

/**
 * How much of one manifest a scan reads.
 *
 * Generous on purpose: the scan needs the frontmatter, and the served-body
 * bound deliberately does NOT apply to it, so an entry with a large metadata
 * block stays valid. What this rules out is the other extreme — a hand-authored
 * file of arbitrary size read in full, for every folder, on every list and
 * every mutation.
 */
const MAX_SCANNED_MANIFEST_BYTES = 1024 * 1024;

const sourceIdentities = new WeakMap<
  LibraryScan,
  Map<string, EntrySourceIdentity>
>();

export function entrySourceIdentity(
  scan: LibraryScan,
  path: string,
): EntrySourceIdentity | undefined {
  return sourceIdentities.get(scan)?.get(path);
}

interface EntryCandidate {
  folder: string;
  path: string;
  declaredName?: string;
  description?: string;
  diagnostics: EntryDiagnostic[];
  sourceIdentity?: EntrySourceIdentity;
}

/**
 * Scan top-level entry folders from the filesystem on every call.
 *
 * The Git index and HEAD are deliberately not consulted: uncommitted edits,
 * additions, and removals are authoritative library state.
 */
export async function scanLibrary(
  kind: LibraryKind,
  root: string,
  options: {
    /**
     * Consulted between batches. A scan is read-only, so a caller that has
     * stopped caring can have it abandoned wherever it has got to — which is
     * what makes the whole pre-write half of a mutation interruptible, not just
     * the moment before it writes.
     */
    checkpoint?: () => void;
  } = {},
): Promise<LibraryScan> {
  const folders = (await entryShapedEntries(root)).sort(compareText);
  // In batches, not all at once. Each folder scan holds two descriptors while
  // it runs, so a directly authored library of thousands of folders would ask
  // the process for thousands of them at the same instant; the answer is the
  // same either way, and the whole scan is still one `await`.
  const candidates: EntryCandidate[] = [];
  await withLibraryRoot(root, async (rootHandle) => {
    for (let at = 0; at < folders.length; at += SCAN_CONCURRENCY) {
      options.checkpoint?.();
      candidates.push(
        ...(await Promise.all(
          folders
            .slice(at, at + SCAN_CONCURRENCY)
            .map((folder) => scanEntryFolder(kind, rootHandle, folder)),
        )),
      );
    }
  });

  addDuplicateDiagnostics(kind, candidates);

  const entries: EntrySummary[] = [];
  const diagnostics: EntryDiagnostic[] = [];
  const scanSourceIdentities = new Map<string, EntrySourceIdentity>();
  for (const candidate of candidates) {
    diagnostics.push(...candidate.diagnostics);
    if (
      candidate.diagnostics.length === 0 &&
      candidate.declaredName !== undefined &&
      candidate.description !== undefined
    ) {
      entries.push({
        name: candidate.declaredName,
        description: candidate.description,
        path: candidate.path,
      });
      if (candidate.sourceIdentity) {
        scanSourceIdentities.set(candidate.path, candidate.sourceIdentity);
      }
    }
  }

  entries.sort(
    (a, b) => compareText(a.name, b.name) || compareText(a.path, b.path),
  );
  diagnostics.sort(
    (a, b) => compareText(a.path, b.path) || compareText(a.code, b.code),
  );
  const scan = { entries, diagnostics };
  sourceIdentities.set(scan, scanSourceIdentities);
  return scan;
}

/**
 * Which top-level entries stand where an entry folder would.
 *
 * A directory does. A symlink does NOT — the library refuses to read through
 * one — but a link standing where a folder belongs is still reported, because a
 * user who linked an entry in has to be told why it is not listed rather than
 * watch it silently vanish. A link to anything else is an ordinary top-level
 * file by another name, and top-level files are not library entries: this
 * `stat` only decides whether the entry is entry-shaped, and no content is ever
 * read through it.
 */
async function entryShapedEntries(root: string): Promise<string[]> {
  const entries = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => !entry.name.startsWith("."),
  );
  const folders: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      folders.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    if (await linksToDirectory(join(root, entry.name)))
      folders.push(entry.name);
  }
  return folders;
}

async function linksToDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    // A dangling or unreadable link points at no folder, so it is not one.
    return false;
  }
}

async function scanEntryFolder(
  kind: LibraryKind,
  rootHandle: FileHandle,
  folder: string,
): Promise<EntryCandidate> {
  const path = `${folder}/${kind.manifestFile}`;
  const candidate: EntryCandidate = { folder, path, diagnostics: [] };
  let identity: EntrySourceIdentity;
  let content: string;
  let size: number;
  try {
    // One resolution, one inode: the identity recorded here and the bytes below
    // come from the same open handle, so a swap after this point cannot make
    // the scan describe one file and read another.
    ({ identity, content, size } = await withEntrySource(
      rootHandle,
      folder,
      kind.manifestFile,
      async (source) => {
        // Bounded, and it can be: the scan needs the FRONTMATTER, which is at
        // the top of the file. Reading a hand-authored file of arbitrary size
        // in full — on every list and every mutation, for every folder — is how
        // one stray file in the library becomes the whole process's memory. A
        // file whose frontmatter does not fit in the bound is reported as
        // malformed by the shared rule, exactly as it would be otherwise.
        const read = await readManifestHandle(
          source.file,
          source.size,
          MAX_SCANNED_MANIFEST_BYTES,
        );
        return {
          identity: source.identity,
          content: read.source,
          size: source.size,
        };
      },
    ));
  } catch (error) {
    const missing = isNodeError(error) && error.code === "ENOENT";
    const symlinked = error instanceof SymlinkedEntrySourceError;
    candidate.diagnostics.push({
      code: symlinked
        ? "symlinked-source"
        : missing
          ? "missing-manifest"
          : "unreadable-manifest",
      folder,
      path,
      error: symlinked
        ? `Refusing symlinked ${kind.noun} source ${path}; source folders and ${kind.manifestFile} files must be regular filesystem entries.`
        : missing
          ? `Missing ${path}.`
          : `Cannot read ${path} as a UTF-8 file.`,
    });
    return candidate;
  }

  // The kind's size bound is judged from the real file size: the content may
  // have been clipped to the scan's own read bound, which no content rule can
  // see past.
  const tooLarge = manifestSizeIssue(kind, size, path);
  const parsed = kind.parseManifest(content, path);
  if (parsed.ok && !tooLarge) {
    candidate.declaredName = parsed.manifest.name;
    candidate.description = parsed.manifest.description;
    candidate.sourceIdentity = identity;
    return candidate;
  }
  // A recovered name still competes for duplicate detection below, even though
  // this folder already has an issue of its own.
  const recovered = parsed.ok ? parsed.manifest.name : parsed.name;
  if (recovered !== undefined) candidate.declaredName = recovered;
  const issues = parsed.ok ? [] : parsed.issues;
  for (const issue of tooLarge ? [tooLarge, ...issues] : issues) {
    candidate.diagnostics.push(diagnostic(candidate, issue.code, issue.error));
  }
  return candidate;
}

/** How many folders a duplicate-name diagnostic names before "and N more". */
const MAX_NAMED_DUPLICATE_FOLDERS = 5;

function addDuplicateDiagnostics(
  kind: LibraryKind,
  candidates: EntryCandidate[],
): void {
  const byName = new Map<string, EntryCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.declaredName === undefined) continue;
    const group = byName.get(candidate.declaredName) ?? [];
    group.push(candidate);
    byName.set(candidate.declaredName, group);
  }

  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const folders = group
      .map((candidate) => candidate.folder)
      .sort(compareText);
    // Every conflicting folder carries this text, so it names a few of them:
    // listing all would grow with the library on every one.
    const named = folders.slice(0, MAX_NAMED_DUPLICATE_FOLDERS).join(", ");
    const more = folders.length - MAX_NAMED_DUPLICATE_FOLDERS;
    const listed = more > 0 ? `${named} and ${more} more` : named;
    for (const candidate of group) {
      candidate.diagnostics.push({
        code: "duplicate-name",
        folder: candidate.folder,
        path: candidate.path,
        declaredName: name,
        error: `Duplicate declared ${kind.noun} name "${name}" in folders: ${listed}.`,
      });
    }
  }
}

function diagnostic(
  candidate: EntryCandidate,
  code: EntryDiagnosticCode,
  error: string,
): EntryDiagnostic {
  return {
    code,
    folder: candidate.folder,
    path: candidate.path,
    ...(candidate.declaredName !== undefined
      ? { declaredName: candidate.declaredName }
      : {}),
    error,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
