import { Buffer } from "node:buffer";
import type { FileHandle } from "node:fs/promises";
/**
 * The shared half of every library manifest rule, and the one way the app
 * writes a manifest ([Task-633](pa://task/633), `docs/skills.md`).
 *
 * The scanner reports what a hand-authored folder got wrong; the authoring
 * tools refuse to write anything the scanner would then reject. Those are the
 * same question asked from two sides, so they must not be two schemas: a kind's
 * {@link LibraryKind.parseManifest} is the whole rule, built from the pieces
 * here, and the scanner only decorates the issues it returns with the folder
 * they belong to.
 *
 * Formatting is deterministic for the same reason. A tool-written manifest is
 * re-read by the scanner immediately afterwards, so a string is emitted as a
 * JSON-quoted scalar — the shared YAML subset parses that back byte-for-byte,
 * including text with colons, `#`, or newlines in it, which a plain scalar
 * would silently mangle.
 */
import {
  isSafeEntryName,
  MAX_ENTRY_BODY_BYTES,
  MAX_ENTRY_NAME_CHARS,
  type EntryDiagnosticCode,
} from "@assistant/shared";
import {
  parseYamlSubset,
  splitYamlFrontmatter,
} from "@assistant/shared/frontmatter";
import { withArticle, type LibraryKind } from "./libraryKind.ts";

/** Bound on a declared description, shared by scanning and authoring. */
const MAX_ENTRY_DESCRIPTION_CHARS = 1024;

/** One reason a manifest is not usable, in the scanner's own vocabulary. */
export interface ManifestIssue {
  code: EntryDiagnosticCode;
  error: string;
}

/** The fields every library manifest has. */
export interface EntryManifest {
  name: string;
  description: string;
  /** Markdown below the frontmatter, byte-for-byte as authored. */
  body: string;
}

export type ManifestResult<M extends EntryManifest = EntryManifest> =
  | { ok: true; manifest: M }
  | {
      ok: false;
      issues: ManifestIssue[];
      /**
       * A safe declared name recovered despite other issues. Duplicate-name
       * detection needs it: a folder with a broken description still competes
       * for the name it declares.
       */
      name?: string;
    };

/** A manifest or path a mutation refuses to write. Thrown, never encoded. */
export class EntryValidationError extends Error {}

/**
 * Split complete manifest source into its frontmatter mapping and body, or the
 * one issue that stops it. `path` only names the file in messages; nothing is
 * read from the filesystem here.
 */
function parseManifestFrontmatter(
  content: string,
  path: string,
):
  | { ok: true; fields: Record<string, unknown>; body: string }
  | { ok: false; issues: ManifestIssue[] } {
  let yaml: string;
  let body: string;
  try {
    ({ yaml, body } = splitYamlFrontmatter(content, path));
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "invalid-frontmatter", error: errorMessage(error) }],
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlSubset(yaml, `${path} frontmatter`);
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "invalid-yaml", error: errorMessage(error) }],
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid-yaml",
          error: `Invalid YAML in ${path} frontmatter: expected a mapping.`,
        },
      ],
    };
  }
  return { ok: true, fields: parsed, body };
}

/**
 * The rule every kind shares: a safe `name` and a bounded `description`.
 * Skills use it as their whole rule.
 */
export function parseEntryManifest(
  content: string,
  path: string,
): ManifestResult {
  return parseManifestWith(content, path, () => ({}));
}

/**
 * A kind's whole rule: the shared `name` + `description` checks, then the
 * kind's own fields validated by `extend` from the same frontmatter mapping
 * (and the body, for a kind whose size bound lets it read one) into the same
 * issue list. `extend` returns the extra manifest fields; they
 * are used only when no issue was recorded by either half, and the recovered
 * name still reaches duplicate detection when the extra fields are wrong.
 */
export function parseManifestWith<E extends object>(
  content: string,
  path: string,
  extend: (
    fields: Record<string, unknown>,
    issues: ManifestIssue[],
    body: string,
  ) => E,
): ManifestResult<EntryManifest & E> {
  const split = parseManifestFrontmatter(content, path);
  if (!split.ok) return split;
  const issues: ManifestIssue[] = [];
  const name = validateName(split.fields.name, issues);
  const description = validateDescription(split.fields.description, issues);
  const extra = extend(split.fields, issues, split.body);
  if (issues.length > 0)
    return { ok: false, issues, ...(name !== undefined ? { name } : {}) };
  return {
    ok: true,
    manifest: {
      ...extra,
      name: name!,
      description: description!,
      body: split.body,
    },
  };
}

/**
 * Validate source a mutation is about to write, or has just written, against
 * the kind's whole rule, and throw one actionable message listing every
 * problem at once.
 */
export function assertManifest<M extends EntryManifest>(
  kind: LibraryKind<M>,
  content: string,
  path: string,
): M {
  const result = kind.parseManifest(content, path);
  if (result.ok) return result.manifest;
  throw new EntryValidationError(
    `Invalid ${path}: ${result.issues.map((issue) => issue.error).join(" ")}`,
  );
}

/**
 * Why a manifest of `bytes` (its real size on disk, or the size about to be
 * written) is past its kind's own bound, or nothing when it is within it.
 */
export function manifestSizeIssue(
  kind: LibraryKind,
  bytes: number,
  path: string,
  /** The size of source about to be written, rather than of a file on disk. */
  prospective = false,
): ManifestIssue | undefined {
  const limit = kind.maxManifestBytes;
  if (limit === undefined || bytes <= limit) return undefined;
  return {
    code: "manifest-too-large",
    error: `${path} ${prospective ? "would be" : "is"} ${bytes} bytes, above the ${limit}-byte limit for ${withArticle(kind.noun)} manifest.`,
  };
}

/** Throw {@link manifestSizeIssue} as a refusal. */
export function assertManifestSize(
  kind: LibraryKind,
  bytes: number,
  path: string,
  prospective = false,
): void {
  const issue = manifestSizeIssue(kind, bytes, path, prospective);
  if (issue) throw new EntryValidationError(issue.error);
}

/** Reject a description before it is ever written into frontmatter. */
export function assertEntryDescription(description: string): string {
  const issues: ManifestIssue[] = [];
  const validated = validateDescription(description, issues);
  if (validated === undefined)
    throw new EntryValidationError(
      issues.map((issue) => issue.error).join(" "),
    );
  return validated;
}

/** Reject a declared name before it is ever written or used as a folder. */
export function assertSafeEntryName(
  kind: LibraryKind,
  name: string,
  label = "name",
): string {
  if (typeof name !== "string" || !isSafeEntryName(name)) {
    throw new EntryValidationError(
      `Invalid ${kind.noun} ${label} "${name}": must be 1-${MAX_ENTRY_NAME_CHARS} lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.`,
    );
  }
  return name;
}

/**
 * A string as a frontmatter scalar the shared YAML subset parses back
 * byte-for-byte: JSON-quoted, with U+2028/U+2029 escaped too — JSON leaves
 * them raw, and a raw line separator ends the subset's `key: value` line.
 */
export function yamlString(value: string): string {
  return JSON.stringify(value).replace(/[\u2028\u2029]/g, (separator) =>
    separator === "\u2028" ? "\\u2028" : "\\u2029",
  );
}

/**
 * Render complete manifest source from frontmatter lines already rendered as
 * YAML (`name: x`, `description: "..."`). The body is normalized to a trailing
 * newline and no leading blank line so repeated tool writes of the same content
 * produce the same bytes and therefore no empty commit.
 */
export function formatManifest(frontmatter: string[], body: string): string {
  const normalized = body
    .replace(/^(?:[^\S\r\n]*(?:\r\n|\n|\r))+/, "")
    .replace(/\s+$/, "");
  return [
    "---",
    ...frontmatter,
    "---",
    "",
    ...(normalized ? [normalized, ""] : []),
  ].join("\n");
}

/**
 * Replace the declared name in existing source without reformatting the rest
 * of it: a rename must move a folder and change one field, not rewrite a file
 * the user hand-authored.
 */
export function withDeclaredName(
  kind: LibraryKind,
  content: string,
  path: string,
  name: string,
): string {
  const manifest = assertManifest(kind, content, path);
  const { yaml } = splitYamlFrontmatter(content, path);
  // Only the root mapping's own `name:` line, which a valid manifest always has
  // at zero indentation — never an indented `name` inside some nested value.
  const replaced = yaml.replace(/^name:[^\n]*$/m, () => `name: ${name}`);
  if (replaced === yaml && manifest.name !== name) {
    throw new EntryValidationError(
      `Cannot rewrite the declared name in ${path}: its frontmatter has no plain "name:" line.`,
    );
  }
  // The first occurrence of the frontmatter text IS the frontmatter: the file
  // starts with the opening fence, so nothing in the body can precede it.
  return content.replace(yaml, () => replaced);
}

function validateName(
  name: unknown,
  issues: ManifestIssue[],
): string | undefined {
  if (name === undefined) {
    issues.push({ code: "missing-name", error: "Missing frontmatter name." });
    return undefined;
  }
  if (typeof name !== "string") {
    issues.push({
      code: "non-string-name",
      error: "Frontmatter name must be a string.",
    });
    return undefined;
  }
  if (!isSafeEntryName(name)) {
    issues.push({
      code: "unsafe-name",
      error: `Frontmatter name must be 1-${MAX_ENTRY_NAME_CHARS} lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.`,
    });
    return undefined;
  }
  return name;
}

function validateDescription(
  description: unknown,
  issues: ManifestIssue[],
): string | undefined {
  if (description === undefined) {
    issues.push({
      code: "missing-description",
      error: "Missing frontmatter description.",
    });
    return undefined;
  }
  if (typeof description !== "string") {
    issues.push({
      code: "non-string-description",
      error: "Frontmatter description must be a string.",
    });
    return undefined;
  }
  if (description.trim() === "") {
    issues.push({
      code: "empty-description",
      error: "Frontmatter description must not be empty or whitespace-only.",
    });
    return undefined;
  }
  if (description.length > MAX_ENTRY_DESCRIPTION_CHARS) {
    issues.push({
      code: "description-too-long",
      error: `Frontmatter description must be at most ${MAX_ENTRY_DESCRIPTION_CHARS} characters.`,
    });
    return undefined;
  }
  return description;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read one manifest through an open handle, bounded.
 *
 * A manifest is frontmatter plus instructions an agent reads, so the bound is
 * also the useful size; `truncated` says the file is past it, which is a
 * refusal for a mutation and a diagnostic for a scan. Nothing reads a manifest
 * unbounded — the scan runs on every list and every mutation, and one stray
 * hand-authored file would otherwise be re-read in full every time.
 */
export async function readManifestHandle(
  handle: FileHandle,
  size: number,
  cap: number = MAX_ENTRY_BODY_BYTES,
): Promise<{ source: string; bytes: number; truncated: boolean }> {
  const limit = Math.min(size, cap);
  const buffer = Buffer.alloc(limit);
  let position = 0;
  while (position < limit) {
    const { bytesRead } = await handle.read(
      buffer,
      position,
      limit - position,
      position,
    );
    if (bytesRead === 0) break;
    position += bytesRead;
  }
  return {
    source: new TextDecoder("utf-8").decode(buffer.subarray(0, position), {
      stream: true,
    }),
    bytes: size,
    truncated: size > cap,
  };
}
