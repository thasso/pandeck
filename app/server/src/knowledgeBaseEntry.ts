import {
  isPaRelationLink,
  parsePaObjectLink,
} from "@assistant/shared/objectLinks";
import {
  parseYamlSubset,
  splitYamlFrontmatter,
} from "@assistant/shared/frontmatter";
import {
  classifyKnowledgePath,
  isGeneratedKnowledgePath,
  KB_ENTRY_ASSETS_DIR,
  KB_ENTRY_STATUSES,
  KB_GENERATED_DIR,
  KB_ENTRY_TYPES,
  KB_SCHEMA_VERSION,
  KB_SOURCE_KINDS,
  normalizeKnowledgeRelativePath,
  type KbAssetRefV1,
  type KbEntryFrontmatterV1,
  type KbEntryMetadataV1,
  type KbSourceRefV1,
} from "./knowledgeBaseContract.ts";
import {
  KnowledgeBaseError,
  KnowledgeBaseStore,
  type KbCommitMeta,
  type KbCommitResult,
  type KbFileChange,
} from "./knowledgeBaseStore.ts";

export interface KbEntryDocument {
  frontmatter: KbEntryFrontmatterV1;
  body: string;
}

export interface KbEntryValidationResult {
  ok: true;
  metadata: KbEntryMetadataV1;
  bodyBytes: number;
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const KB_ID_RE = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const WRAP_COLUMN = 80;

export function parseKbEntryMarkdown(
  content: string,
  path = "index.md",
): KbEntryDocument {
  let frontmatter: { yaml: string; body: string };
  try {
    frontmatter = splitYamlFrontmatter(content, path);
  } catch {
    throw new KnowledgeBaseError(
      `Invalid KB entry ${path}: entry Markdown must start with YAML frontmatter delimited by --- lines.`,
    );
  }
  const parsed = parseKnowledgeYaml(frontmatter.yaml, `${path} frontmatter`);
  return {
    frontmatter: validateKbFrontmatter(parsed, path),
    body: frontmatter.body,
  };
}

function parseKnowledgeYaml(yaml: string, path: string): unknown {
  try {
    return parseYamlSubset(yaml, path);
  } catch (err) {
    throw new KnowledgeBaseError(
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function validateKbEntryMarkdown(
  content: string,
  path = "index.md",
): KbEntryValidationResult {
  const doc = parseKbEntryMarkdown(content, path);
  return {
    ok: true,
    metadata: doc.frontmatter.kb,
    bodyBytes: Buffer.byteLength(doc.body, "utf8"),
  };
}

export function formatKbEntryMarkdown(
  content: string,
  path = "index.md",
): string {
  return formatKbEntryDocument(parseKbEntryMarkdown(content, path));
}

export function formatKbEntryDocument(doc: KbEntryDocument): string {
  const frontmatter = formatYamlValue(doc.frontmatter).trimEnd();
  const body = wrapMarkdownProse(doc.body.trim(), WRAP_COLUMN);
  return `---\n${frontmatter}\n---\n${body ? `${body}\n` : ""}`;
}

export function formatKnowledgeTextFile(path: string, content: string): string {
  const kind = classifyKnowledgePath(path);
  if (kind === "entry-index") return formatKbEntryMarkdown(content, path);
  if (/\.json$/i.test(path))
    return `${JSON.stringify(JSON.parse(content), null, 2)}\n`;
  if (/\.jsonl$/i.test(path)) return formatJsonl(content, path);
  if (/\.ya?ml$/i.test(path))
    return `${formatYamlValue(parseKnowledgeYaml(content, path)).trimEnd()}\n`;
  if (/\.md$/i.test(path))
    return `${wrapMarkdownProse(content.trim(), WRAP_COLUMN)}\n`;
  return content;
}

/**
 * Tool-facing mutation helper for KB source writes.
 *
 * It validates and deterministically formats all text-like writes before the
 * storage layer touches the filesystem. Future KB tools should call this rather
 * than `KnowledgeBaseStore.commitChanges` directly for user/agent supplied
 * Markdown, YAML, JSON, and JSONL content.
 */
export async function commitValidatedKnowledgeChanges(
  store: KnowledgeBaseStore,
  changes: KbFileChange[],
  meta: KbCommitMeta,
): Promise<KbCommitResult> {
  const prepared: KbFileChange[] = [];
  const entryWrites: { path: string; id: string }[] = [];
  const deletedEntryPaths = new Set<string>();

  for (const change of changes) {
    const path = normalizeKnowledgeRelativePath(change.path);
    const kind = classifyKnowledgePath(path);
    if (change.op === "delete") {
      if (kind === "entry-index") deletedEntryPaths.add(path);
      prepared.push({ ...change, path });
      continue;
    }
    const textLike =
      kind !== "asset" &&
      (kind === "entry-index" || /\.(md|json|jsonl|ya?ml)$/i.test(path));
    if (!textLike) {
      prepared.push({ ...change, path });
      continue;
    }
    if (typeof change.content !== "string") {
      throw new KnowledgeBaseError(
        `Invalid KB write ${path}: text-like KB files must be written as UTF-8 strings.`,
      );
    }
    const content = formatKnowledgeTextFile(path, change.content);
    if (kind === "entry-index")
      entryWrites.push({
        path,
        id: parseKbEntryMarkdown(content, path).frontmatter.kb.id,
      });
    prepared.push({ ...change, path, content });
  }

  assertUniqueEntryIdsInChangeSet(entryWrites);
  return store.commitChanges(prepared, meta, {
    beforeApply: async () => {
      await assertUniqueEntryIdsInRepo(store, entryWrites, deletedEntryPaths);
    },
  });
}

function assertUniqueEntryIdsInChangeSet(
  entryWrites: { path: string; id: string }[],
): void {
  const byId = new Map<string, string>();
  for (const entry of entryWrites) {
    const existingPath = byId.get(entry.id);
    if (existingPath && existingPath !== entry.path) {
      throw new KnowledgeBaseError(
        `Duplicate KB entry id "${entry.id}" in change set: "${existingPath}" and "${entry.path}". kb.id must be unique across the knowledge base.`,
      );
    }
    byId.set(entry.id, entry.path);
  }
}

async function assertUniqueEntryIdsInRepo(
  store: KnowledgeBaseStore,
  entryWrites: { path: string; id: string }[],
  deletedEntryPaths: Set<string>,
): Promise<void> {
  if (entryWrites.length === 0) return;
  const writeByPath = new Map(
    entryWrites.map((entry) => [entry.path, entry.id]),
  );
  const writePaths = new Set(writeByPath.keys());
  const writeIds = new Map(entryWrites.map((entry) => [entry.id, entry.path]));
  const nodes = await store.listTree();
  for (const node of nodes) {
    if (node.kind !== "entry-index") continue;
    if (writePaths.has(node.path) || deletedEntryPaths.has(node.path)) continue;
    let existing: KbEntryDocument;
    try {
      existing = parseKbEntryMarkdown(
        await store.readEntryFile(node.path),
        node.path,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new KnowledgeBaseError(
        `Cannot verify KB entry id uniqueness because existing entry "${node.path}" has invalid frontmatter: ${message}`,
      );
    }
    const newPath = writeIds.get(existing.frontmatter.kb.id);
    if (newPath) {
      throw new KnowledgeBaseError(
        `Duplicate KB entry id "${existing.frontmatter.kb.id}": new entry "${newPath}" collides with existing entry "${node.path}". kb.id must be unique across the knowledge base.`,
      );
    }
  }
}

function validateKbFrontmatter(
  value: unknown,
  path: string,
): KbEntryFrontmatterV1 {
  const root = expectObject(value, "frontmatter");
  rejectUnknownKeys(root, ["kb"], "frontmatter");
  const kb = expectObject(root.kb, "kb");
  rejectUnknownKeys(
    kb,
    [
      "schema",
      "id",
      "type",
      "title",
      "status",
      "summary",
      "tags",
      "aliases",
      "links",
      "createdAt",
      "updatedAt",
      "source",
      "assets",
    ],
    "kb",
  );

  const metadata: KbEntryMetadataV1 = {
    schema: expectLiteral(kb.schema, KB_SCHEMA_VERSION, "kb.schema"),
    id: expectKbId(kb.id, "kb.id"),
    type: expectEnum(kb.type, KB_ENTRY_TYPES, "kb.type"),
    title: expectNonEmptyString(kb.title, "kb.title"),
    status: expectEnum(kb.status, KB_ENTRY_STATUSES, "kb.status"),
    createdAt: expectIsoTimestamp(kb.createdAt, "kb.createdAt"),
    updatedAt: expectIsoTimestamp(kb.updatedAt, "kb.updatedAt"),
  };

  if (kb.summary !== undefined)
    metadata.summary = expectNonEmptyString(kb.summary, "kb.summary");
  if (kb.tags !== undefined)
    metadata.tags = expectStringList(kb.tags, "kb.tags");
  if (kb.aliases !== undefined)
    metadata.aliases = expectStringList(kb.aliases, "kb.aliases");
  if (kb.links !== undefined)
    metadata.links = expectPaLinks(kb.links, "kb.links");
  if (kb.source !== undefined)
    metadata.source = expectSource(kb.source, "kb.source");
  if (kb.assets !== undefined)
    metadata.assets = expectAssets(kb.assets, "kb.assets");

  if (Date.parse(metadata.updatedAt) < Date.parse(metadata.createdAt)) {
    throw new KnowledgeBaseError(
      `Invalid KB entry ${path}: kb.updatedAt must not be earlier than kb.createdAt.`,
    );
  }
  return { kb: metadata };
}

function expectSource(value: unknown, field: string): KbSourceRefV1 {
  const source = expectObject(value, field);
  rejectUnknownKeys(source, ["kind", "refs"], field);
  const result: KbSourceRefV1 = {
    kind: expectEnum(source.kind, KB_SOURCE_KINDS, `${field}.kind`),
  };
  if (source.refs !== undefined)
    result.refs = expectSourceRefs(source.refs, `${field}.refs`);
  return result;
}

function expectAssets(value: unknown, field: string): KbAssetRefV1[] {
  if (!Array.isArray(value))
    throw fieldError(field, "expected an array of asset metadata records.");
  return value.map((item, index) => {
    const itemField = `${field}[${index}]`;
    const asset = expectObject(item, itemField);
    rejectUnknownKeys(
      asset,
      ["path", "title", "mimeType", "kind", "extractPath"],
      itemField,
    );
    const path = expectAssetPath(asset.path, `${itemField}.path`);
    const result: KbAssetRefV1 = { path };
    if (asset.title !== undefined)
      result.title = expectNonEmptyString(asset.title, `${itemField}.title`);
    if (asset.mimeType !== undefined)
      result.mimeType = expectNonEmptyString(
        asset.mimeType,
        `${itemField}.mimeType`,
      );
    if (asset.kind !== undefined)
      result.kind = expectEnum(
        asset.kind,
        ["source", "generated-extract"] as const,
        `${itemField}.kind`,
      );
    if (asset.extractPath !== undefined)
      result.extractPath = expectGeneratedPath(
        asset.extractPath,
        `${itemField}.extractPath`,
      );
    return result;
  });
}

function expectGeneratedPath(value: unknown, field: string): string {
  const path = expectNonEmptyString(value, field);
  try {
    const normalized = normalizeKnowledgeRelativePath(path);
    if (
      !isGeneratedKnowledgePath(normalized) ||
      !normalized.startsWith(`${KB_GENERATED_DIR}/extracts/`)
    ) {
      throw new Error("not an extract");
    }
    return normalized;
  } catch {
    throw fieldError(
      field,
      "expected a relative path under .kb/generated/extracts/.",
    );
  }
}

function expectAssetPath(value: unknown, field: string): string {
  const path = expectNonEmptyString(value, field);
  try {
    const normalized = normalizeKnowledgeRelativePath(path);
    if (!normalized.startsWith(`${KB_ENTRY_ASSETS_DIR}/`)) {
      throw new Error("not an entry asset");
    }
    return normalized;
  } catch {
    throw fieldError(
      field,
      "expected a relative entry-local asset path such as assets/source.pdf.",
    );
  }
}

function expectSourceRefs(value: unknown, field: string): string[] {
  const refs = expectStringList(value, field);
  for (const ref of refs) {
    const parsed = parsePaObjectLink(ref);
    const isPa = parsed ? isPaRelationLink(parsed) : false;
    let isUrl = false;
    try {
      const url = new URL(ref);
      isUrl = url.protocol === "http:" || url.protocol === "https:";
    } catch {
      isUrl = false;
    }
    if (!isPa && !isUrl)
      throw fieldError(
        field,
        `invalid source reference "${ref}"; expected http(s) URL or known pa:// link.`,
      );
  }
  return refs;
}

function expectPaLinks(value: unknown, field: string): string[] {
  const links = expectStringList(value, field);
  for (const link of links) {
    const parsed = parsePaObjectLink(link);
    if (!parsed || !isPaRelationLink(parsed))
      throw fieldError(
        field,
        `invalid link "${link}"; expected a known pa:// object link.`,
      );
  }
  return links;
}

function expectStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value))
    throw fieldError(field, "expected an array of non-empty strings.");
  const list = value.map((item, index) =>
    expectNonEmptyString(item, `${field}[${index}]`),
  );
  const seen = new Set<string>();
  for (const item of list) {
    if (seen.has(item))
      throw fieldError(field, `duplicate value "${item}" is not allowed.`);
    seen.add(item);
  }
  return list;
}

function expectKbId(value: unknown, field: string): string {
  const id = expectNonEmptyString(value, field);
  if (!KB_ID_RE.test(id)) {
    throw fieldError(
      field,
      "expected a stable lowercase id using letters, digits, '.', '_', or '-' (2-128 chars). ",
    );
  }
  return id;
}

function expectIsoTimestamp(value: unknown, field: string): string {
  const text = expectNonEmptyString(value, field);
  const parsed = new Date(text);
  const normalized = text.includes(".") ? text : text.replace("Z", ".000Z");
  if (
    !ISO_TIMESTAMP_RE.test(text) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== normalized
  ) {
    throw fieldError(
      field,
      "expected a valid ISO-8601 UTC timestamp such as 2026-07-07T10:00:00.000Z.",
    );
  }
  return text;
}

function expectLiteral<T extends string | number | boolean>(
  value: unknown,
  literal: T,
  field: string,
): T {
  if (value !== literal) {
    throw fieldError(
      field,
      `expected the literal ${JSON.stringify(literal)}, received ${describeReceived(value)}.`,
    );
  }
  return literal;
}

function expectEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw fieldError(
      field,
      `expected one of: ${values.join(", ")}; received ${describeReceived(value)}.`,
    );
  }
  return value as T[number];
}

/** Compact, bounded description of an invalid scalar for actionable field errors. */
function describeReceived(value: unknown): string {
  if (value === undefined) return "nothing";
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function expectNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw fieldError(field, "expected a non-empty string.");
  return value.trim();
}

function expectObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fieldError(field, "expected an object.");
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key))
      throw fieldError(
        `${field}.${key}`,
        `unknown field; expected one of: ${allowed.join(", ")}.`,
      );
  }
}

function fieldError(field: string, message: string): KnowledgeBaseError {
  return new KnowledgeBaseError(
    `Invalid KB frontmatter field ${field}: ${message}`,
  );
}

function formatJsonl(content: string, path: string): string {
  const lines: string[] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      lines.push(JSON.stringify(JSON.parse(line)));
    } catch (err) {
      throw new KnowledgeBaseError(
        `Invalid JSONL in ${path} line ${index + 1}: ${String(err)}`,
      );
    }
  });
  return `${lines.join("\n")}\n`;
}

function formatYamlValue(value: unknown, indent = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${" ".repeat(indent)}[]\n`;
    return value
      .map((item) => {
        if (isPlainRecord(item)) {
          const formatted = formatYamlValue(item, indent + 2)
            .trimEnd()
            .split("\n");
          const [first = "", ...rest] = formatted;
          return `${" ".repeat(indent)}- ${first.trimStart()}\n${rest.join("\n")}${rest.length ? "\n" : ""}`;
        }
        return `${" ".repeat(indent)}- ${formatYamlScalar(item)}\n`;
      })
      .join("");
  }
  if (isPlainRecord(value)) {
    return Object.entries(value)
      .map(([key, item]) => {
        if (Array.isArray(item) && item.length === 0)
          return `${" ".repeat(indent)}${key}: []\n`;
        if (Array.isArray(item) || isPlainRecord(item))
          return `${" ".repeat(indent)}${key}:\n${formatYamlValue(item, indent + 2)}`;
        return `${" ".repeat(indent)}${key}: ${formatYamlScalar(item)}\n`;
      })
      .join("");
  }
  return `${" ".repeat(indent)}${formatYamlScalar(value)}\n`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function formatYamlScalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null) return "null";
  const text = String(value);
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(text)
    ? text
    : JSON.stringify(text);
}

function wrapMarkdownProse(markdown: string, width: number): string {
  const input = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let inFence = false;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(
      ...wrapLine(paragraph.join(" ").replace(/\s+/g, " ").trim(), width),
    );
    paragraph = [];
  };

  for (const line of input) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      flushParagraph();
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || !isWrappableMarkdownLine(line)) {
      flushParagraph();
      out.push(line.trimEnd());
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      if (out.at(-1) !== "") out.push("");
      continue;
    }
    const listMatch = /^(\s*(?:[-*+] |\d+\.\s+))(.*)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      const [, prefix = "", text = ""] = listMatch;
      out.push(
        ...wrapLine(text.trim(), width, prefix, " ".repeat(prefix.length)),
      );
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  while (out.at(-1) === "") out.pop();
  return out.join("\n");
}

function isWrappableMarkdownLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^(#{1,6}\s|>|[-*_]{3,}\s*$)/.test(trimmed)) return false;
  if (/^\s{4}/.test(line)) return false;
  if (line.includes("|") && /^\s*\|?\s*[-:]+/.test(trimmed)) return false;
  if (line.includes("|") && trimmed.split("|").length >= 3) return false;
  return true;
}

function wrapLine(
  text: string,
  width: number,
  firstPrefix = "",
  nextPrefix = "",
): string[] {
  if (!text) return [firstPrefix.trimEnd()];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let prefix = firstPrefix;
  let current = prefix;
  for (const word of words) {
    const candidate =
      current.trimEnd() === prefix.trimEnd()
        ? `${prefix}${word}`
        : `${current} ${word}`;
    if (
      candidate.length > width &&
      current.trim() &&
      !/^https?:\/\//.test(word)
    ) {
      lines.push(current.trimEnd());
      prefix = nextPrefix;
      current = `${prefix}${word}`;
    } else {
      current = candidate;
    }
  }
  lines.push(current.trimEnd());
  return lines;
}
