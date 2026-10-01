import { Buffer } from "node:buffer";
import type { FileHandle } from "node:fs/promises";
/**
 * The ONE rule for what a `SKILL.md` manifest may say, and the one way the app
 * writes it ([Task-633](pa://task/633), `docs/skills.md`).
 *
 * The scanner reports what a hand-authored folder got wrong; the authoring
 * tools refuse to write anything the scanner would then reject. Those are the
 * same question asked from two sides, so they must not be two schemas: this
 * module parses and validates the frontmatter, and the scanner only decorates
 * the issues it returns with the folder they belong to.
 *
 * Formatting is deterministic for the same reason. A tool-written manifest is
 * re-read by the scanner immediately afterwards, so `description` is emitted as
 * a JSON-quoted scalar — the shared YAML subset parses that back byte-for-byte,
 * including text with colons, `#`, or newlines in it, which a plain scalar
 * would silently mangle.
 */
import {
  isSafeSkillName,
  MAX_SKILL_BODY_BYTES,
  MAX_SKILL_NAME_CHARS,
  type SkillDiagnosticCode,
} from "@assistant/shared";
import { parseYamlSubset, splitYamlFrontmatter } from "../frontmatter.ts";

/** Bound on a declared description, shared by scanning and authoring. */
const MAX_SKILL_DESCRIPTION_CHARS = 1024;

/** One reason a manifest is not injectable, in the scanner's own vocabulary. */
interface SkillManifestIssue {
  code: SkillDiagnosticCode;
  error: string;
}

/** A manifest that satisfies every rule the scanner enforces. */
export interface SkillManifest {
  name: string;
  description: string;
  /** Markdown below the frontmatter, byte-for-byte as authored. */
  body: string;
}

export type SkillManifestResult =
  | { ok: true; manifest: SkillManifest }
  | {
      ok: false;
      issues: SkillManifestIssue[];
      /**
       * A safe declared name recovered despite other issues. Duplicate-name
       * detection needs it: a folder with a broken description still competes
       * for the name it declares.
       */
      name?: string;
    };

/** A manifest or path a mutation refuses to write. Thrown, never encoded. */
export class SkillValidationError extends Error {}

/**
 * Validate complete `SKILL.md` source. `path` only names the file in messages;
 * nothing is read from the filesystem here.
 */
export function parseSkillManifest(
  content: string,
  path: string,
): SkillManifestResult {
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

  const issues: SkillManifestIssue[] = [];
  const name = validateName(parsed.name, issues);
  const description = validateDescription(parsed.description, issues);
  if (issues.length > 0)
    return { ok: false, issues, ...(name !== undefined ? { name } : {}) };
  return {
    ok: true,
    manifest: { name: name!, description: description!, body },
  };
}

/**
 * Validate source a mutation is about to write, or has just written, and throw
 * one actionable message listing every problem at once.
 */
export function assertSkillManifest(
  content: string,
  path: string,
): SkillManifest {
  const result = parseSkillManifest(content, path);
  if (result.ok) return result.manifest;
  throw new SkillValidationError(
    `Invalid ${path}: ${result.issues.map((issue) => issue.error).join(" ")}`,
  );
}

/** Reject a description before it is ever written into frontmatter. */
export function assertSkillDescription(description: string): string {
  const issues: SkillManifestIssue[] = [];
  const validated = validateDescription(description, issues);
  if (validated === undefined)
    throw new SkillValidationError(
      issues.map((issue) => issue.error).join(" "),
    );
  return validated;
}

/** Reject a declared name before it is ever written or used as a folder. */
export function assertSafeSkillName(name: string, label = "name"): string {
  if (typeof name !== "string" || !isSafeSkillName(name)) {
    throw new SkillValidationError(
      `Invalid skill ${label} "${name}": must be 1-${MAX_SKILL_NAME_CHARS} lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.`,
    );
  }
  return name;
}

/**
 * Render complete `SKILL.md` source. The body is normalized to a trailing
 * newline and no leading blank line so repeated tool writes of the same
 * content produce the same bytes and therefore no empty commit.
 */
export function formatSkillManifest(manifest: {
  name: string;
  description: string;
  body: string;
}): string {
  const body = manifest.body
    .replace(/^(?:[^\S\r\n]*(?:\r\n|\n|\r))+/, "")
    .replace(/\s+$/, "");
  return [
    "---",
    `name: ${manifest.name}`,
    `description: ${JSON.stringify(manifest.description)}`,
    "---",
    "",
    ...(body ? [body, ""] : []),
  ].join("\n");
}

/**
 * Replace the declared name in existing source without reformatting the rest
 * of it: a rename must move a folder and change one field, not rewrite a file
 * the user hand-authored.
 */
export function withDeclaredName(
  content: string,
  path: string,
  name: string,
): string {
  const manifest = assertSkillManifest(content, path);
  const { yaml } = splitYamlFrontmatter(content, path);
  // Only the root mapping's own `name:` line, which a valid manifest always has
  // at zero indentation — never an indented `name` inside some nested value.
  const replaced = yaml.replace(/^name:[^\n]*$/m, () => `name: ${name}`);
  if (replaced === yaml && manifest.name !== name) {
    throw new SkillValidationError(
      `Cannot rewrite the declared name in ${path}: its frontmatter has no plain "name:" line.`,
    );
  }
  // The first occurrence of the frontmatter text IS the frontmatter: the file
  // starts with the opening fence, so nothing in the body can precede it.
  return content.replace(yaml, () => replaced);
}

function validateName(
  name: unknown,
  issues: SkillManifestIssue[],
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
  if (!isSafeSkillName(name)) {
    issues.push({
      code: "unsafe-name",
      error: `Frontmatter name must be 1-${MAX_SKILL_NAME_CHARS} lowercase letters, digits, or single hyphens, with no leading or trailing hyphen.`,
    });
    return undefined;
  }
  return name;
}

function validateDescription(
  description: unknown,
  issues: SkillManifestIssue[],
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
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    issues.push({
      code: "description-too-long",
      error: `Frontmatter description must be at most ${MAX_SKILL_DESCRIPTION_CHARS} characters.`,
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
 * Read one `SKILL.md` through an open handle, bounded.
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
  cap: number = MAX_SKILL_BODY_BYTES,
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
