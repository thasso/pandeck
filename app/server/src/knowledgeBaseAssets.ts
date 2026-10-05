import { Buffer } from "node:buffer";
import {
  KB_ENTRY_ASSETS_DIR,
  KB_GENERATED_DIR,
  normalizeKnowledgeRelativePath,
  type KbAssetRefV1,
} from "./knowledgeBaseContract.ts";
import {
  commitValidatedKnowledgeChanges,
  formatKbEntryDocument,
  parseKbEntryMarkdown,
} from "./knowledgeBaseEntry.ts";
import { getKnowledgeIndex, type KbIndexEntry } from "./knowledgeBaseIndex.ts";
import {
  KnowledgeBaseError,
  KnowledgeBaseStore,
  type KbBoundedBytes,
  type KbCommitMeta,
  type KbCommitResult,
} from "./knowledgeBaseStore.ts";

const KB_ASSET_MAX_WRITE_BYTES = 50 * 1024 * 1024;
const KB_ASSET_MAX_READ_BYTES = 10 * 1024 * 1024;
const KB_ASSET_TEXT_PREVIEW_CHARS = 16_000;
const KB_GENERATED_EXTRACT_MAX_WRITE_BYTES = 2 * 1024 * 1024;
const KB_GENERATED_EXTRACT_MAX_READ_BYTES = 128 * 1024;

export interface KbEntryRef {
  /** Stable `kb.id`. Preferred when known. */
  entryId?: string;
  /** Entry `index.md` path, or the entry folder path. */
  entryPath?: string;
}

interface KbResolvedEntry {
  id: string;
  path: string;
  folder: string;
  title: string;
}

interface KbAssetMetadataInput {
  title?: string;
  mimeType?: string;
}

export interface KbAddAssetInput extends KbEntryRef, KbAssetMetadataInput {
  /** Entry-local path such as `assets/source.pdf`. */
  assetPath: string;
  content: string | Uint8Array;
  /** Optional generated text/OCR extracted from the source asset. */
  extractText?: string;
  /** Deterministic timestamp for tests/imports; defaults to now. */
  updatedAt?: string;
  maxBytes?: number;
}

interface KbAssetRecord {
  /** Entry-local path stored in frontmatter, for example `assets/source.pdf`. */
  path: string;
  /** Source-of-truth path in the KB repo, for example `entry/assets/source.pdf`. */
  sourcePath: string;
  title?: string;
  mimeType?: string;
  kind: "source" | "generated-extract";
  exists: boolean;
  metadataDeclared: boolean;
  sizeBytes?: number;
  extract?: {
    path: string;
    exists: boolean;
    sizeBytes?: number;
  };
}

export interface KbAssetList {
  entry: KbResolvedEntry;
  assets: KbAssetRecord[];
}

export interface KbAddAssetResult {
  entry: KbResolvedEntry;
  asset: KbAssetRecord;
  commit: KbCommitResult;
  extractPath?: string;
}

export interface KbReadAssetInput extends KbEntryRef {
  assetPath: string;
  maxBytes?: number;
}

export interface KbReadAssetResult extends KbBoundedBytes {
  entry: KbResolvedEntry;
  asset: KbAssetRecord;
}

export interface KbReadAssetTextResult {
  entry: KbResolvedEntry;
  asset: KbAssetRecord;
  text: string;
  sizeBytes: number;
  truncated: boolean;
}

export interface KbReadGeneratedExtractResult {
  path: string;
  text: string;
  sizeBytes: number;
  truncated: boolean;
}

export async function addKnowledgeAsset(
  store: KnowledgeBaseStore,
  input: KbAddAssetInput,
  meta: KbCommitMeta,
): Promise<KbAddAssetResult> {
  const entry = await resolveKnowledgeEntry(store, input);
  const assetPath = normalizeEntryLocalAssetPath(input.assetPath);
  const sourcePath = joinEntryAssetPath(entry.folder, assetPath);
  const content = toWritableContent(input.content);
  const maxBytes = input.maxBytes ?? KB_ASSET_MAX_WRITE_BYTES;
  const contentBytes =
    typeof content === "string"
      ? Buffer.byteLength(content, "utf8")
      : content.byteLength;
  if (contentBytes > maxBytes) {
    throw new KnowledgeBaseError(
      `Asset "${assetPath}" is ${contentBytes} bytes; maximum allowed write is ${maxBytes} bytes.`,
    );
  }

  const entryDoc = parseKbEntryMarkdown(
    await store.readEntryFile(entry.path),
    entry.path,
  );
  const assetRef: KbAssetRefV1 = { path: assetPath, kind: "source" };
  if (input.title !== undefined)
    assetRef.title = nonEmpty(input.title, "title");
  if (input.mimeType !== undefined)
    assetRef.mimeType = nonEmpty(input.mimeType, "mimeType");

  let extractPath: string | undefined;
  if (input.extractText !== undefined) {
    const extractBytes = Buffer.byteLength(input.extractText, "utf8");
    if (extractBytes > KB_GENERATED_EXTRACT_MAX_WRITE_BYTES) {
      throw new KnowledgeBaseError(
        `Generated extract for "${assetPath}" is ${extractBytes} bytes; maximum allowed write is ${KB_GENERATED_EXTRACT_MAX_WRITE_BYTES} bytes.`,
      );
    }
    const extractName = generatedExtractName(entry.id, assetPath);
    await store.writeGeneratedFile(
      extractName,
      ensureTrailingNewline(input.extractText),
    );
    extractPath = `${KB_GENERATED_DIR}/${extractName}`;
    assetRef.extractPath = extractPath;
  }

  entryDoc.frontmatter.kb.assets = upsertAssetRef(
    entryDoc.frontmatter.kb.assets ?? [],
    assetRef,
  );
  entryDoc.frontmatter.kb.updatedAt =
    input.updatedAt ?? new Date().toISOString();
  const indexContent = formatKbEntryDocument(entryDoc);
  const commit = await commitValidatedKnowledgeChanges(
    store,
    [
      { op: "write", path: sourcePath, content },
      { op: "write", path: entry.path, content: indexContent },
    ],
    { ...meta, entryIds: unique([...(meta.entryIds ?? []), entry.id]) },
  );

  const list = await listKnowledgeAssets(store, { entryId: entry.id });
  const asset = list.assets.find((candidate) => candidate.path === assetPath);
  if (!asset)
    throw new KnowledgeBaseError(
      `Asset "${assetPath}" was written but could not be listed.`,
    );
  return {
    entry,
    asset,
    commit,
    ...(extractPath !== undefined ? { extractPath } : {}),
  };
}

export interface KbWriteAssetExtractInput extends KbEntryRef {
  assetPath: string;
  extractText: string;
  /** Deterministic timestamp for tests/imports; defaults to now. */
  updatedAt?: string;
}

export interface KbWriteAssetExtractResult {
  entry: KbResolvedEntry;
  asset: KbAssetRecord;
  extractPath: string;
  commit: KbCommitResult;
}

/**
 * Attach (or replace) the generated text extract for an EXISTING source asset,
 * without rewriting the asset bytes. Writes the gitignored `.kb/generated`
 * extract and points the asset's frontmatter `extractPath` at it. The asset
 * must already have a metadata entry (added via {@link addKnowledgeAsset}).
 */
export async function writeKnowledgeAssetExtract(
  store: KnowledgeBaseStore,
  input: KbWriteAssetExtractInput,
  meta: KbCommitMeta,
): Promise<KbWriteAssetExtractResult> {
  const entry = await resolveKnowledgeEntry(store, input);
  const assetPath = normalizeEntryLocalAssetPath(input.assetPath);
  const extractBytes = Buffer.byteLength(input.extractText, "utf8");
  if (extractBytes > KB_GENERATED_EXTRACT_MAX_WRITE_BYTES) {
    throw new KnowledgeBaseError(
      `Generated extract for "${assetPath}" is ${extractBytes} bytes; maximum allowed write is ${KB_GENERATED_EXTRACT_MAX_WRITE_BYTES} bytes.`,
    );
  }

  const entryDoc = parseKbEntryMarkdown(
    await store.readEntryFile(entry.path),
    entry.path,
  );
  const assetRefs = entryDoc.frontmatter.kb.assets ?? [];
  const assetRef = assetRefs.find(
    (candidate) => normalizeEntryLocalAssetPath(candidate.path) === assetPath,
  );
  if (!assetRef) {
    throw new KnowledgeBaseError(
      `Asset "${assetPath}" has no metadata entry on ${entry.id}; add it with kb_add_asset before attaching an extract.`,
    );
  }

  const extractName = generatedExtractName(entry.id, assetPath);
  await store.writeGeneratedFile(
    extractName,
    ensureTrailingNewline(input.extractText),
  );
  const extractPath = `${KB_GENERATED_DIR}/${extractName}`;
  assetRef.extractPath = extractPath;
  entryDoc.frontmatter.kb.assets = assetRefs;
  entryDoc.frontmatter.kb.updatedAt =
    input.updatedAt ?? new Date().toISOString();

  const commit = await commitValidatedKnowledgeChanges(
    store,
    [
      {
        op: "write",
        path: entry.path,
        content: formatKbEntryDocument(entryDoc),
      },
    ],
    { ...meta, entryIds: unique([...(meta.entryIds ?? []), entry.id]) },
  );

  const list = await listKnowledgeAssets(store, { entryId: entry.id });
  const asset = list.assets.find((candidate) => candidate.path === assetPath);
  if (!asset)
    throw new KnowledgeBaseError(
      `Asset "${assetPath}" extract was written but the asset could not be listed.`,
    );
  return { entry, asset, extractPath, commit };
}

export async function listKnowledgeAssets(
  store: KnowledgeBaseStore,
  ref: KbEntryRef,
): Promise<KbAssetList> {
  const entry = await resolveKnowledgeEntry(store, ref);
  const index = await getKnowledgeIndex(store);
  const indexed = index.entries.find((candidate) => candidate.id === entry.id);
  if (!indexed)
    throw new KnowledgeBaseError(
      `Knowledge entry not found in index after resolving: ${entry.id}`,
    );

  const records = new Map<string, KbAssetRecord>();
  for (const metadata of indexed.assets) {
    const path = normalizeEntryLocalAssetPath(metadata.path);
    records.set(
      path,
      await buildAssetRecord(store, entry, path, metadata, false),
    );
  }

  const prefix = entry.folder
    ? `${entry.folder}/${KB_ENTRY_ASSETS_DIR}/`
    : `${KB_ENTRY_ASSETS_DIR}/`;
  for (const node of await store.listTree()) {
    if (
      node.type !== "file" ||
      node.kind !== "asset" ||
      !node.path.startsWith(prefix)
    )
      continue;
    const localPath = node.path.slice(
      entry.folder ? entry.folder.length + 1 : 0,
    );
    if (!records.has(localPath))
      records.set(
        localPath,
        await buildAssetRecord(store, entry, localPath, undefined, true),
      );
  }

  return {
    entry,
    assets: [...records.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export async function readKnowledgeAsset(
  store: KnowledgeBaseStore,
  input: KbReadAssetInput,
): Promise<KbReadAssetResult> {
  const entry = await resolveKnowledgeEntry(store, input);
  const assetPath = normalizeEntryLocalAssetPath(input.assetPath);
  const assets = await listKnowledgeAssets(store, { entryId: entry.id });
  const asset = assets.assets.find((candidate) => candidate.path === assetPath);
  if (!asset?.exists)
    throw new KnowledgeBaseError(
      `Knowledge asset not found: "${assetPath}" on entry ${entry.id}.`,
    );
  const result = await store.readEntryBytesBounded(
    asset.sourcePath,
    input.maxBytes ?? KB_ASSET_MAX_READ_BYTES,
  );
  return { ...result, entry, asset };
}

export async function readKnowledgeAssetText(
  store: KnowledgeBaseStore,
  input: KbReadAssetInput,
): Promise<KbReadAssetTextResult> {
  const result = await readKnowledgeAsset(store, {
    ...input,
    maxBytes: input.maxBytes ?? KB_ASSET_TEXT_PREVIEW_CHARS * 4,
  });
  if (!isTextLikeAsset(result.asset)) {
    throw new KnowledgeBaseError(
      `Knowledge asset "${result.asset.path}" is not text-like; use readKnowledgeAsset for bounded binary/download bytes.`,
    );
  }
  let text = result.content.toString("utf8");
  let truncated = result.truncated;
  if (text.length > KB_ASSET_TEXT_PREVIEW_CHARS) {
    text = text.slice(0, KB_ASSET_TEXT_PREVIEW_CHARS);
    truncated = true;
  }
  return {
    entry: result.entry,
    asset: result.asset,
    text,
    sizeBytes: result.sizeBytes,
    truncated,
  };
}

export async function readKnowledgeGeneratedExtract(
  store: KnowledgeBaseStore,
  extractPath: string,
  maxBytes = KB_GENERATED_EXTRACT_MAX_READ_BYTES,
): Promise<KbReadGeneratedExtractResult | null> {
  const name = generatedNameFromPath(extractPath);
  const result = await store.readGeneratedFileBounded(name, maxBytes);
  if (!result) return null;
  return {
    path: `${KB_GENERATED_DIR}/${name}`,
    text: result.content,
    sizeBytes: result.sizeBytes,
    truncated: result.truncated,
  };
}

export function normalizeEntryLocalAssetPath(input: string): string {
  let path: string;
  try {
    path = normalizeKnowledgeRelativePath(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new KnowledgeBaseError(message);
  }
  if (
    !path.startsWith(`${KB_ENTRY_ASSETS_DIR}/`) ||
    path === `${KB_ENTRY_ASSETS_DIR}/`
  ) {
    throw new KnowledgeBaseError(
      `Asset paths must be entry-local paths under "${KB_ENTRY_ASSETS_DIR}/".`,
    );
  }
  if (path.endsWith("/"))
    throw new KnowledgeBaseError(
      "Asset paths must name a file, not a directory.",
    );
  return path;
}

export function generatedExtractPathForAsset(
  entryId: string,
  assetPath: string,
): string {
  return `${KB_GENERATED_DIR}/${generatedExtractName(entryId, normalizeEntryLocalAssetPath(assetPath))}`;
}

async function resolveKnowledgeEntry(
  store: KnowledgeBaseStore,
  ref: KbEntryRef,
): Promise<KbResolvedEntry> {
  if (!ref.entryId && !ref.entryPath)
    throw new KnowledgeBaseError(
      "A knowledge entryId or entryPath is required.",
    );
  const index = await getKnowledgeIndex(store);
  let entry: KbIndexEntry | undefined;
  if (ref.entryId)
    entry = index.entries.find((candidate) => candidate.id === ref.entryId);
  if (!entry && ref.entryPath) {
    const path = normalizeKnowledgeRelativePath(ref.entryPath);
    const indexPath = path.endsWith("/index.md") ? path : `${path}/index.md`;
    entry = index.entries.find(
      (candidate) => candidate.path === indexPath || candidate.folder === path,
    );
  }
  if (!entry) {
    const target = ref.entryId ? `id ${ref.entryId}` : `path ${ref.entryPath}`;
    throw new KnowledgeBaseError(`Knowledge entry not found for ${target}.`);
  }
  return {
    id: entry.id,
    path: entry.path,
    folder: entry.folder,
    title: entry.title,
  };
}

async function buildAssetRecord(
  store: KnowledgeBaseStore,
  entry: KbResolvedEntry,
  localPath: string,
  metadata: KbAssetRefV1 | undefined,
  discoveredFromFile: boolean,
): Promise<KbAssetRecord> {
  const sourcePath = joinEntryAssetPath(entry.folder, localPath);
  let sizeBytes: number | undefined;
  let exists = false;
  try {
    const stat = await store.statSourcePath(sourcePath);
    exists = stat.type === "file";
    if (exists) sizeBytes = stat.sizeBytes;
  } catch {
    exists = false;
  }
  const record: KbAssetRecord = {
    path: localPath,
    sourcePath,
    ...(metadata?.title !== undefined ? { title: metadata?.title } : {}),
    ...(metadata?.mimeType !== undefined
      ? { mimeType: metadata?.mimeType }
      : {}),
    kind: metadata?.kind ?? "source",
    exists,
    metadataDeclared: !discoveredFromFile,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
  if (metadata?.extractPath) {
    const extract = await readKnowledgeGeneratedExtract(
      store,
      metadata.extractPath,
      1,
    );
    record.extract = {
      path: metadata.extractPath,
      exists: extract !== null,
      ...(extract?.sizeBytes !== undefined
        ? { sizeBytes: extract.sizeBytes }
        : {}),
    };
  }
  return record;
}

function joinEntryAssetPath(entryFolder: string, assetPath: string): string {
  const sourcePath = entryFolder ? `${entryFolder}/${assetPath}` : assetPath;
  const normalized = normalizeKnowledgeRelativePath(sourcePath);
  const requiredPrefix = entryFolder
    ? `${entryFolder}/${KB_ENTRY_ASSETS_DIR}/`
    : `${KB_ENTRY_ASSETS_DIR}/`;
  if (!normalized.startsWith(requiredPrefix)) {
    throw new KnowledgeBaseError(
      `Asset path "${assetPath}" escapes entry folder "${entryFolder}".`,
    );
  }
  return normalized;
}

function upsertAssetRef(
  existing: KbAssetRefV1[],
  next: KbAssetRefV1,
): KbAssetRefV1[] {
  return [...existing.filter((asset) => asset.path !== next.path), next].sort(
    (a, b) => a.path.localeCompare(b.path),
  );
}

function generatedExtractName(entryId: string, assetPath: string): string {
  return normalizeKnowledgeRelativePath(`extracts/${entryId}/${assetPath}.txt`);
}

function generatedNameFromPath(extractPath: string): string {
  const path = normalizeKnowledgeRelativePath(extractPath);
  const prefix = `${KB_GENERATED_DIR}/extracts/`;
  if (!path.startsWith(prefix))
    throw new KnowledgeBaseError(
      "Generated extract paths must live under .kb/generated/extracts/.",
    );
  return path.slice(`${KB_GENERATED_DIR}/`.length);
}

function toWritableContent(content: string | Uint8Array): string | Uint8Array {
  return typeof content === "string" ? content : Buffer.from(content);
}

function isTextLikeAsset(asset: KbAssetRecord): boolean {
  const mime = asset.mimeType?.toLowerCase() ?? "";
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml"
  )
    return true;
  return /\.(md|txt|json|jsonl|ya?ml|csv|xml|html?)$/i.test(asset.path);
}

function nonEmpty(value: string, field: string): string {
  const text = value.trim();
  if (!text)
    throw new KnowledgeBaseError(`Asset ${field} must be a non-empty string.`);
  return text;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
