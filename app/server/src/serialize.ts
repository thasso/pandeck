import type {
  AttachmentRole,
  CommitDisplay,
  CommitFileChange,
  CompactionDisplay,
  DisplayAttachment,
  DisplayBlock,
  DisplayMessage,
  SessionArtifact,
} from "@assistant/shared";
import { analyzeProviderError } from "./providerErrors.ts";

/**
 * Structural shapes for the pi message history we read off `session.messages`.
 * Defined locally so we don't depend on nested pi-ai/pi-agent-core type exports.
 */
interface TextContent {
  type: "text";
  text: string;
}
interface ThinkingContent {
  type: "thinking";
  thinking: string;
}
interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
interface UserMessage {
  role: "user";
  content:
    | string
    | Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}
interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  stopReason?: string;
  errorMessage?: string;
  api?: string;
  provider?: string;
  model?: string;
  responseId?: string;
}
interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
}
export type AnyMessage = UserMessage | AssistantMessage | ToolResultMessage;

interface ResultEntryRef {
  message: ToolResultMessage;
  entryId: string;
  index: number;
}

const ARTIFACT_ENTRY = "assistant.session.artifact";

interface SessionEntryLike {
  type: string;
  id: string;
  timestamp?: string;
  message?: AnyMessage;
  customType?: string;
  data?: unknown;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
}

/**
 * Persisted user prompts append non-image attachments inline (so the model can
 * read them), which means a reloaded transcript would otherwise show that raw
 * suffix instead of the clean prompt + attachment chips the live view shows.
 * To reconstruct attachments generically on reload we embed a compact manifest
 * (comment-wrapped, so it reads as an inert comment to the model) right after
 * the user's text. `buildAttachmentManifest` writes it; `splitAttachmentManifest`
 * recovers the clean text and the attachment metadata for ALL attachment kinds.
 */
const MANIFEST_OPEN = "<!--pa:attachments:";
const MANIFEST_CLOSE = "-->";
const MANIFEST_PREFIX = `\n\n${MANIFEST_OPEN}`;

interface AttachmentManifestItem {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  role?: AttachmentRole;
}

export function buildAttachmentManifest(
  items: AttachmentManifestItem[],
): string {
  if (items.length === 0) return "";
  const compact = items.map((item) => ({
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    size: item.size,
    ...(item.role ? { role: item.role } : {}),
  }));
  // Base64 so attachment names/types can't collide with the `-->` terminator.
  const encoded = Buffer.from(JSON.stringify(compact), "utf8").toString(
    "base64",
  );
  return `${MANIFEST_OPEN}${encoded}${MANIFEST_CLOSE}`;
}

/** Recover `{ text, attachments }` from a persisted user prompt, stripping the manifest + inline suffix. */
export function splitAttachmentManifest(rawText: string): {
  text: string;
  attachments: DisplayAttachment[];
} {
  const at = rawText.indexOf(MANIFEST_PREFIX);
  if (at < 0) return { text: rawText, attachments: [] };
  const text = rawText.slice(0, at);
  const open = at + 2; // skip the leading "\n\n"
  const close = rawText.indexOf(MANIFEST_CLOSE, open + MANIFEST_OPEN.length);
  if (close < 0) return { text, attachments: [] };
  let attachments: DisplayAttachment[] = [];
  try {
    const decoded = Buffer.from(
      rawText.slice(open + MANIFEST_OPEN.length, close),
      "base64",
    ).toString("utf8");
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed)) {
      attachments = parsed.flatMap((entry): DisplayAttachment[] => {
        if (!entry || typeof entry !== "object") return [];
        const o = entry as Record<string, unknown>;
        if (typeof o.id !== "string" || typeof o.name !== "string") return [];
        return [
          {
            id: o.id,
            name: o.name,
            mimeType:
              typeof o.mimeType === "string"
                ? o.mimeType
                : "application/octet-stream",
            size: typeof o.size === "number" ? o.size : 0,
            ...(o.role === "task-context" ||
            o.role === "project-context" ||
            o.role === "knowledge-context"
              ? { role: o.role }
              : {}),
          },
        ];
      });
    }
  } catch {
    // A malformed/truncated manifest just yields no reconstructed attachments.
  }
  return { text, attachments };
}

interface ImageSerializeCtx {
  kind: string;
  sessionId: string;
  entryId: string;
}

/** Build the display blocks for a persisted user message: clean text + reconstructed attachment chips. */
function userMessageBlocks(
  rawText: string,
  images: ImageContent[],
  imageIdPrefix: string,
  imageCtx?: ImageSerializeCtx,
): { blocks: DisplayBlock[]; empty: boolean } {
  const { text, attachments } = splitAttachmentManifest(rawText);
  const blocks: DisplayBlock[] = [
    ...(text.trim().length ? [{ kind: "text" as const, text }] : []),
    ...attachments.map((attachment) => ({
      kind: "attachment" as const,
      attachment,
    })),
    ...images.map((image, n) => {
      const attachment = imageCtx
        ? {
            id: `${imageCtx.entryId}-img${n}`,
            name: `Image ${n + 1}`,
            mimeType: image.mimeType,
            size: Math.ceil(image.data.length * 0.75),
            url: `/api/session-image/${imageCtx.kind}/${imageCtx.sessionId}/${imageCtx.entryId}/${n}`,
          }
        : {
            id: `${imageIdPrefix}-img${n}`,
            name: `Image ${n + 1}`,
            mimeType: image.mimeType,
            size: Math.ceil(image.data.length * 0.75),
            data: image.data,
          };
      return { kind: "attachment" as const, attachment };
    }),
  ];
  return {
    blocks,
    empty:
      text.trim().length === 0 &&
      images.length === 0 &&
      attachments.length === 0,
  };
}

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/**
 * A provider display diff with the file's REAL line numbers, if the tool result
 * carries one. pi's edit tools put a rendered, line-numbered diff in
 * `details.diff`; the model-facing text content only says the edit succeeded, so
 * this is the only place the true line numbers exist. Rendering only.
 */
export function toolResultDisplayDiff(result: unknown): string | undefined {
  if (result == null || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (details == null || typeof details !== "object") return undefined;
  const diff = (details as { diff?: unknown }).diff;
  return typeof diff === "string" && diff.length > 0 ? diff : undefined;
}

/** Render a tool result / partial result into a display string. */
export function formatToolResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const r = result as {
    content?: Array<{ type: string; text?: string }>;
    text?: string;
  };
  if (Array.isArray(r.content)) return textOf(r.content);
  if (typeof r.text === "string") return r.text;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/**
 * Convert persisted pi history into renderable display messages. Each agent run
 * (assistant message + any tool calls it issued) collapses the assistant text,
 * thinking and tool blocks into a single assistant turn, in arrival order.
 */
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function assistantTerminalError(message: AssistantMessage): string | undefined {
  if (message.stopReason === "error")
    return message.errorMessage || "Unknown provider error";
  if (message.stopReason === "aborted") {
    return message.errorMessage &&
      message.errorMessage !== "Request was aborted"
      ? message.errorMessage
      : "Operation aborted";
  }
  return undefined;
}

function assistantTerminalErrorInfo(
  message: AssistantMessage,
): DisplayMessage["errorInfo"] {
  const error = assistantTerminalError(message);
  if (!error) return undefined;
  if (message.stopReason === "aborted") {
    return {
      kind: "aborted",
      title: "Agent run aborted",
      summary: error,
      rawMessage: error,
      retryable: false,
      ...(message.provider !== undefined ? { provider: message.provider } : {}),
      ...(message.model !== undefined ? { model: message.model } : {}),
      ...(message.api !== undefined ? { api: message.api } : {}),
      ...(message.responseId !== undefined
        ? { responseId: message.responseId }
        : {}),
    };
  }
  return analyzeProviderError(error, {
    ...(message.provider !== undefined ? { provider: message.provider } : {}),
    ...(message.model !== undefined ? { model: message.model } : {}),
    ...(message.api !== undefined ? { api: message.api } : {}),
    ...(message.responseId !== undefined
      ? { responseId: message.responseId }
      : {}),
  });
}

function commitBlockers(value: unknown): CommitDisplay["blockers"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): CommitDisplay["blockers"] => {
    if (!item || typeof item !== "object") return [];
    const obj = item as Record<string, unknown>;
    const reason = typeof obj.reason === "string" ? obj.reason : "";
    if (!reason) return [];
    return [
      {
        kind: typeof obj.kind === "string" ? obj.kind : "other",
        ...(typeof obj.file === "string" ? { file: obj.file } : {}),
        reason,
      },
    ];
  });
}

function commitFiles(value: unknown): CommitFileChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): CommitFileChange[] => {
    if (!item || typeof item !== "object") return [];
    const obj = item as Record<string, unknown>;
    if (typeof obj.path !== "string") return [];
    const status = typeof obj.status === "string" ? obj.status : "changed";
    return [
      {
        path: obj.path,
        status: [
          "added",
          "modified",
          "deleted",
          "renamed",
          "copied",
          "untracked",
          "changed",
        ].includes(status)
          ? (status as CommitFileChange["status"])
          : "changed",
        ...(typeof obj.additions === "number"
          ? { additions: obj.additions }
          : {}),
        ...(typeof obj.deletions === "number"
          ? { deletions: obj.deletions }
          : {}),
        ...(typeof obj.sessionTouched === "boolean"
          ? { sessionTouched: obj.sessionTouched }
          : {}),
      },
    ];
  });
}

function commitDisplayFromEntry(
  entry: SessionEntryLike,
): CommitDisplay | undefined {
  if (!entry.data || typeof entry.data !== "object") return undefined;
  const data = entry.data as Record<string, unknown>;
  const status = typeof data.status === "string" ? data.status : "failed";
  if (!["committed", "dry-run", "blocked", "failed"].includes(status))
    return undefined;
  const files = commitFiles(data.files);
  const totals =
    data.totals && typeof data.totals === "object"
      ? (data.totals as Record<string, unknown>)
      : {};
  return {
    entryId: entry.id,
    status: status as CommitDisplay["status"],
    dryRun: data.dryRun === true,
    forced: data.forced === true,
    ...(typeof data.repoRoot === "string" ? { repoRoot: data.repoRoot } : {}),
    ...(typeof data.commitHash === "string"
      ? { commitHash: data.commitHash }
      : {}),
    ...(typeof data.commitMessage === "string"
      ? { commitMessage: data.commitMessage }
      : {}),
    blockers: commitBlockers(data.blockers),
    warnings: stringArray(data.warnings),
    files,
    totals: {
      files: typeof totals.files === "number" ? totals.files : files.length,
      additions: typeof totals.additions === "number" ? totals.additions : 0,
      deletions: typeof totals.deletions === "number" ? totals.deletions : 0,
    },
    canAcceptDryRun: status === "dry-run",
    ...(typeof data.error === "string" ? { error: data.error } : {}),
  };
}

function serializeCommitEntry(
  entry: SessionEntryLike,
  index: number,
): DisplayMessage | undefined {
  if (entry.type !== "custom" || entry.customType !== "workshop.commit")
    return undefined;
  if (!entry.data || typeof entry.data !== "object") return undefined;
  const data = entry.data as Record<string, unknown>;
  if (data.source !== "slash") return undefined;
  const commit = commitDisplayFromEntry(entry);
  if (!commit) return undefined;
  return {
    id: `h${index}`,
    role: "assistant",
    blocks: [{ kind: "commit", commit }],
    forkAtEntryId: entry.id,
  };
}

function artifactFromEntry(
  entry: SessionEntryLike,
): SessionArtifact | undefined {
  if (entry.type !== "custom" || entry.customType !== ARTIFACT_ENTRY)
    return undefined;
  if (!entry.data || typeof entry.data !== "object") return undefined;
  const data = entry.data as Record<string, unknown>;
  const id = typeof data.id === "string" ? data.id : "";
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
  const kind = typeof data.kind === "string" ? data.kind : "file";
  const label =
    typeof data.label === "string" ? data.label : "Session artifact";
  const name = typeof data.name === "string" ? data.name : "artifact";
  const mimeType =
    typeof data.mimeType === "string"
      ? data.mimeType
      : "application/octet-stream";
  const size = typeof data.size === "number" ? data.size : 0;
  const createdAt =
    typeof data.createdAt === "number" ? data.createdAt : Date.now();
  const url = typeof data.url === "string" ? data.url : "";
  if (!id || !sessionId || !url) return undefined;
  if (!["screenshot", "trace", "video", "download", "file"].includes(kind))
    return undefined;
  return {
    id,
    sessionId,
    kind: kind as SessionArtifact["kind"],
    label,
    name,
    mimeType,
    size,
    createdAt,
    url,
    ...(typeof data.sourceTool === "string"
      ? { sourceTool: data.sourceTool }
      : {}),
  };
}

function serializeArtifactEntry(
  entry: SessionEntryLike,
  index: number,
): DisplayMessage | undefined {
  const artifact = artifactFromEntry(entry);
  if (!artifact) return undefined;
  // Keep chat inline artifacts bounded and visual by default. Other files remain
  // discoverable in the session drawer or through explicit links.
  if (!artifact.mimeType.startsWith("image/") && artifact.kind !== "screenshot")
    return undefined;
  return {
    id: `h${index}`,
    role: "assistant",
    blocks: [{ kind: "artifact", artifact }],
    forkAtEntryId: entry.id,
  };
}

function serializeCompactionEntry(
  entry: SessionEntryLike,
  index: number,
): DisplayMessage | undefined {
  if (entry.type !== "compaction") return undefined;
  if (
    typeof entry.summary !== "string" ||
    typeof entry.firstKeptEntryId !== "string"
  )
    return undefined;
  const compaction: CompactionDisplay = {
    summary: entry.summary,
    firstKeptEntryId: entry.firstKeptEntryId,
    tokensBefore:
      typeof entry.tokensBefore === "number" ? entry.tokensBefore : 0,
  };
  return {
    id: `h${index}`,
    role: "assistant",
    blocks: [{ kind: "compaction", compaction }],
    forkAtEntryId: entry.id,
  };
}

/** Serialize the current session branch, including selected non-context custom entries. */
export function serializeSessionBranch(
  entries: readonly SessionEntryLike[],
  ctx?: { kind: string; sessionId: string },
): DisplayMessage[] {
  const results = new Map<string, ResultEntryRef>();
  entries.forEach((entry, index) => {
    if (entry.type === "message" && entry.message?.role === "toolResult") {
      results.set(entry.message.toolCallId, {
        message: entry.message,
        entryId: entry.id,
        index,
      });
    }
  });

  const out: DisplayMessage[] = [];
  let index = 0;

  for (const entry of entries) {
    if (entry.type === "custom") {
      const customIndex = index++;
      const custom =
        serializeCommitEntry(entry, customIndex) ??
        serializeArtifactEntry(entry, customIndex);
      if (custom) out.push(custom);
      continue;
    }
    if (entry.type === "compaction") {
      const compaction = serializeCompactionEntry(entry, index++);
      if (compaction) out.push(compaction);
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const m = entry.message;
    if (m.role === "user") {
      const rawText =
        typeof m.content === "string" ? m.content : textOf(m.content);
      const images = Array.isArray(m.content)
        ? m.content.filter(
            (c): c is ImageContent =>
              c.type === "image" && typeof c.data === "string",
          )
        : [];
      const imageCtx = ctx
        ? { kind: ctx.kind, sessionId: ctx.sessionId, entryId: entry.id }
        : undefined;
      const { blocks, empty } = userMessageBlocks(
        rawText,
        images,
        `h${index}`,
        imageCtx,
      );
      if (empty) continue;
      out.push({
        id: `h${index++}`,
        role: "user",
        forkBeforeEntryId: entry.id,
        blocks,
        ...(entry.timestamp ? { createdAt: entry.timestamp } : {}),
      });
    } else if (m.role === "assistant") {
      const blocks: DisplayBlock[] = [];
      for (const c of m.content) {
        if (c.type === "text") {
          if (c.text.length) blocks.push({ kind: "text", text: c.text });
        } else if (c.type === "thinking") {
          if (c.thinking.length)
            blocks.push({ kind: "thinking", text: c.thinking });
        } else if (c.type === "toolCall") {
          const res = results.get(c.id);
          // Bound once: the guard below cannot narrow a second call's result.
          const resultDiff = res
            ? toolResultDisplayDiff(res.message)
            : undefined;
          blocks.push({
            kind: "tool",
            toolId: c.id,
            name: c.name,
            args: c.arguments,
            output: res
              ? formatToolResult({ content: res.message.content })
              : "",
            isError: res?.message.isError ?? false,
            done: Boolean(res),
            ...(resultDiff !== undefined ? { resultDiff } : {}),
          });
        }
      }
      const error = assistantTerminalError(m);
      const errorInfo = assistantTerminalErrorInfo(m);
      const resultRefs = m.content
        .filter((c): c is ToolCallContent => c.type === "toolCall")
        .map((c) => results.get(c.id))
        .filter((r): r is ResultEntryRef => Boolean(r));
      const lastResult = resultRefs.sort((a, b) => b.index - a.index)[0];
      if (blocks.length || error) {
        out.push({
          id: `h${index++}`,
          role: "assistant",
          blocks,
          ...(error !== undefined ? { error } : {}),
          ...(errorInfo !== undefined ? { errorInfo } : {}),
          forkAtEntryId: lastResult?.entryId ?? entry.id,
          ...(entry.timestamp ? { createdAt: entry.timestamp } : {}),
        });
      }
    }
  }

  return out;
}
