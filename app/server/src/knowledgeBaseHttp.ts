/**
 * HTTP read surface for first-class Knowledge Base app-shell views, dispatched
 * from `index.ts` under `/api/knowledge/*`. Agent mutations stay on the
 * `kb_*` tools; this module serves compact, bounded data for browser routing
 * and object browsing:
 *
 * - `GET /api/knowledge/tree` — the compact sidebar tree payload.
 * - `GET /api/knowledge/entry?id=<id>|path=<path>` — one readable entry document
 *   (body Markdown, frontmatter-derived metadata, assets, resolved `pa://`
 *   references) or an invalid-entry state that degrades gracefully.
 * - `GET /api/knowledge/inspect?id=<id>|path=<path>[&diffCommit=<rev>]` —
 *   compact right-inspector metadata, related objects, history, and bounded diff.
 * - `GET /api/knowledge/asset?id=<id>&path=assets/...` — raw entry-local asset
 *   bytes for inline images and downloads.
 * - `GET /api/knowledge/file?path=<repo-relative>` — raw bytes of any KB
 *   source file (entry asset or loose file) addressed by its full tree path,
 *   for the main-pane file viewer (images, PDFs, and text like JSON/YAML/CSV).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import {
  extractPaObjectLinkUris,
  formatPaObjectLink,
  parsePaObjectLink,
} from "@assistant/shared/objectLinks";
import type {
  KnowledgeEntryAsset,
  KnowledgeEntryDocument,
  KnowledgeDiffFile,
  KnowledgeDiffPreview,
  KnowledgeEntryInvalid,
  KnowledgeEntryResponse,
  KnowledgeHistoryRow,
  KnowledgeInspectResponse,
  KnowledgeTreeResponse,
} from "@assistant/shared/knowledgeBase";
import { errorText } from "./errors.ts";
import {
  KB_ASSET_MAX_WRITE_BYTES,
  listKnowledgeAssets,
  readKnowledgeAsset,
  type KbAssetRecord,
} from "./knowledgeBaseAssets.ts";
import {
  KB_COMMENTS_DIR,
  normalizeKnowledgeRelativePath,
} from "./knowledgeBaseContract.ts";
import { parseKbEntryMarkdown } from "./knowledgeBaseEntry.ts";
import {
  entryHeadingOutline,
  getKnowledgeIndex,
  type KbIndex,
  type KbIndexEntry,
  type KbIndexInvalidEntry,
} from "./knowledgeBaseIndex.ts";
import {
  KnowledgeBaseStore,
  type KbCommitFileChange,
  type KbHistoryEntry,
} from "./knowledgeBaseStore.ts";
import { resolvePaObjectLinks } from "./objectLinkResolver.ts";

type Headers = Record<string, string>;

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".bmp",
  ".ico",
]);
const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".xml": "text/xml; charset=utf-8",
  ".toml": "text/plain; charset=utf-8",
  ".ini": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
};

export async function handleKnowledgeBaseApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  corsJsonHeaders: (req: IncomingMessage) => Headers,
): Promise<void> {
  const headers = corsJsonHeaders(req);
  const respond = (status: number, payload: unknown) => {
    res.writeHead(status, headers);
    res.end(JSON.stringify(payload));
  };

  if (req.method !== "GET") {
    respond(405, { error: "Method not allowed" });
    return;
  }

  try {
    switch (url.pathname) {
      case "/api/knowledge/tree": {
        const index = await getKnowledgeIndex(new KnowledgeBaseStore());
        const payload: KnowledgeTreeResponse = {
          tree: index.tree,
          entriesCount: index.entries.length,
          invalidCount: index.invalid.length,
          head: index.head,
        };
        respond(200, payload);
        return;
      }
      case "/api/knowledge/entry": {
        const store = new KnowledgeBaseStore();
        const index = await getKnowledgeIndex(store);
        const idValue = url.searchParams.get("id")?.trim() || undefined;
        const pathValue = url.searchParams.get("path")?.trim() || undefined;
        const entry = await resolveKnowledgeEntryResponse(store, index, {
          ...(idValue !== undefined ? { id: idValue } : {}),
          ...(pathValue !== undefined ? { path: pathValue } : {}),
        });
        if (!entry) {
          respond(404, { error: "Knowledge entry not found." });
          return;
        }
        respond(200, entry);
        return;
      }
      case "/api/knowledge/inspect": {
        const store = new KnowledgeBaseStore();
        const index = await getKnowledgeIndex(store);
        const idValue = url.searchParams.get("id")?.trim() || undefined;
        const pathValue = url.searchParams.get("path")?.trim() || undefined;
        const diffCommitValue =
          url.searchParams.get("diffCommit")?.trim() || undefined;
        const entry = await resolveKnowledgeInspectorResponse(store, index, {
          ...(idValue !== undefined ? { id: idValue } : {}),
          ...(pathValue !== undefined ? { path: pathValue } : {}),
          ...(diffCommitValue !== undefined
            ? { diffCommit: diffCommitValue }
            : {}),
          diffMaxChars: Number(
            url.searchParams.get("diffMaxChars") || undefined,
          ),
        });
        if (!entry) {
          respond(404, { error: "Knowledge entry not found." });
          return;
        }
        respond(200, entry);
        return;
      }
      case "/api/knowledge/asset": {
        await serveAsset(res, url, headers);
        return;
      }
      case "/api/knowledge/file": {
        await serveFile(res, url, headers);
        return;
      }
      default:
        respond(404, { error: "Not found" });
    }
  } catch (err) {
    respond(500, { error: errorText(err) });
  }
}

/**
 * Resolve an `id`/`path` reference to a rendered entry document or an
 * invalid-entry state. Returns null when nothing matches (a 404 for the caller).
 */
export async function resolveKnowledgeEntryResponse(
  store: KnowledgeBaseStore,
  index: KbIndex,
  ref: { id?: string; path?: string },
): Promise<KnowledgeEntryResponse | null> {
  const id = ref.id?.trim();
  const pathParam = ref.path?.trim();

  let entry: KbIndexEntry | undefined;
  if (id) entry = index.entries.find((candidate) => candidate.id === id);
  let folder: string | undefined = entry?.folder;
  if (!entry && pathParam) {
    folder = entryFolderFromPath(pathParam);
    entry = index.entries.find((candidate) => candidate.folder === folder);
  }

  if (entry) {
    try {
      return await buildEntryDocument(store, entry);
    } catch (err) {
      // The entry indexed cleanly but its source changed to invalid between
      // index and read; surface it as an invalid state instead of a 500.
      return await buildInvalidEntry(
        store,
        entry.folder,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Fall back to a captured invalid entry so the viewer can still show the error.
  const invalidMatch = findInvalid(index.invalid, {
    ...(id !== undefined ? { id } : {}),
    ...(folder !== undefined ? { folder } : {}),
  });
  if (invalidMatch)
    return await buildInvalidEntry(
      store,
      invalidMatch.folder,
      invalidMatch.error,
    );
  return null;
}

export async function resolveKnowledgeInspectorResponse(
  store: KnowledgeBaseStore,
  index: KbIndex,
  ref: {
    id?: string;
    path?: string;
    diffCommit?: string;
    diffMaxChars?: number;
  },
): Promise<KnowledgeInspectResponse | null> {
  const id = ref.id?.trim();
  const pathParam = ref.path?.trim();

  let entry: KbIndexEntry | undefined;
  if (id) entry = index.entries.find((candidate) => candidate.id === id);
  let folder: string | undefined = entry?.folder;
  if (!entry && pathParam) {
    folder = entryFolderFromPath(pathParam);
    entry = index.entries.find((candidate) => candidate.folder === folder);
  }

  if (entry)
    return await buildEntryInspect(
      store,
      entry,
      ref.diffCommit,
      ref.diffMaxChars,
    );

  const invalidMatch = findInvalid(index.invalid, {
    ...(id !== undefined ? { id } : {}),
    ...(folder !== undefined ? { folder } : {}),
  });
  if (!invalidMatch) return null;
  const history = await entryHistory(store, invalidMatch.folder, undefined, 8);
  const latestDiff = await diffPreview(
    store,
    ref.diffCommit ?? history[0]?.fullCommit,
    invalidMatch.folder,
    ref.diffMaxChars ?? 4_000,
  );
  return {
    kind: "invalid",
    path: `${invalidMatch.folder}/index.md`,
    folder: invalidMatch.folder,
    slug: lastSegment(invalidMatch.folder),
    error: invalidMatch.error,
    history,
    latestDiff,
  };
}

function findInvalid(
  invalid: KbIndexInvalidEntry[],
  ref: { id?: string; folder?: string },
): KbIndexInvalidEntry | undefined {
  if (ref.folder)
    return invalid.find((candidate) => candidate.folder === ref.folder);
  // Invalid entries have no parseable id; only a path/folder can address them.
  return undefined;
}

function entryFolderFromPath(pathParam: string): string {
  const normalized = normalizeKnowledgeRelativePath(pathParam);
  return normalized.endsWith("/index.md")
    ? normalized.slice(0, -"/index.md".length)
    : normalized;
}

async function buildEntryDocument(
  store: KnowledgeBaseStore,
  entry: KbIndexEntry,
): Promise<KnowledgeEntryDocument> {
  const raw = await store.readEntryFile(entry.path);
  const doc = parseKbEntryMarkdown(raw, entry.path);
  const sourceRefs = doc.frontmatter.kb.source?.refs ?? [];
  const paObjectReferences = await resolveEntryObjectLinks(
    doc.body,
    entry.links,
    sourceRefs,
  );

  const assetList = await listKnowledgeAssets(store, { entryId: entry.id });

  return {
    kind: "entry",
    id: entry.id,
    path: entry.path,
    folder: entry.folder,
    slug: entry.slug,
    uri: formatPaObjectLink({ objectType: "knowledge", id: entry.id }),
    title: entry.title,
    type: entry.type,
    status: entry.status,
    summary: entry.summary,
    tags: entry.tags,
    aliases: entry.aliases,
    links: entry.links,
    sourceRefs,
    outline: entryHeadingOutline(doc.body),
    assets: assetList.assets.map(toEntryAsset),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    markdown: doc.body.trim(),
    paObjectReferences,
  };
}

async function buildEntryInspect(
  store: KnowledgeBaseStore,
  entry: KbIndexEntry,
  diffCommit?: string,
  diffMaxChars = 4_000,
): Promise<Extract<KnowledgeInspectResponse, { kind: "entry" }>> {
  const raw = await store.readEntryFile(entry.path);
  const doc = parseKbEntryMarkdown(raw, entry.path);
  const sourceRefs = doc.frontmatter.kb.source?.refs ?? [];
  const paObjectReferences = await resolveEntryObjectLinks(
    doc.body,
    entry.links,
    sourceRefs,
  );
  const assetList = await listKnowledgeAssets(store, { entryId: entry.id });
  const history = await entryHistory(store, entry.folder, entry.id, 8);
  const latestDiff = await diffPreview(
    store,
    diffCommit ?? history[0]?.fullCommit,
    entry.folder,
    diffMaxChars,
  );
  return {
    kind: "entry",
    id: entry.id,
    path: entry.path,
    folder: entry.folder,
    slug: entry.slug,
    uri: formatPaObjectLink({ objectType: "knowledge", id: entry.id }),
    title: entry.title,
    type: entry.type,
    status: entry.status,
    summary: entry.summary,
    tags: entry.tags,
    aliases: entry.aliases,
    links: entry.links,
    sourceRefs,
    assets: assetList.assets.map(toEntryAsset),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    frontmatter: {
      schema: 1,
      id: entry.id,
      type: entry.type,
      title: entry.title,
      status: entry.status,
      summary: entry.summary,
      tags: entry.tags,
      aliases: entry.aliases,
      links: entry.links,
      sourceRefs,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    },
    paObjectReferences,
    history,
    latestDiff,
  };
}

async function resolveEntryObjectLinks(
  body: string,
  links: string[],
  sourceRefs: string[],
) {
  const uris = [
    ...extractPaObjectLinkUris(body),
    ...links,
    ...sourceRefs.filter((ref) => parsePaObjectLink(ref)?.knownType === true),
  ];
  return await resolvePaObjectLinks([...new Set(uris)].slice(0, 50));
}

async function entryHistory(
  store: KnowledgeBaseStore,
  folder: string,
  entryId: string | undefined,
  limit: number,
): Promise<KnowledgeHistoryRow[]> {
  // Folder-scoped rows always changed the entry's document (its `index.md` or an
  // asset), so they are the entry's real content history.
  const pathRows = await store.history({ path: folder, limit });
  const rowsByCommit = new Map<string, KbHistoryEntry>();
  for (const row of pathRows) rowsByCommit.set(row.commit, row);

  if (entryId) {
    // The entry-id trailer scan also catches content commits made under a
    // previous folder path (moves). But the retired comment workflow's commits
    // (comment/reply/resolve/handoff/…) carry the same `KB-Entry` trailer while
    // touching ONLY `.kb/comments/` — they never change the document, so
    // including them here renders as empty diffs and buries the real edits.
    // The log stays in history; these rows stay out of an entry's timeline.
    const allRows = await store.history({ limit: Math.max(100, limit) });
    for (const row of allRows) {
      if (rowsByCommit.has(row.commit)) continue;
      if (!(row.trailers["KB-Entry"] ?? "").split(/,\s*/).includes(entryId))
        continue;
      if (isCommentLogOnlyCommit(row)) continue;
      rowsByCommit.set(row.commit, row);
    }
  }

  return historyRows(
    [...rowsByCommit.values()].sort((a, b) => b.date.localeCompare(a.date)),
  ).slice(0, limit);
}

/** True when a commit's only changed paths are under the retired comment log. */
function isCommentLogOnlyCommit(row: KbHistoryEntry): boolean {
  const paths = (row.trailers["KB-Paths"] ?? "")
    .split(/,\s*/)
    .map((path) => path.trim())
    .filter(Boolean);
  return (
    paths.length > 0 &&
    paths.every(
      (path) =>
        path === KB_COMMENTS_DIR || path.startsWith(`${KB_COMMENTS_DIR}/`),
    )
  );
}

/** Per-side text cap for structured file diffs (Pierre + rendered-Markdown). */
const DIFF_FILE_MAX_CHARS = 100_000;

async function diffPreview(
  store: KnowledgeBaseStore,
  commit: string | undefined,
  folder: string,
  maxChars: number,
): Promise<KnowledgeDiffPreview | null> {
  if (!commit) return null;
  const fullCommit = commit.trim();
  if (!fullCommit) return null;
  const patch = await store.showCommit(fullCommit, folder);
  const cap =
    Number.isFinite(maxChars) && maxChars > 0
      ? Math.min(Math.floor(maxChars), 50_000)
      : 4_000;
  return {
    commit: fullCommit,
    patch: patch.length > cap ? patch.slice(0, cap) : patch,
    truncated: patch.length > cap,
    totalChars: patch.length,
    files: await diffFiles(store, fullCommit, folder),
  };
}

/** Build structured per-file old/new text for rich diff rendering. */
async function diffFiles(
  store: KnowledgeBaseStore,
  commit: string,
  folder: string,
): Promise<KnowledgeDiffFile[]> {
  let changes: KbCommitFileChange[];
  try {
    changes = await store.commitChangedFiles(commit, folder);
  } catch {
    return [];
  }
  const out: KnowledgeDiffFile[] = [];
  for (const change of changes.slice(0, 25)) {
    const oldPath = change.oldPath ?? change.path;
    const oldRaw =
      change.status === "added"
        ? null
        : await readAtCommitOrNull(store, `${commit}~1`, oldPath);
    const newRaw =
      change.status === "deleted"
        ? null
        : await readAtCommitOrNull(store, commit, change.path);
    const binary = isBinaryText(oldRaw) || isBinaryText(newRaw);
    const oldText = binary ? null : clip(oldRaw);
    const newText = binary ? null : clip(newRaw);
    out.push({
      path: change.path,
      ...(change.oldPath ? { oldPath: change.oldPath } : {}),
      status: change.status,
      oldText: oldText?.text ?? null,
      newText: newText?.text ?? null,
      binary,
      truncated: Boolean(oldText?.truncated || newText?.truncated),
    });
  }
  return out;
}

async function readAtCommitOrNull(
  store: KnowledgeBaseStore,
  commit: string,
  path: string,
): Promise<string | null> {
  try {
    return await store.readFileAtCommit(commit, path);
  } catch {
    return null;
  }
}

function clip(
  text: string | null,
): { text: string; truncated: boolean } | null {
  if (text === null) return null;
  if (text.length <= DIFF_FILE_MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, DIFF_FILE_MAX_CHARS), truncated: true };
}

function isBinaryText(text: string | null): boolean {
  return text !== null && text.includes("\u0000");
}

function historyRows(rows: KbHistoryEntry[]): KnowledgeHistoryRow[] {
  return rows.map((row) => ({
    commit: row.shortCommit,
    fullCommit: row.commit,
    date: row.date,
    author: row.author,
    subject: row.subject,
    ...(row.trailers["KB-Entry"] != null
      ? { entryIds: row.trailers["KB-Entry"] }
      : {}),
    ...(row.trailers["KB-Paths"] != null
      ? { paths: row.trailers["KB-Paths"] }
      : {}),
  }));
}

async function buildInvalidEntry(
  store: KnowledgeBaseStore,
  folder: string,
  error: string,
): Promise<KnowledgeEntryInvalid> {
  let markdown: string | null = null;
  try {
    markdown = await store.readEntryFile(`${folder}/index.md`);
  } catch {
    markdown = null;
  }
  return {
    kind: "invalid",
    path: `${folder}/index.md`,
    folder,
    slug: lastSegment(folder),
    error,
    markdown,
  };
}

function toEntryAsset(asset: KbAssetRecord): KnowledgeEntryAsset {
  return {
    path: asset.path,
    ...(asset.title !== undefined ? { title: asset.title } : {}),
    ...(asset.mimeType !== undefined ? { mimeType: asset.mimeType } : {}),
    kind: asset.kind,
    exists: asset.exists,
    ...(asset.sizeBytes !== undefined ? { sizeBytes: asset.sizeBytes } : {}),
    isImage: isImageAsset(asset.path, asset.mimeType),
  };
}

function isImageAsset(path: string, mimeType?: string): boolean {
  if (mimeType?.toLowerCase().startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

async function serveAsset(
  res: ServerResponse,
  url: URL,
  headers: Headers,
): Promise<void> {
  const id = url.searchParams.get("id")?.trim();
  const path = url.searchParams.get("path")?.trim();
  const entryPath = url.searchParams.get("entryPath")?.trim();
  const jsonRespond = (status: number, payload: unknown) => {
    res.writeHead(status, headers);
    res.end(JSON.stringify(payload));
  };
  if (!path || (!id && !entryPath)) {
    jsonRespond(400, { error: "id (or entryPath) and path are required." });
    return;
  }
  try {
    // Serve the FULL asset: writes allow up to KB_ASSET_MAX_WRITE_BYTES, so the
    // default bounded read (10 MB) would silently truncate larger assets and hand
    // the browser a corrupt image/download under a 200. Read to the write cap and
    // refuse (rather than truncate) anything still larger.
    const result = await readKnowledgeAsset(new KnowledgeBaseStore(), {
      ...(id !== undefined ? { entryId: id } : {}),
      ...(entryPath !== undefined ? { entryPath } : {}),
      assetPath: path,
      maxBytes: KB_ASSET_MAX_WRITE_BYTES,
    });
    if (result.truncated) {
      jsonRespond(413, {
        error: `Asset "${path}" is too large to serve (${result.sizeBytes} bytes).`,
      });
      return;
    }
    const contentType =
      result.asset.mimeType ||
      ASSET_CONTENT_TYPES[extname(result.asset.path).toLowerCase()] ||
      "application/octet-stream";
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": String(result.content.byteLength),
      "cache-control": "no-store",
      "access-control-allow-origin":
        headers["access-control-allow-origin"] ?? "",
    });
    res.end(result.content);
  } catch (err) {
    jsonRespond(404, { error: errorText(err) });
  }
}

/**
 * Serve the raw bytes of any KB source file addressed by its full,
 * repo-relative tree path (an entry asset or a loose file). Unlike `/asset`,
 * it needs no entry identity: the store's `resolveSourcePath` enforces
 * containment and rejects reserved/generated/control paths, so only
 * source-of-truth files are reachable.
 */
async function serveFile(
  res: ServerResponse,
  url: URL,
  headers: Headers,
): Promise<void> {
  const path = url.searchParams.get("path")?.trim();
  const jsonRespond = (status: number, payload: unknown) => {
    res.writeHead(status, headers);
    res.end(JSON.stringify(payload));
  };
  if (!path) {
    jsonRespond(400, { error: "path is required." });
    return;
  }
  try {
    // Read to the write cap and refuse (rather than truncate) anything larger,
    // so the browser never gets a corrupt image/download under a 200.
    const result = await new KnowledgeBaseStore().readEntryBytesBounded(
      path,
      KB_ASSET_MAX_WRITE_BYTES,
    );
    if (result.truncated) {
      jsonRespond(413, {
        error: `File "${path}" is too large to serve (${result.sizeBytes} bytes).`,
      });
      return;
    }
    const contentType =
      ASSET_CONTENT_TYPES[extname(result.path).toLowerCase()] ||
      "application/octet-stream";
    res.writeHead(200, {
      "content-type": contentType,
      "content-length": String(result.content.byteLength),
      "cache-control": "no-store",
      "access-control-allow-origin":
        headers["access-control-allow-origin"] ?? "",
    });
    res.end(result.content);
  } catch (err) {
    jsonRespond(404, { error: errorText(err) });
  }
}

function lastSegment(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? path : path.slice(at + 1);
}
