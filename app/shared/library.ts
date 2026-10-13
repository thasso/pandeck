/**
 * Shared wire model for the user-owned Git-backed libraries: skills
 * (`docs/skills.md`, [Task-531](pa://task/531)) and agent definitions
 * (`docs/agent-definitions.md`).
 *
 * A library is hand-authored source under `DATA_DIR`, so the browser never
 * receives an index the server has cached: one scan of the current working
 * tree produces both halves of this model. Summaries stay COMPACT — name,
 * description and the source manifest path — because the list view shows them
 * all at once; bodies and supporting files are separate bounded reads.
 *
 * Diagnostics travel WITH the summaries rather than being dropped: a folder
 * that cannot be used is the case a user most needs to see, and it is
 * identified by its source folder, which is deliberately independent of the
 * declared name.
 *
 * The skills on/off state ([Task-613](pa://task/613)) is keyed by the SAME
 * declared name, so the rule for what a name may be lives here rather than
 * inside the server's scanner: settings and scanning must not disagree about
 * which names exist.
 */

/** Bound on a declared entry name, shared by the scanner and the toggle map. */
export const MAX_ENTRY_NAME_CHARS = 64;

const SAFE_ENTRY_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Whether a declared name is one the app will ever address: 1–64 characters of
 * lowercase ASCII letters, digits and single hyphens, no leading or trailing
 * hyphen. A name is also a directory child of a generated runtime layout, so a
 * name this refuses could never be materialized either.
 */
export function isSafeEntryName(name: string): boolean {
  return name.length <= MAX_ENTRY_NAME_CHARS && SAFE_ENTRY_NAME_RE.test(name);
}

/** Why one source folder cannot become a usable library entry. */
export type EntryDiagnosticCode =
  | "missing-manifest"
  | "unreadable-manifest"
  | "symlinked-source"
  | "invalid-frontmatter"
  | "invalid-yaml"
  | "missing-name"
  | "non-string-name"
  | "unsafe-name"
  | "missing-description"
  | "non-string-description"
  | "empty-description"
  | "description-too-long"
  | "invalid-field"
  | "duplicate-name";

/** One valid entry discovered in the library working tree. */
export interface EntrySummary {
  /** Declared frontmatter name; never inferred from the source folder. */
  name: string;
  description: string;
  /** Library-relative path of the source manifest. */
  path: string;
}

/** One actionable reason a source folder is not usable. */
export interface EntryDiagnostic {
  code: EntryDiagnosticCode;
  /** Top-level source folder, kept separate from the declared name. */
  folder: string;
  /** Expected library-relative manifest path. */
  path: string;
  /** Present when a safe declared name could still be recovered. */
  declaredName?: string;
  /** Human-readable explanation, rendered beside the folder it is about. */
  error: string;
}

/**
 * Bound on ONE served manifest body. An entry is instructions an agent reads,
 * so a file this size is already past what it can usefully carry; the bound
 * exists so a stray large file in a hand-authored folder cannot be turned into
 * an unbounded response by asking for it.
 */
export const MAX_ENTRY_BODY_BYTES = 256 * 1024;

/** Bounds for the recursive supporting-file index and one-file reads. */
export const MAX_ENTRY_TREE_ENTRIES = 1_000;
export const MAX_ENTRY_TREE_DEPTH = 16;
export const MAX_ENTRY_TREE_METADATA_BYTES = 256 * 1024;
export const MAX_ENTRY_FILE_PREVIEW_BYTES = 256 * 1024;
export const MAX_ENTRY_RAW_FILE_BYTES = 10 * 1024 * 1024;

/** One entry in a deterministic, entry-relative supporting-file tree. */
export interface EntryFileTreeEntry {
  type: "directory" | "file" | "symlink";
  name: string;
  /** Path relative to the selected entry folder. */
  path: string;
  /** Present for regular files and symlinks, never directories. */
  bytes?: number;
  /** Server-classified media type for regular files. */
  mimeType?: string;
  children?: EntryFileTreeEntry[];
}

export type EntryFileTreeLimit = "entries" | "depth" | "metadata-bytes";

/** Bounded recursive listing included with one entry detail. */
export interface EntryFileTree {
  entries: EntryFileTreeEntry[];
  entryCount: number;
  /** UTF-8 bytes consumed by included entry names, paths, and diagnostics. */
  metadataBytes: number;
  truncated: boolean;
  limits: EntryFileTreeLimit[];
  /** Non-fatal race/read diagnostics; never contains absolute paths. */
  diagnostics: string[];
}

/** JSON answer used by the bounded text/Markdown viewer on the raw-file route. */
export type EntryFilePreviewResponse =
  | {
      kind: "text";
      path: string;
      mimeType: string;
      text: string;
      bytes: number;
      truncated: boolean;
    }
  | {
      kind: "binary";
      path: string;
      mimeType: string;
      bytes: number;
      truncated: false;
    };

/**
 * One readable entry: the compact metadata the list already showed plus the
 * bounded manifest body and supporting-file index.
 *
 * The body is the Markdown BELOW the frontmatter. The frontmatter's two fields
 * are `name` and `description`, which travel here as metadata, so rendering the
 * raw fence would only show the same values as YAML.
 *
 * `bytes` is the size of the whole file on disk, not of `markdown`: with
 * `truncated` it is what lets a reader see that there is more in the file than
 * the app is willing to serve.
 */
export interface EntryDetail {
  kind: "entry";
  /** Declared frontmatter name, the only way this entry is addressed. */
  name: string;
  description: string;
  /** Top-level source folder the scan found this in. */
  folder: string;
  /** Library-relative path of the source manifest. */
  path: string;
  /** Manifest body below the frontmatter, bounded by the byte limit. */
  markdown: string;
  bytes: number;
  truncated: boolean;
  files: EntryFileTree;
}

/**
 * A name the library cannot currently answer for: the folder that declared it
 * is malformed or ambiguous, or the file changed between the scan and the read.
 *
 * This is deliberately a normal answer rather than a failure. The library is
 * hand-authored and scanned fresh on every read, so an entry can stop being
 * valid between the list and a click on it; the reader is owed the reason, not
 * a filesystem error.
 *
 * Not exported on its own: every consumer holds {@link EntryDetailResponse} and
 * narrows on `kind`, so a second way to name this half would only be somewhere
 * else for the two to drift apart.
 */
interface EntryDetailUnavailable {
  kind: "invalid";
  /** The requested declared name, echoed so a stale pane cannot be mistaken. */
  name: string;
  /** Present when a source folder could still be identified. */
  folder?: string;
  path?: string;
  error: string;
}

export type EntryDetailResponse = EntryDetail | EntryDetailUnavailable;
