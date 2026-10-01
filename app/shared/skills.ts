/**
 * Shared wire model for the user-owned skills library (`docs/skills.md`,
 * [Task-531](pa://task/531)).
 *
 * The library is hand-authored source under `DATA_DIR/skills`, so the browser
 * never receives an index the server has cached: one scan of the current
 * working tree produces both halves of this model. Summaries stay COMPACT —
 * name, description and the source `SKILL.md` path — because the list view
 * shows them all at once; bodies and supporting files are separate bounded
 * reads.
 *
 * Diagnostics travel WITH the summaries rather than being dropped: a folder
 * that cannot be injected is the case a user most needs to see, and it is
 * identified by its source folder, which is deliberately independent of the
 * declared skill name.
 *
 * The global on/off state ([Task-613](pa://task/613)) is keyed by the SAME
 * declared name, so the rule for what a name may be lives here rather than
 * inside the server's scanner: settings and scanning must not disagree about
 * which names exist.
 */

/** Bound on a declared skill name, shared by the scanner and the toggle map. */
export const MAX_SKILL_NAME_CHARS = 64;

const SAFE_SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Whether a declared name is one the app will ever address: 1–64 characters of
 * lowercase ASCII letters, digits and single hyphens, no leading or trailing
 * hyphen. A name is also a directory child of a generated runtime layout, so a
 * name this refuses could never be materialized either.
 */
export function isSafeSkillName(name: string): boolean {
  return name.length <= MAX_SKILL_NAME_CHARS && SAFE_SKILL_NAME_RE.test(name);
}

/** Why one source folder cannot become an injectable skill. */
export type SkillDiagnosticCode =
  | "missing-skill-file"
  | "unreadable-skill-file"
  | "symlinked-skill-source"
  | "invalid-frontmatter"
  | "invalid-yaml"
  | "missing-name"
  | "non-string-name"
  | "unsafe-name"
  | "missing-description"
  | "non-string-description"
  | "empty-description"
  | "description-too-long"
  | "duplicate-name";

/** One valid, injectable skill discovered in the library working tree. */
export interface SkillSummary {
  /** Declared frontmatter name; never inferred from the source folder. */
  name: string;
  description: string;
  /** Library-relative path of the source `SKILL.md`. */
  path: string;
}

/** One actionable reason a source folder is not injectable. */
export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  /** Top-level source folder, kept separate from the declared name. */
  folder: string;
  /** Expected library-relative `SKILL.md` path. */
  path: string;
  /** Present when a safe declared name could still be recovered. */
  declaredName?: string;
  /** Human-readable explanation, rendered beside the folder it is about. */
  error: string;
}

/**
 * The whole `skills` topic read model: one fresh scan, both halves.
 *
 * `libraryPath` is the absolute library root. The user owns that Git
 * repository, so the browser states where to author and maintain it; it is a
 * local path, never a URL the client fetches.
 */
export interface SkillLibraryList {
  libraryPath: string;
  skills: SkillSummary[];
  diagnostics: SkillDiagnostic[];
}

/**
 * Bound on ONE served `SKILL.md` body. A skill is instructions an agent reads,
 * so a file this size is already past what it can usefully carry; the bound
 * exists so a stray large file in a hand-authored folder cannot be turned into
 * an unbounded response by asking for it.
 */
export const MAX_SKILL_BODY_BYTES = 256 * 1024;

/** Bounds for the recursive supporting-file index and one-file reads. */
export const MAX_SKILL_TREE_ENTRIES = 1_000;
export const MAX_SKILL_TREE_DEPTH = 16;
export const MAX_SKILL_TREE_METADATA_BYTES = 256 * 1024;
export const MAX_SKILL_FILE_PREVIEW_BYTES = 256 * 1024;
export const MAX_SKILL_RAW_FILE_BYTES = 10 * 1024 * 1024;

/** One entry in a deterministic, skill-relative supporting-file tree. */
export interface SkillFileTreeEntry {
  type: "directory" | "file" | "symlink";
  name: string;
  /** Path relative to the selected skill folder. */
  path: string;
  /** Present for regular files and symlinks, never directories. */
  bytes?: number;
  /** Server-classified media type for regular files. */
  mimeType?: string;
  children?: SkillFileTreeEntry[];
}

export type SkillFileTreeLimit = "entries" | "depth" | "metadata-bytes";

/** Bounded recursive listing included with one skill detail. */
export interface SkillFileTree {
  entries: SkillFileTreeEntry[];
  entryCount: number;
  /** UTF-8 bytes consumed by included entry names, paths, and diagnostics. */
  metadataBytes: number;
  truncated: boolean;
  limits: SkillFileTreeLimit[];
  /** Non-fatal race/read diagnostics; never contains absolute paths. */
  diagnostics: string[];
}

/** JSON answer used by the bounded text/Markdown viewer on the raw-file route. */
export type SkillFilePreviewResponse =
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
 * One readable skill: the compact metadata the list already showed plus the
 * bounded `SKILL.md` body and supporting-file index.
 *
 * The body is the Markdown BELOW the frontmatter. The frontmatter's two fields
 * are `name` and `description`, which travel here as metadata, so rendering the
 * raw fence would only show the same values as YAML.
 *
 * `bytes` is the size of the whole file on disk, not of `markdown`: with
 * `truncated` it is what lets a reader see that there is more in the file than
 * the app is willing to serve.
 */
export interface SkillDetail {
  kind: "skill";
  /** Declared frontmatter name, the only way this skill is addressed. */
  name: string;
  description: string;
  /** Top-level source folder the scan found this in. */
  folder: string;
  /** Library-relative path of the source `SKILL.md`. */
  path: string;
  /** `SKILL.md` body below the frontmatter, bounded by the byte limit. */
  markdown: string;
  bytes: number;
  truncated: boolean;
  files: SkillFileTree;
}

/**
 * A name the library cannot currently answer for: the folder that declared it
 * is malformed or ambiguous, or the file changed between the scan and the read.
 *
 * This is deliberately a normal answer rather than a failure. The library is
 * hand-authored and scanned fresh on every read, so a skill can stop being
 * valid between the list and a click on it; the reader is owed the reason, not
 * a filesystem error.
 *
 * Not exported on its own: every consumer holds {@link SkillDetailResponse} and
 * narrows on `kind`, so a second way to name this half would only be somewhere
 * else for the two to drift apart.
 */
interface SkillDetailUnavailable {
  kind: "invalid";
  /** The requested declared name, echoed so a stale pane cannot be mistaken. */
  name: string;
  /** Present when a source folder could still be identified. */
  folder?: string;
  path?: string;
  error: string;
}

export type SkillDetailResponse = SkillDetail | SkillDetailUnavailable;

/**
 * The stored global state of one skill. There is no third value: a skill is
 * either deliberately on or it is not on. Deliberately not exported — every
 * consumer holds the whole {@link SkillToggles} map, and a second name for the
 * two literals would only be somewhere else to widen them.
 */
type SkillToggleState = "on" | "off";

/**
 * Global on/off state keyed by DECLARED skill name, not by source folder: the
 * name is what a session freezes and what a runtime layout materializes, and a
 * user who renames a folder has not changed which skill they enabled.
 *
 * The map is deliberately sparse and an absent name resolves OFF
 * ({@link isSkillEnabled}). Enabling is therefore always something the user
 * did, never something a missing entry, a fresh install or a failed read
 * produced. A stored `"off"` is the same answer said out loud; it is kept
 * rather than pruned so the map records what the user decided.
 */
export type SkillToggles = Record<string, SkillToggleState>;

/**
 * The ONE rule for reading the toggle map. Every surface — Settings, and later
 * injection — must ask this rather than test the entry itself, so "no entry"
 * can never be read as anything but off.
 */
export function isSkillEnabled(
  toggles: SkillToggles | undefined,
  name: string,
): boolean {
  return toggles?.[name] === "on";
}
