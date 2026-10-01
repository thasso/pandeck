import { Buffer } from "node:buffer";
import { extname } from "node:path";
import {
  defineAgentTool,
  type ToolCallContext,
  type ToolResult,
} from "../../mcp/tool.ts";
import type { KnowledgeEntryCard } from "@assistant/shared";
import {
  addKnowledgeAsset,
  listKnowledgeAssets,
  readKnowledgeAssetText,
  readKnowledgeGeneratedExtract,
  type KbEntryRef,
} from "../../knowledgeBaseAssets.ts";
import { readSessionAttachmentBytes } from "../../sessionAttachments.ts";
import {
  knowledgeEntryFrontmatterHelp,
  knowledgeEntryIndexPath,
  normalizeKnowledgeRelativePath,
} from "../../knowledgeBaseContract.ts";
import {
  commitValidatedKnowledgeChanges,
  parseKbEntryMarkdown,
} from "../../knowledgeBaseEntry.ts";
import {
  getKnowledgeIndex,
  searchKnowledge,
  type KbDetailLevel,
  type KbTreeItem,
} from "../../knowledgeBaseIndex.ts";
import {
  KnowledgeBaseError,
  KnowledgeBaseStore,
  type KbCommitMeta,
  type KbFileChange,
  type KbHistoryEntry,
  type KbTreeNode,
} from "../../knowledgeBaseStore.ts";

const DEFAULT_TREE_MAX_ITEMS = 200;
const DEFAULT_TREE_MAX_DEPTH = 4;
const DEFAULT_ENTRY_CONTENT_CHARS = 20_000;
const DEFAULT_DIFF_CHARS = 12_000;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_TOOL_LIMIT = 100;

type TreeDetail = "compact" | "standard";
type EntryDetail = "compact" | "standard" | "full";
type DiffDetail = "compact" | "full";

let storeFactory = () => new KnowledgeBaseStore();

/** Test-only seam so tool tests can run against an isolated temp KB repo. */
export function setKnowledgeBaseToolStoreFactoryForTests(
  factory: (() => KnowledgeBaseStore) | null,
): void {
  storeFactory = factory ?? (() => new KnowledgeBaseStore());
}

function store(): KnowledgeBaseStore {
  return storeFactory();
}

function compactJsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}

function clampLimit(
  value: number | undefined,
  fallback: number,
  cap = MAX_TOOL_LIMIT,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1)
    throw new KnowledgeBaseError("limit/maxResults must be a positive number.");
  return Math.min(Math.floor(value), cap);
}

function compactText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean; totalChars: number } {
  if (!Number.isFinite(maxChars) || maxChars < 1)
    throw new KnowledgeBaseError("maxChars must be a positive number.");
  return {
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
    totalChars: text.length,
  };
}

function normalizeDetail<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (
    typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
  )
    return value as T;
  throw new KnowledgeBaseError(`detail must be one of: ${allowed.join(", ")}.`);
}

function entryIndexPath(input: string): string {
  const path = normalizeKnowledgeRelativePath(input);
  if (!path) throw new KnowledgeBaseError("Entry path is required.");
  return path.endsWith("/index.md") ? path : knowledgeEntryIndexPath(path);
}

function entryFolderPath(input: string): string {
  const path = normalizeKnowledgeRelativePath(input);
  if (!path) throw new KnowledgeBaseError("Entry path is required.");
  return path.endsWith("/index.md") ? path.slice(0, -"/index.md".length) : path;
}

async function resolveEntry(
  store: KnowledgeBaseStore,
  ref: KbEntryRef,
): Promise<{ id: string; path: string; folder: string; title: string }> {
  if (!ref.entryId && !ref.entryPath)
    throw new KnowledgeBaseError("entryId or entryPath is required.");
  const index = await getKnowledgeIndex(store);
  let entry = ref.entryId
    ? index.entries.find((candidate) => candidate.id === ref.entryId)
    : undefined;
  if (!entry && ref.entryPath) {
    const folder = entryFolderPath(ref.entryPath);
    const path = entryIndexPath(ref.entryPath);
    entry = index.entries.find(
      (candidate) => candidate.folder === folder || candidate.path === path,
    );
  }
  if (!entry)
    throw new KnowledgeBaseError(
      `Knowledge entry not found: ${ref.entryId ?? ref.entryPath}`,
    );
  return {
    id: entry.id,
    path: entry.path,
    folder: entry.folder,
    title: entry.title,
  };
}

function actorFromContext(ctx: ToolCallContext): KbCommitMeta["actor"] {
  return {
    kind: "agent",
    id: `${ctx.session.harness}:${ctx.session.agentType}:${ctx.session.sessionId}`,
    name: ctx.session.title?.trim() || `${ctx.session.agentType} agent`,
  };
}

function commitMeta(
  ctx: ToolCallContext,
  params: {
    reason: string;
    taskId?: string;
    entryIds?: string[];
  },
): KbCommitMeta {
  const reason = params.reason?.trim();
  if (!reason)
    throw new KnowledgeBaseError("reason is required for KB mutations.");
  const taskIdValue = params.taskId?.trim() || undefined;
  const entryIdsValue = params.entryIds?.filter(Boolean);
  return {
    actor: actorFromContext(ctx),
    reason,
    sessionId: ctx.session.sessionId,
    ...(taskIdValue !== undefined ? { taskId: taskIdValue } : {}),
    ...(entryIdsValue !== undefined ? { entryIds: entryIdsValue } : {}),
  };
}

interface FlattenedTreeItem {
  path: string;
  name: string;
  type: KbTreeItem["type"];
  depth: number;
  entryId?: string;
  title?: string;
  status?: string;
  error?: string;
}

function projectTree(
  items: KbTreeItem[],
  detail: TreeDetail,
  maxDepth: number,
  maxItems: number,
): { items: FlattenedTreeItem[]; truncated: boolean } {
  const out: FlattenedTreeItem[] = [];
  let truncated = false;
  const visit = (item: KbTreeItem, depth: number): void => {
    if (out.length >= maxItems) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    const row: FlattenedTreeItem = {
      path: item.path,
      name: item.name,
      type: item.type,
      depth,
    };
    if (item.entryId) row.entryId = item.entryId;
    if (item.title) row.title = item.title;
    if (detail === "standard") {
      if (item.status) row.status = item.status;
      if (item.error) row.error = item.error;
    }
    out.push(row);
    for (const child of item.children) visit(child, depth + 1);
  };
  for (const item of items) visit(item, 0);
  return { items: out, truncated };
}

function compactEntry(
  entry: Awaited<ReturnType<typeof getKnowledgeIndex>>["entries"][number],
) {
  return {
    id: entry.id,
    path: entry.path,
    title: entry.title,
    type: entry.type,
    status: entry.status,
    summary: entry.summary,
    tags: entry.tags,
    updatedAt: entry.updatedAt,
  };
}

function historyRows(rows: KbHistoryEntry[]) {
  return rows.map((row) => ({
    commit: row.shortCommit,
    fullCommit: row.commit,
    date: row.date,
    author: row.author,
    subject: row.subject,
    entryIds: row.trailers["KB-Entry"] ?? undefined,
    paths: row.trailers["KB-Paths"] ?? undefined,
  }));
}

function applyExactReplacements(
  content: string,
  edits: { oldText: string; newText: string }[],
  path: string,
): { content: string; replacements: number } {
  const regions: {
    start: number;
    end: number;
    oldText: string;
    newText: string;
  }[] = [];
  for (const edit of edits) {
    if (!edit.oldText)
      throw new KnowledgeBaseError("edits[].oldText must be non-empty.");
    const first = content.indexOf(edit.oldText);
    if (first < 0)
      throw new KnowledgeBaseError(
        `oldText not found in ${path}: ${JSON.stringify(edit.oldText.slice(0, 80))}`,
      );
    const second = content.indexOf(edit.oldText, first + edit.oldText.length);
    if (second >= 0)
      throw new KnowledgeBaseError(
        `oldText is not unique in ${path}: ${JSON.stringify(edit.oldText.slice(0, 80))}`,
      );
    regions.push({
      start: first,
      end: first + edit.oldText.length,
      oldText: edit.oldText,
      newText: edit.newText,
    });
  }
  regions.sort((a, b) => a.start - b.start);
  for (let i = 1; i < regions.length; i++) {
    if (regions[i]!.start < regions[i - 1]!.end)
      throw new KnowledgeBaseError("edits must not overlap.");
  }
  let next = "";
  let cursor = 0;
  for (const region of regions) {
    next += content.slice(cursor, region.start) + region.newText;
    cursor = region.end;
  }
  next += content.slice(cursor);
  return { content: next, replacements: regions.length };
}

const detailProperty = {
  type: "string",
  enum: ["compact", "standard", "full"],
  description:
    "Output detail. compact is default; full may include larger content for targeted entries.",
} as const;

export const kbTreeTool = defineAgentTool<{
  detail?: TreeDetail;
  maxDepth?: number;
  maxItems?: number;
}>({
  name: "kb_tree",
  label: "KB: Tree",
  description:
    "List the first-class Knowledge Base tree in a compact, bounded shape. Read-only.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      detail: {
        type: "string",
        enum: ["compact", "standard"],
        description:
          "compact returns path/type/title; standard also includes status/errors.",
      },
      maxDepth: {
        type: "number",
        description: `Maximum tree depth to return. Defaults to ${DEFAULT_TREE_MAX_DEPTH}.`,
      },
      maxItems: {
        type: "number",
        description: `Maximum rows to return. Defaults to ${DEFAULT_TREE_MAX_ITEMS}.`,
      },
    },
  },
  async execute(params) {
    const detail = normalizeDetail(
      params.detail,
      ["compact", "standard"] as const,
      "compact",
    );
    const maxDepth = clampLimit(params.maxDepth, DEFAULT_TREE_MAX_DEPTH, 50);
    const maxItems = clampLimit(params.maxItems, DEFAULT_TREE_MAX_ITEMS, 500);
    const index = await getKnowledgeIndex(store());
    const tree = projectTree(index.tree, detail, maxDepth, maxItems);
    return compactJsonResult({
      detail,
      maxDepth,
      maxItems,
      ...tree,
      counts: { entries: index.entries.length, invalid: index.invalid.length },
    });
  },
});

export const kbSearchTool = defineAgentTool<{
  query: string;
  detail?: KbDetailLevel;
  maxResults?: number;
}>({
  name: "kb_search",
  label: "KB: Search",
  searchHint:
    "knowledge base kb durable knowledge notes briefs decisions reference",
  description:
    "Search first-class KB entries by title, aliases, tags, headings, body snippets, and asset metadata. Read-only. Use before answering durable questions or deciding whether to write/update an entry. To read the full source of a found entry, use kb_get_entry with detail=full.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", description: "Search text." },
      detail: detailProperty,
      maxResults: {
        type: "number",
        description: "Maximum hits. Defaults to 20; capped at 100.",
      },
    },
  },
  async execute(params) {
    if (!params.query?.trim())
      throw new KnowledgeBaseError("query is required.");
    const detail = normalizeDetail(
      params.detail,
      ["compact", "standard", "full"] as const,
      "compact",
    );
    const results = await searchKnowledge(store(), params.query, {
      detail,
      limit: clampLimit(params.maxResults, 20),
    });
    return compactJsonResult({ query: params.query, detail, results });
  },
});

export const kbGetEntryTool = defineAgentTool<{
  entryId?: string;
  entryPath?: string;
  detail?: EntryDetail;
  maxChars?: number;
}>({
  name: "kb_get_entry",
  label: "KB: Get Entry",
  searchHint: "knowledge base kb entry note brief decision reference",
  description:
    "Read one first-class KB entry by stable id or path. Compact by default; full source content requires detail=full. Use entryId to reference an existing entry reliably (never invent an id).",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      entryId: { type: "string", description: "Stable kb.id to read." },
      entryPath: {
        type: "string",
        description: "Entry folder or index.md path.",
      },
      detail: detailProperty,
      maxChars: {
        type: "number",
        description: `Maximum source characters when detail=full. Defaults to ${DEFAULT_ENTRY_CONTENT_CHARS}.`,
      },
    },
  },
  async execute(params) {
    const s = store();
    const ref = await resolveEntry(s, params);
    const index = await getKnowledgeIndex(s);
    const entry = index.entries.find((candidate) => candidate.id === ref.id);
    if (!entry)
      throw new KnowledgeBaseError(`Knowledge entry not found: ${ref.id}`);
    const detail = normalizeDetail(
      params.detail,
      ["compact", "standard", "full"] as const,
      "compact",
    );
    const payload: Record<string, unknown> = {
      detail,
      entry: compactEntry(entry),
    };
    if (detail !== "compact") {
      payload.entry = {
        ...compactEntry(entry),
        aliases: entry.aliases,
        links: entry.links,
        headings: entry.headings,
        assets: entry.assets,
      };
    }
    if (detail === "full") {
      const full = compactText(
        await s.readEntryFile(ref.path),
        Math.floor(params.maxChars ?? DEFAULT_ENTRY_CONTENT_CHARS),
      );
      payload.content = full.text;
      payload.truncated = full.truncated;
      payload.totalChars = full.totalChars;
    }
    return compactJsonResult(payload);
  },
});

const MAX_CARD_NOTE_CHARS = 200;

/**
 * `kb_show_entry` — put a Knowledge entry in front of the user as a card they
 * can open in the side panel, without pasting the entry into the conversation.
 *
 * The entry is resolved against the KB index here, so the card can only ever
 * name an entry that exists, and its id, title and path are re-spelled from
 * that index rather than from the caller. The chat renders the structured
 * payload (`app/web/src/components/KnowledgeEntryToolCard.tsx`); nothing about
 * the entry's content travels with it.
 */
export const kbShowEntryTool = defineAgentTool<{
  entryId?: string;
  entryPath?: string;
  note?: string;
}>({
  name: "kb_show_entry",
  label: "KB: Show Entry",
  searchHint: "knowledge base kb entry open side panel show card read",
  description:
    "Put a card for one KB entry in the chat, with an action that opens the entry in the app's Knowledge side panel (or the main Knowledge view) for the user to read and comment on. Use it when you have written or changed an entry the user should look at; it shows the entry, it does not send its content to you.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      entryId: { type: "string", description: "Stable kb.id to show." },
      entryPath: {
        type: "string",
        description: "Entry folder or index.md path, when you have no id.",
      },
      note: {
        type: "string",
        description: `One short line on why you are showing this entry, in plain text. Up to ${MAX_CARD_NOTE_CHARS} characters.`,
      },
    },
  },
  async execute(params) {
    const s = store();
    const ref = await resolveEntry(s, params);
    const index = await getKnowledgeIndex(s);
    const entry = index.entries.find((candidate) => candidate.id === ref.id);
    if (!entry)
      throw new KnowledgeBaseError(`Knowledge entry not found: ${ref.id}`);
    const note = params.note
      ?.replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_CARD_NOTE_CHARS);
    const card: KnowledgeEntryCard = {
      entryId: entry.id,
      title: entry.title,
      path: entry.folder,
      ...(entry.summary ? { summary: entry.summary } : {}),
      ...(note ? { note } : {}),
    };
    return compactJsonResult({
      renderKind: "knowledgeEntry" as const,
      version: 1,
      card,
    });
  },
});

export const kbWriteEntryTool = defineAgentTool<{
  path: string;
  content: string;
  reason: string;
  taskId?: string;
}>({
  name: "kb_write_entry",
  label: "KB: Write Entry",
  description:
    "Create or replace one KB entry index.md for durable long-form knowledge (notes, briefs, plans, decisions, project context) after validating frontmatter/schema/links. Mutates the KB repo and creates a Git commit. Scope: keep general, project, and task knowledge in separate entries; set accurate tags and kb.source.kind to avoid cross-contamination. Never invent entry ids — discover existing ones via kb_search. Links: reference other entries/tasks/projects/sessions via pa:// links; titles resolve at render time. Never store secrets, credentials, or raw sensitive message bodies — record provenance in kb.source and mark uncertain facts as uncertain in the body instead of asserting them. A short atomic preference/fact/constraint from an explicit 'remember this' belongs in Memory, not the KB. Ask first if the target entry is ambiguous, the new fact conflicts with an existing entry, or the change would rewrite broad content. Do not silently guess or overwrite.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content", "reason"],
    properties: {
      path: {
        type: "string",
        description: "Entry folder or index.md path to write.",
      },
      content: {
        type: "string",
        description: `Complete entry Markdown with KB v1 YAML frontmatter.\n\n${knowledgeEntryFrontmatterHelp()}`,
      },
      reason: { type: "string", description: "Concise commit reason." },
      taskId: {
        type: "string",
        description: "Optional related Task id for commit metadata.",
      },
    },
  },
  async execute(params, ctx) {
    const s = store();
    const path = entryIndexPath(params.path);
    const entryId = parseKbEntryMarkdown(params.content, path).frontmatter.kb
      .id;
    const commit = await commitValidatedKnowledgeChanges(
      s,
      [{ op: "write", path, content: params.content }],
      commitMeta(ctx, {
        reason: params.reason,
        ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
        entryIds: [entryId],
      }),
    );
    const index = await getKnowledgeIndex(s);
    const entry = index.entries.find((candidate) => candidate.path === path);
    return compactJsonResult({
      action: "write_entry",
      path,
      entry: entry ? compactEntry(entry) : null,
      commit,
    });
  },
});

export const kbEditEntryTool = defineAgentTool<{
  entryId?: string;
  entryPath?: string;
  edits: { oldText: string; newText: string }[];
  reason: string;
  taskId?: string;
}>({
  name: "kb_edit_entry",
  label: "KB: Edit Entry",
  description:
    "Edit one existing KB entry with exact text replacements, then validate and commit it. Use for targeted changes after reading the entry. Every mutation needs a concise reason and is committed to Git. Never store secrets, credentials, or raw sensitive message bodies. Frontmatter validation: use kb.schema=1 (not v1), kb.type is one of note/brief/workflow/plan/reference/project/daily-summary/decision, kb.status is draft/active/archived, kb.source allows kind/refs only. If validation fails, the error names the exact field/path/format problem — fix and retry.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["edits", "reason"],
    properties: {
      entryId: { type: "string", description: "Stable kb.id to edit." },
      entryPath: {
        type: "string",
        description: "Entry folder or index.md path to edit.",
      },
      edits: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["oldText", "newText"],
          properties: {
            oldText: {
              type: "string",
              description: "Exact unique text to replace.",
            },
            newText: { type: "string", description: "Replacement text." },
          },
        },
      },
      reason: { type: "string", description: "Concise commit reason." },
      taskId: {
        type: "string",
        description: "Optional related Task id for commit metadata.",
      },
    },
  },
  async execute(params, ctx) {
    const s = store();
    const entry = await resolveEntry(s, params);
    let content = await s.readEntryFile(entry.path);
    const applied = applyExactReplacements(content, params.edits, entry.path);
    const commit = await commitValidatedKnowledgeChanges(
      s,
      [{ op: "write", path: entry.path, content: applied.content }],
      commitMeta(ctx, {
        reason: params.reason,
        ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
        entryIds: [entry.id],
      }),
    );
    content = await s.readEntryFile(entry.path);
    const updated = (await getKnowledgeIndex(s)).entries.find(
      (candidate) => candidate.id === entry.id,
    );
    return compactJsonResult({
      action: "edit_entry",
      entry: updated ? compactEntry(updated) : entry,
      replacements: applied.replacements,
      bytes: Buffer.byteLength(content, "utf8"),
      commit,
    });
  },
});

export const kbAddAssetTool = defineAgentTool<{
  entryId?: string;
  entryPath?: string;
  assetPath: string;
  contentBase64?: string;
  contentText?: string;
  sourceAttachmentId?: string;
  title?: string;
  mimeType?: string;
  extractText?: string;
  reason: string;
  taskId?: string;
}>({
  name: "kb_add_asset",
  label: "KB: Add Asset",
  description:
    "Add or replace an entry-local KB asset under assets/ without dumping binary content into context. Provide inline content, or copy a session attachment by id (sourceAttachmentId) so raw uploaded/Slack files transfer server-side. Inspect assets with kb_list_assets and bounded kb_read_extract instead of dumping whole files. Mutates the KB repo and creates a Git commit. Never store secrets, credentials, or raw sensitive message bodies as durable knowledge.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["assetPath", "reason"],
    properties: {
      entryId: { type: "string", description: "Stable kb.id." },
      entryPath: {
        type: "string",
        description: "Entry folder or index.md path.",
      },
      assetPath: {
        type: "string",
        description: "Entry-local path under assets/, e.g. assets/source.pdf.",
      },
      contentBase64: {
        type: "string",
        description: "Base64 asset bytes. Use for binary assets.",
      },
      contentText: {
        type: "string",
        description:
          "UTF-8 text asset content. Use instead of contentBase64 for text assets.",
      },
      sourceAttachmentId: {
        type: "string",
        description:
          "Copy the raw bytes of a session attachment (from list_attachments or slack_file_read) into the asset. Use instead of contentBase64/contentText; the bytes never pass through your context.",
      },
      title: { type: "string" },
      mimeType: { type: "string" },
      extractText: {
        type: "string",
        description: "Optional generated text/OCR extract.",
      },
      reason: { type: "string", description: "Concise commit reason." },
      taskId: {
        type: "string",
        description: "Optional related Task id for commit metadata.",
      },
    },
  },
  async execute(params, ctx) {
    const sources = [
      params.contentBase64,
      params.contentText,
      params.sourceAttachmentId,
    ].filter((value) => value !== undefined);
    if (sources.length !== 1) {
      throw new KnowledgeBaseError(
        "Provide exactly one of contentBase64, contentText, or sourceAttachmentId.",
      );
    }
    let content: Buffer | string;
    let mimeType = params.mimeType;
    if (params.sourceAttachmentId !== undefined) {
      const attachment = readSessionAttachmentBytes(
        ctx.session.sessionId,
        params.sourceAttachmentId,
      );
      if (!attachment)
        throw new KnowledgeBaseError(
          `No session attachment found for id "${params.sourceAttachmentId}". Use list_attachments to see available attachments.`,
        );
      content = attachment.bytes;
      mimeType ??= attachment.record.mimeType;
    } else {
      content =
        params.contentBase64 !== undefined
          ? Buffer.from(params.contentBase64, "base64")
          : params.contentText!;
    }
    const s = store();
    const result = await addKnowledgeAsset(
      s,
      {
        ...(params.entryId !== undefined ? { entryId: params.entryId } : {}),
        ...(params.entryPath !== undefined
          ? { entryPath: params.entryPath }
          : {}),
        assetPath: params.assetPath,
        content,
        ...(params.title !== undefined ? { title: params.title } : {}),
        ...(mimeType !== undefined ? { mimeType } : {}),
        ...(params.extractText !== undefined
          ? { extractText: params.extractText }
          : {}),
      },
      commitMeta(ctx, {
        reason: params.reason,
        ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
      }),
    );
    return compactJsonResult({
      action: "add_asset",
      entry: result.entry,
      asset: result.asset,
      extractPath: result.extractPath,
      commit: result.commit,
    });
  },
});

export const kbMoveEntryTool = defineAgentTool<{
  entryId?: string;
  entryPath?: string;
  toPath: string;
  reason: string;
  taskId?: string;
}>({
  name: "kb_move_entry",
  label: "KB: Move Entry",
  description:
    "Move one KB entry folder (including assets) to a new folder path while preserving its stable kb.id. Mutates the KB repo and creates a Git commit.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["toPath", "reason"],
    properties: {
      entryId: { type: "string", description: "Stable kb.id to move." },
      entryPath: {
        type: "string",
        description: "Current entry folder or index.md path.",
      },
      toPath: {
        type: "string",
        description: "Destination entry folder or index.md path.",
      },
      reason: { type: "string", description: "Concise commit reason." },
      taskId: {
        type: "string",
        description: "Optional related Task id for commit metadata.",
      },
    },
  },
  async execute(params, ctx) {
    const s = store();
    const entry = await resolveEntry(s, params);
    const fromFolder = entry.folder;
    const toFolder = entryFolderPath(params.toPath);
    if (fromFolder === toFolder)
      throw new KnowledgeBaseError(
        "Destination is the same as the current entry folder.",
      );
    if (toFolder.startsWith(`${fromFolder}/`))
      throw new KnowledgeBaseError("Cannot move an entry inside itself.");

    const tree = await s.listTree();
    if (
      tree.some(
        (node) =>
          node.path === toFolder || node.path.startsWith(`${toFolder}/`),
      )
    ) {
      throw new KnowledgeBaseError(
        `Destination already exists or is not empty: ${toFolder}`,
      );
    }
    const entryNodes = tree.filter(
      (node) =>
        node.type === "file" &&
        (node.path === `${fromFolder}/index.md` ||
          node.path.startsWith(`${fromFolder}/`)),
    );
    if (entryNodes.length === 0)
      throw new KnowledgeBaseError(
        `Entry has no source files to move: ${fromFolder}`,
      );
    const writes: KbFileChange[] = [];
    const deletes: KbFileChange[] = [];
    for (const node of entryNodes) {
      const target = `${toFolder}/${node.path.slice(fromFolder.length + 1)}`;
      writes.push({
        op: "write",
        path: target,
        content: await readNodeContent(s, node),
      });
      deletes.push({ op: "delete", path: node.path });
    }
    const commit = await commitValidatedKnowledgeChanges(
      s,
      [...writes, ...deletes],
      commitMeta(ctx, {
        reason: params.reason,
        ...(params.taskId !== undefined ? { taskId: params.taskId } : {}),
        entryIds: [entry.id],
      }),
    );
    const moved = (await getKnowledgeIndex(s)).entries.find(
      (candidate) => candidate.id === entry.id,
    );
    return compactJsonResult({
      action: "move_entry",
      fromPath: fromFolder,
      toPath: toFolder,
      entry: moved ? compactEntry(moved) : null,
      commit,
    });
  },
});

async function readNodeContent(
  store: KnowledgeBaseStore,
  node: KbTreeNode,
): Promise<string | Uint8Array> {
  if (node.kind === "asset") return await store.readEntryBytes(node.path);
  const ext = extname(node.path).toLowerCase();
  if (
    [".md", ".txt", ".json", ".jsonl", ".yaml", ".yml"].includes(ext) ||
    node.kind === "entry-index" ||
    node.kind === "comment"
  ) {
    return await store.readEntryFile(node.path);
  }
  return await store.readEntryBytes(node.path);
}

export const kbHistoryTool = defineAgentTool<{
  entryId?: string;
  entryPath?: string;
  path?: string;
  limit?: number;
}>({
  name: "kb_history",
  label: "KB: History",
  description:
    "List compact Git history for the whole KB, one entry, or one source path. Read-only.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      entryId: {
        type: "string",
        description: "Optional stable kb.id to scope history.",
      },
      entryPath: {
        type: "string",
        description: "Optional entry folder or index.md path to scope history.",
      },
      path: {
        type: "string",
        description: "Optional source path to scope history.",
      },
      limit: {
        type: "number",
        description: `Maximum commits. Defaults to ${DEFAULT_HISTORY_LIMIT}; capped at 100.`,
      },
    },
  },
  async execute(params) {
    const s = store();
    let path = params.path;
    let entryId = params.entryId;
    if (!path && !entryId && params.entryPath)
      path = (await resolveEntry(s, params)).folder;
    if (!entryId && params.entryPath)
      entryId = (await resolveEntry(s, params)).id;
    const limit = clampLimit(params.limit, DEFAULT_HISTORY_LIMIT);
    const rawHistory = entryId
      ? await s.history({ limit: Math.max(limit, 100) })
      : await s.history({ ...(path !== undefined ? { path } : {}), limit });
    const history = entryId
      ? rawHistory
          .filter((row) =>
            (row.trailers["KB-Entry"] ?? "").split(/,\s*/).includes(entryId),
          )
          .slice(0, limit)
      : rawHistory;
    return compactJsonResult({
      entryId: entryId ?? null,
      path: path ?? null,
      history: historyRows(history),
    });
  },
});

export const kbDiffTool = defineAgentTool<{
  from: string;
  to?: string;
  entryId?: string;
  entryPath?: string;
  path?: string;
  detail?: DiffDetail;
  maxChars?: number;
}>({
  name: "kb_diff",
  label: "KB: Diff",
  description:
    "Return a bounded KB Git diff between revisions, optionally scoped to one entry/path. Read-only.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["from"],
    properties: {
      from: { type: "string", description: "Base commit/revision." },
      to: {
        type: "string",
        description:
          "Optional target commit/revision. Defaults to working tree.",
      },
      entryId: {
        type: "string",
        description: "Optional stable kb.id to scope diff.",
      },
      entryPath: {
        type: "string",
        description: "Optional entry folder or index.md path to scope diff.",
      },
      path: {
        type: "string",
        description: "Optional source path to scope diff.",
      },
      detail: {
        type: "string",
        enum: ["compact", "full"],
        description:
          "compact returns a bounded patch preview; full raises the default cap but still respects maxChars.",
      },
      maxChars: {
        type: "number",
        description: `Maximum patch characters. Defaults to ${DEFAULT_DIFF_CHARS}.`,
      },
    },
  },
  async execute(params) {
    const s = store();
    let path = params.path;
    if (!path && (params.entryId || params.entryPath))
      path = (await resolveEntry(s, params)).folder;
    const detail = normalizeDetail(
      params.detail,
      ["compact", "full"] as const,
      "compact",
    );
    const defaultCap =
      detail === "full" ? DEFAULT_DIFF_CHARS * 4 : DEFAULT_DIFF_CHARS;
    const patch = await s.diff({
      from: params.from,
      ...(params.to !== undefined ? { to: params.to } : {}),
      ...(path !== undefined ? { path } : {}),
    });
    const bounded = compactText(
      patch,
      Math.floor(params.maxChars ?? defaultCap),
    );
    return compactJsonResult({
      from: params.from,
      to: params.to ?? null,
      path: path ?? null,
      detail,
      patch: bounded.text,
      truncated: bounded.truncated,
      totalChars: bounded.totalChars,
    });
  },
});

export const kbListAssetsTool = defineAgentTool<{
  entryId?: string;
  entryPath?: string;
}>({
  name: "kb_list_assets",
  label: "KB: List Assets",
  description:
    "List compact asset metadata for one KB entry without returning file contents. Read-only.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      entryId: { type: "string", description: "Stable kb.id." },
      entryPath: {
        type: "string",
        description: "Entry folder or index.md path.",
      },
    },
  },
  async execute(params) {
    return compactJsonResult(await listKnowledgeAssets(store(), params));
  },
});

export const kbReadAssetTool = defineAgentTool<{
  entryId?: string;
  entryPath?: string;
  assetPath: string;
  maxChars?: number;
}>({
  name: "kb_read_asset",
  label: "KB: Read Asset",
  description:
    "Read bounded UTF-8 text from one committed entry-local KB asset (JSON/CSV/MD/…) under the entry's assets/ folder — kb_read_extract reads only GENERATED extracts. Read-only; binary assets are refused with a pointer to kb_list_assets.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["assetPath"],
    properties: {
      entryId: {
        type: "string",
        description: "Stable kb.id owning the asset.",
      },
      entryPath: {
        type: "string",
        description: "Entry folder or index.md path.",
      },
      assetPath: {
        type: "string",
        description: "Entry-local asset path, e.g. assets/sources/jira.json.",
      },
      maxChars: { type: "number", description: "Maximum characters returned." },
    },
  },
  async execute(params) {
    const result = await readKnowledgeAssetText(store(), {
      ...(params.entryId !== undefined ? { entryId: params.entryId } : {}),
      ...(params.entryPath !== undefined
        ? { entryPath: params.entryPath }
        : {}),
      assetPath: params.assetPath,
    });
    const maxChars = Math.max(
      200,
      Math.min(params.maxChars ?? 20_000, 100_000),
    );
    const truncated = result.truncated || result.text.length > maxChars;
    return compactJsonResult({
      entry: { id: result.entry.id, path: result.entry.path },
      asset: { path: result.asset.path, sizeBytes: result.sizeBytes },
      truncated,
      text: result.text.slice(0, maxChars),
    });
  },
});

const kbReadExtractTool = defineAgentTool<{
  extractPath: string;
  maxChars?: number;
}>({
  name: "kb_read_extract",
  label: "KB: Read Extract",
  description:
    "Read a bounded generated text extract for a KB asset. Read-only and limited to .kb/generated/extracts/.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["extractPath"],
    properties: {
      extractPath: {
        type: "string",
        description: "Generated extract path under .kb/generated/extracts/.",
      },
      maxChars: { type: "number", description: "Maximum extract characters." },
    },
  },
  async execute(params) {
    const result = await readKnowledgeGeneratedExtract(
      store(),
      params.extractPath,
      params.maxChars,
    );
    if (!result)
      throw new KnowledgeBaseError(
        `Generated extract not found: ${params.extractPath}`,
      );
    return compactJsonResult(result);
  },
});

export const assistantKnowledgeBaseTools = [
  kbTreeTool,
  kbSearchTool,
  kbGetEntryTool,
  kbShowEntryTool,
  kbWriteEntryTool,
  kbEditEntryTool,
  kbAddAssetTool,
  kbListAssetsTool,
  kbReadAssetTool,
  kbReadExtractTool,
  kbMoveEntryTool,
  kbHistoryTool,
  kbDiffTool,
];
