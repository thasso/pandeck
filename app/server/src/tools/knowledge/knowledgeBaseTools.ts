import { Buffer } from "node:buffer";
import {
  defineAgentTool,
  type ToolCallContext,
  type ToolResult,
} from "../../mcp/tool.ts";
import type { KnowledgeEntryCard } from "@assistant/shared";
import { knowledgeFileLink } from "@assistant/shared/objectLinks";
import { readSessionAttachmentBytes } from "../../sessionAttachments.ts";
import { normalizeKnowledgeRelativePath } from "../../knowledgeBaseContract.ts";
import {
  knowledgeFile,
  knowledgeFiles,
  searchKnowledgeFiles,
} from "../../knowledgeBaseIndex.ts";
import {
  KnowledgeBaseError,
  KnowledgeBaseStore,
  type KbCommitMeta,
  type KbCommitResult,
  type KbTreeNode,
} from "../../knowledgeBaseStore.ts";

const DEFAULT_LIST_MAX_ITEMS = 200;
const MAX_LIST_ITEMS = 1000;
const DEFAULT_LIST_DEPTH = 2;
const DEFAULT_READ_CHARS = 20_000;
const MAX_READ_CHARS = 200_000;
/** A text file is read whole up to this size; larger ones are refused. */
const MAX_READ_FILE_BYTES = 10_000_000;
/** Bytes sniffed for a NUL to tell a binary file from text. */
const BINARY_SNIFF_BYTES = 8000;
const DEFAULT_PATCH_CHARS = 12_000;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_TOOL_LIMIT = 100;
const MAX_CARD_NOTE_CHARS = 200;

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

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}

function clampLimit(
  value: number | undefined,
  fallback: number,
  cap: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1)
    throw new KnowledgeBaseError(`${name} must be a positive number.`);
  return Math.min(Math.floor(value), cap);
}

function requiredPath(value: string | undefined, name = "path"): string {
  let path: string;
  try {
    path = normalizeKnowledgeRelativePath(value ?? "");
  } catch (err) {
    throw new KnowledgeBaseError((err as Error).message);
  }
  if (!path) throw new KnowledgeBaseError(`${name} is required.`);
  return path;
}

function commitMeta(
  ctx: ToolCallContext,
  params: { reason: string; taskId?: string },
): KbCommitMeta {
  const reason = params.reason?.trim();
  if (!reason)
    throw new KnowledgeBaseError("reason is required for KB changes.");
  const taskId = params.taskId?.trim() || undefined;
  return {
    actor: {
      kind: "agent",
      id: `${ctx.session.harness}:${ctx.session.agentType}:${ctx.session.sessionId}`,
      name: ctx.session.title?.trim() || `${ctx.session.agentType} agent`,
    },
    reason,
    sessionId: ctx.session.sessionId,
    ...(taskId !== undefined ? { taskId } : {}),
  };
}

function commitRow(commit: KbCommitResult) {
  return { commit: commit.shortCommit, changedPaths: commit.changedPaths };
}

const reasonProperty = {
  type: "string",
  description: "Concise commit reason; becomes the commit subject.",
} as const;
const taskIdProperty = {
  type: "string",
  description: "Optional related Task id, recorded on the commit.",
} as const;

export const kbSearchTool = defineAgentTool<{
  query: string;
  path?: string;
  maxResults?: number;
}>({
  name: "kb_search",
  label: "KB: Search",
  searchHint:
    "knowledge base kb durable knowledge notes briefs decisions reference",
  description:
    "Search the Knowledge Base — the user's folder of durable notes, briefs, decisions, plans and reference files — by title, path, tags, headings and text. Read-only. Use before answering durable questions or asking the user about facts it may already hold, and before writing, to update an existing file rather than start a duplicate. Read a hit with kb_read.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", description: "Search text." },
      path: {
        type: "string",
        description: "Optional folder to search under.",
      },
      maxResults: {
        type: "number",
        description: `Maximum hits. Defaults to 20; capped at ${MAX_TOOL_LIMIT}.`,
      },
    },
  },
  async execute(params) {
    if (!params.query?.trim())
      throw new KnowledgeBaseError("query is required.");
    const under = params.path?.trim() ? requiredPath(params.path) : undefined;
    const results = searchKnowledgeFiles(
      await knowledgeFiles(store()),
      params.query,
      {
        limit: clampLimit(params.maxResults, 20, MAX_TOOL_LIMIT, "maxResults"),
        ...(under ? { under } : {}),
      },
    );
    return jsonResult({ query: params.query, results });
  },
});

export const kbListTool = defineAgentTool<{
  path?: string;
  depth?: number;
  maxItems?: number;
}>({
  name: "kb_list",
  label: "KB: List",
  searchHint: "knowledge base kb folder files browse tree list",
  description:
    "List the KB's folders and files (the root, or one folder), with each Markdown file's title. Read-only. Hidden paths (any segment starting with '.') are left out.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "Folder to list; the root if omitted.",
      },
      depth: {
        type: "number",
        description: `Folder levels to descend. Defaults to ${DEFAULT_LIST_DEPTH}; capped at 10.`,
      },
      maxItems: {
        type: "number",
        description: `Maximum rows. Defaults to ${DEFAULT_LIST_MAX_ITEMS}; capped at ${MAX_LIST_ITEMS}.`,
      },
    },
  },
  async execute(params) {
    const s = store();
    const under = params.path?.trim() ? requiredPath(params.path) : "";
    const depth = clampLimit(params.depth, DEFAULT_LIST_DEPTH, 10, "depth");
    const maxItems = clampLimit(
      params.maxItems,
      DEFAULT_LIST_MAX_ITEMS,
      MAX_LIST_ITEMS,
      "maxItems",
    );
    const baseDepth = under ? under.split("/").length : 0;
    const titles = new Map(
      (await knowledgeFiles(s)).map((file) => [file.path, file.title]),
    );
    const visible = (await s.listTree(under)).filter(
      (node) => node.path.split("/").length - baseDepth <= depth,
    );
    const items = visible.slice(0, maxItems).map((node: KbTreeNode) => {
      const title = titles.get(node.path);
      const name = node.path.split("/").pop();
      return {
        path: node.path,
        type: node.type,
        ...(node.type === "file" ? { sizeBytes: node.sizeBytes } : {}),
        ...(title && title !== name ? { title } : {}),
      };
    });
    return jsonResult({
      path: under,
      items,
      truncated: visible.length > items.length,
    });
  },
});

export const kbReadTool = defineAgentTool<{
  path: string;
  startLine?: number;
  maxChars?: number;
}>({
  name: "kb_read",
  label: "KB: Read",
  searchHint: "knowledge base kb read file note entry content",
  description:
    "Read one Knowledge Base text file, from startLine, up to maxChars; a longer file says where to continue (nextStartLine). Read-only. A binary file (PDF, image, spreadsheet) returns its size and absolute path instead: convert a PDF with convert_pdf or a spreadsheet with convert_xlsx (kbPath).",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "File path inside the KB." },
      startLine: {
        type: "number",
        description: "First line to return, 1-based. Defaults to 1.",
      },
      maxChars: {
        type: "number",
        description: `Maximum characters returned. Defaults to ${DEFAULT_READ_CHARS}; capped at ${MAX_READ_CHARS}.`,
      },
    },
  },
  async execute(params) {
    const s = store();
    const path = requiredPath(params.path);
    if ((await s.kindOf(path)) !== "file")
      throw new KnowledgeBaseError(
        `No file at "${path}"; kb_list shows what is there.`,
      );
    const sniff = await s.readBytes(path, BINARY_SNIFF_BYTES);
    const base = {
      path,
      link: knowledgeFileLink(path),
      absolutePath: s.absolutePath(path),
      sizeBytes: sniff.sizeBytes,
    };
    if (sniff.content.includes(0)) return jsonResult({ ...base, binary: true });
    if (sniff.sizeBytes > MAX_READ_FILE_BYTES)
      throw new KnowledgeBaseError(
        `"${path}" is ${sniff.sizeBytes} bytes, too large to read through kb_read.`,
      );
    const lines = (await s.readText(path)).split("\n");
    const startLine = clampLimit(
      params.startLine,
      1,
      Number.MAX_SAFE_INTEGER,
      "startLine",
    );
    const maxChars = clampLimit(
      params.maxChars,
      DEFAULT_READ_CHARS,
      MAX_READ_CHARS,
      "maxChars",
    );
    const out: string[] = [];
    let chars = 0;
    let line = startLine;
    for (; line <= lines.length; line++) {
      const text = lines[line - 1] ?? "";
      if (out.length > 0 && chars + text.length + 1 > maxChars) break;
      out.push(text.length > maxChars ? text.slice(0, maxChars) : text);
      chars += text.length + 1;
    }
    const title = (await knowledgeFile(s, path))?.title;
    return jsonResult({
      ...base,
      ...(title ? { title } : {}),
      totalLines: lines.length,
      startLine,
      endLine: line - 1,
      content: out.join("\n"),
      ...(line <= lines.length ? { nextStartLine: line } : {}),
    });
  },
});

export const kbWriteTool = defineAgentTool<{
  path: string;
  content?: string;
  contentBase64?: string;
  sourceAttachmentId?: string;
  reason: string;
  taskId?: string;
}>({
  name: "kb_write",
  label: "KB: Write",
  description:
    "Create or replace one file in the KB (the user's Git-backed knowledge folder), committed to its Git history. Markdown is the default for knowledge: notes, briefs, plans, decisions, project context; frontmatter is optional (`title`, `tags`, `summary` are what search shows). A binary file goes in by copying a session attachment (sourceAttachmentId — the bytes never pass through your context) or as base64. Organize by folder (general, per project, per task) and reuse existing files found with kb_search instead of starting duplicates. Link other KB files as pa://knowledge/<path> and tasks, projects and sessions as pa://task/<id> etc.; titles resolve when shown. Never store secrets, credentials, or raw sensitive message bodies; say where a fact came from and mark uncertain facts as uncertain. A short atomic preference or fact from an explicit 'remember this' belongs in Memory, not here. Ask first when the target file is ambiguous, a new fact conflicts with an existing one, or the change rewrites broad content. A file the user has edited without committing is refused: ask them to commit or discard it first.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "reason"],
    properties: {
      path: {
        type: "string",
        description: "File path inside the KB, e.g. projects/acme/plan.md.",
      },
      content: { type: "string", description: "The complete text content." },
      contentBase64: {
        type: "string",
        description: "Binary content, base64. Use instead of content.",
      },
      sourceAttachmentId: {
        type: "string",
        description:
          "Copy the raw bytes of a session attachment (from list_attachments or slack_file_read). Use instead of content.",
      },
      reason: reasonProperty,
      taskId: taskIdProperty,
    },
  },
  async execute(params, ctx) {
    const sources = [
      params.content,
      params.contentBase64,
      params.sourceAttachmentId,
    ].filter((value) => value !== undefined);
    if (sources.length !== 1)
      throw new KnowledgeBaseError(
        "Provide exactly one of content, contentBase64, or sourceAttachmentId.",
      );
    let content: Buffer | string;
    if (params.sourceAttachmentId !== undefined) {
      const attachment = readSessionAttachmentBytes(
        ctx.session.sessionId,
        params.sourceAttachmentId,
      );
      if (!attachment)
        throw new KnowledgeBaseError(
          `No session attachment found for id "${params.sourceAttachmentId}". Use list_attachments to see available attachments.`,
        );
      content = Buffer.from(attachment.bytes);
    } else {
      content =
        params.contentBase64 !== undefined
          ? Buffer.from(params.contentBase64, "base64")
          : params.content!;
    }
    const path = requiredPath(params.path);
    const commit = await store().commitChanges(
      [{ op: "write", path, content }],
      commitMeta(ctx, params),
    );
    return jsonResult({
      action: "write",
      path,
      link: knowledgeFileLink(path),
      ...commitRow(commit),
    });
  },
});

function applyExactReplacements(
  content: string,
  edits: { oldText: string; newText: string }[],
  path: string,
): string {
  const regions: { start: number; end: number; newText: string }[] = [];
  for (const edit of edits) {
    if (!edit.oldText)
      throw new KnowledgeBaseError("edits[].oldText must be non-empty.");
    const first = content.indexOf(edit.oldText);
    if (first < 0)
      throw new KnowledgeBaseError(
        `oldText not found in ${path}: ${JSON.stringify(edit.oldText.slice(0, 80))}`,
      );
    if (content.indexOf(edit.oldText, first + edit.oldText.length) >= 0)
      throw new KnowledgeBaseError(
        `oldText is not unique in ${path}: ${JSON.stringify(edit.oldText.slice(0, 80))}`,
      );
    regions.push({
      start: first,
      end: first + edit.oldText.length,
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
  return next + content.slice(cursor);
}

export const kbEditTool = defineAgentTool<{
  path: string;
  edits: { oldText: string; newText: string }[];
  reason: string;
  taskId?: string;
}>({
  name: "kb_edit",
  label: "KB: Edit",
  description:
    "Edit one KB text file with exact text replacements, committed to its Git history. Use for targeted changes after kb_read; every oldText must occur exactly once. Never store secrets, credentials, or raw sensitive message bodies; ask before broad rewrites. A file the user has edited without committing is refused.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "edits", "reason"],
    properties: {
      path: { type: "string", description: "File path inside the KB." },
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
      reason: reasonProperty,
      taskId: taskIdProperty,
    },
  },
  async execute(params, ctx) {
    const s = store();
    const path = requiredPath(params.path);
    const content = applyExactReplacements(
      await s.readText(path),
      params.edits ?? [],
      path,
    );
    const commit = await s.commitChanges(
      [{ op: "write", path, content }],
      commitMeta(ctx, params),
    );
    return jsonResult({
      action: "edit",
      path,
      replacements: params.edits.length,
      ...commitRow(commit),
    });
  },
});

export const kbMoveTool = defineAgentTool<{
  from: string;
  to: string;
  reason: string;
  taskId?: string;
}>({
  name: "kb_move",
  label: "KB: Move",
  description:
    "Move or rename one KB file or folder, committed to its Git history. The target must not exist. Links to the old path (pa://knowledge/<path>) are NOT rewritten: find them with kb_search and update them with kb_edit. Paths with the user's uncommitted edits are refused.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["from", "to", "reason"],
    properties: {
      from: { type: "string", description: "Current file or folder path." },
      to: { type: "string", description: "New path." },
      reason: reasonProperty,
      taskId: taskIdProperty,
    },
  },
  async execute(params, ctx) {
    const from = requiredPath(params.from, "from");
    const to = requiredPath(params.to, "to");
    const commit = await store().move(from, to, commitMeta(ctx, params));
    return jsonResult({ action: "move", from, to, ...commitRow(commit) });
  },
});

export const kbHistoryTool = defineAgentTool<{
  path?: string;
  limit?: number;
  commit?: string;
  maxChars?: number;
}>({
  name: "kb_history",
  label: "KB: History",
  searchHint: "knowledge base kb history log diff changes commit",
  description:
    "Git history of the KB, of one folder, or of one file (followed across renames). Read-only. With commit, returns the patch that commit made instead (scoped to path when given, bounded by maxChars). Commits made by the user directly carry no KB trailers.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", description: "Optional file or folder path." },
      limit: {
        type: "number",
        description: `Maximum commits. Defaults to ${DEFAULT_HISTORY_LIMIT}; capped at ${MAX_TOOL_LIMIT}.`,
      },
      commit: {
        type: "string",
        description: "A commit from the history, to read its patch.",
      },
      maxChars: {
        type: "number",
        description: `Maximum patch characters. Defaults to ${DEFAULT_PATCH_CHARS}.`,
      },
    },
  },
  async execute(params) {
    const s = store();
    const path = params.path?.trim() ? requiredPath(params.path) : undefined;
    if (params.commit?.trim()) {
      const patch = await s.showCommit(params.commit, {
        ...(path ? { path } : {}),
        maxChars: clampLimit(
          params.maxChars,
          DEFAULT_PATCH_CHARS,
          MAX_READ_CHARS,
          "maxChars",
        ),
      });
      return jsonResult({
        commit: params.commit.trim(),
        path: path ?? null,
        ...patch,
      });
    }
    const history = await s.history({
      ...(path ? { path } : {}),
      limit: clampLimit(
        params.limit,
        DEFAULT_HISTORY_LIMIT,
        MAX_TOOL_LIMIT,
        "limit",
      ),
    });
    return jsonResult({
      path: path ?? null,
      history: history.map((row) => ({
        commit: row.shortCommit,
        date: row.date,
        author: row.author,
        subject: row.subject,
        ...(row.trailers["KB-Paths"]
          ? { paths: row.trailers["KB-Paths"] }
          : {}),
        ...(row.trailers["KB-Session"]
          ? { sessionId: row.trailers["KB-Session"] }
          : {}),
      })),
    });
  },
});

/**
 * `kb_show` — put a Knowledge Base file in front of the user as a card they
 * can open in the side panel, without pasting it into the conversation.
 *
 * The file is checked to exist here, and its path and title are re-spelled
 * from the folder rather than from the caller. The chat renders the structured
 * payload (`app/web/src/components/KnowledgeEntryToolCard.tsx`); nothing about
 * the file's content travels with it.
 */
export const kbShowTool = defineAgentTool<{
  path: string;
  note?: string;
}>({
  name: "kb_show",
  label: "KB: Show",
  searchHint: "knowledge base kb file open side panel show card read",
  description:
    "Put a card for one KB file in the chat, with actions that open it in the app's Knowledge side panel or the Knowledge view. Use it when you have written or changed a file the user should look at; it shows the file, it does not send its content to you.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "File path inside the KB." },
      note: {
        type: "string",
        description: `One short line on why you are showing this file, in plain text. Up to ${MAX_CARD_NOTE_CHARS} characters.`,
      },
    },
  },
  async execute(params) {
    const s = store();
    const path = requiredPath(params.path);
    if ((await s.kindOf(path)) !== "file")
      throw new KnowledgeBaseError(`No file at "${path}".`);
    const file = await knowledgeFile(s, path);
    const note = params.note
      ?.replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_CARD_NOTE_CHARS);
    const card: KnowledgeEntryCard = {
      path,
      title: file?.title ?? path.split("/").pop() ?? path,
      ...(file?.summary ? { summary: file.summary } : {}),
      ...(note ? { note } : {}),
    };
    return jsonResult({
      renderKind: "knowledgeEntry" as const,
      version: 2,
      card,
    });
  },
});

export const assistantKnowledgeBaseTools = [
  kbSearchTool,
  kbReadTool,
  kbListTool,
  kbShowTool,
  kbWriteTool,
  kbEditTool,
  kbMoveTool,
  kbHistoryTool,
];
