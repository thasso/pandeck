/**
 * The gateway's file tools in client mode (Task-1441 P7a, H3): one
 * `AgentTool` per accepted `FILE_TOOLS` entry (`remoteTools.ts`), the LOCAL
 * tool by name, label, description, schema and search hint, whose answer
 * this server checks and stages itself.
 *
 * A call runs in this order, and every refusal before staging stages nothing:
 * 1. the dispatch gate: connection, the product's toggle, and the current
 *    listing's acceptance with its `file` limits;
 * 2. E, the call's byte limit: the listing's `maxBytes` and the tool's own
 *    limit argument, clamped as the local tool clamps it;
 * 3. `callFile`, which decodes the answer against E (`decodeFileAnswer`);
 * 4. the abort fence;
 * 5. the gate again, with the same `file` limits;
 * 6. a file: the adapter's `validateFileText`, `stageSessionAttachment` once,
 *    then `buildFileResult`; a plain answer: `validatePlainText`.
 *
 * The adapters are code, never data from the listing. The texts are this
 * server's own (`remoteReadRules.ts`); only the edge's `tool_error` and
 * `invalid_params` texts reach the agent. The tool's `sideEffects` is the
 * catalog's classification of its name (`classifiedByCatalog`).
 *
 * Imports no catalog, tool group or local tool module
 * (`architecture.test.ts`).
 */
import {
  CONFLUENCE_DOWNLOAD_DESCRIPTION,
  CONFLUENCE_DOWNLOAD_LABEL,
  CONFLUENCE_DOWNLOAD_SCHEMA,
  CONFLUENCE_DOWNLOAD_SEARCH_HINT,
} from "../../confluenceDownload.ts";
import { clamp } from "../../confluenceRead.ts";
import {
  jsonResult,
  type AgentTool,
  type ToolCallContext,
  type ToolResult,
} from "../../mcp/tool.ts";
import {
  RemoteToolRefusal,
  remoteFileLimits,
  remoteFileRow,
  remoteProductEnabled,
  remoteToolPort,
  remoteToolsConnected,
  type RemoteFileAnswer,
  type RemoteFileDescriptor,
  type RemoteFileLimits,
  type RemoteFileName,
} from "../../remoteTools.ts";
import {
  stageSessionAttachment,
  type SessionAttachmentRecord,
  type SessionAttachmentSource,
} from "../../sessionAttachments.ts";
import {
  DISABLED,
  FILE_BUSY_HERE,
  FILE_CORRUPTED,
  NO_TOOLS,
  UNEXPECTED_FILE_ANSWER,
  UNREACHABLE,
  failureText,
  noLongerOffered,
} from "./remoteReadRules.ts";

const CANCELLED = "The call was cancelled.";

/** How one file tool's answer becomes the local tool's result. */
export interface FileAdapter<Fields> {
  /** The staged attachment's source in the session store. */
  source: SessionAttachmentSource;
  /** The file text's exact fields, or undefined to refuse it. */
  validateFileText(text: string): Fields | undefined;
  /** The local tool's result JSON, in its key order. */
  buildFileResult(fields: Fields, staged: SessionAttachmentRecord): unknown;
  /** A plain answer's result JSON, or undefined to refuse it. */
  validatePlainText(text: string): unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactly = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

const orNull = <T>(
  value: unknown,
  check: (candidate: unknown) => candidate is T,
): value is T | null => value === null || check(value);

const safeCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

interface ConfluenceFileFields {
  pageId: string | null;
  attachment: {
    id: string;
    title: string;
    mediaType: string | null;
    fileSize: number | null;
    version: number | null;
    downloadUrl: string | null;
  };
}

const ATTACHMENT_KEYS = [
  "id",
  "title",
  "mediaType",
  "fileSize",
  "version",
  "downloadUrl",
] as const;

/**
 * The edge's Confluence file text, exactly (G4 step 6). `fileSize` must be a
 * safe integer here, where the local tool would pass any number (R6b).
 */
function confluenceFileFields(text: string): ConfluenceFileFields | undefined {
  const value = parsed(text);
  if (
    !isRecord(value) ||
    !hasExactly(value, ["status", "pageId", "attachment"])
  )
    return undefined;
  const { status, pageId, attachment } = value;
  if (status !== "saved_attachment") return undefined;
  if (!orNull(pageId, (v): v is string => boundedString(v, 64)))
    return undefined;
  if (!isRecord(attachment) || !hasExactly(attachment, ATTACHMENT_KEYS))
    return undefined;
  const { id, title, mediaType, fileSize, version, downloadUrl } = attachment;
  if (
    !boundedString(id, 64) ||
    !boundedString(title, 1024) ||
    !orNull(mediaType, (v): v is string => boundedString(v, 1024)) ||
    !orNull(fileSize, safeCount) ||
    !orNull(version, safeCount) ||
    !orNull(
      downloadUrl,
      (v): v is string => boundedString(v, 2048) && v.startsWith("https://"),
    )
  )
    return undefined;
  return {
    pageId,
    attachment: { id, title, mediaType, fileSize, version, downloadUrl },
  };
}

/** What the local tool around each adapter shows the agent. */
interface FileToolDefinition {
  label: string;
  description: string;
  searchHint?: string;
  parameters: Record<string, unknown>;
}

/** The trusted adapters, by the tool names FILE_TOOLS admits; read only here and by tests. */
export const FILE_ADAPTERS: {
  [Name in RemoteFileName]: FileToolDefinition & {
    adapter: FileAdapter<ConfluenceFileFields>;
  };
} = {
  confluence_download_attachment: {
    label: CONFLUENCE_DOWNLOAD_LABEL,
    description: CONFLUENCE_DOWNLOAD_DESCRIPTION,
    searchHint: CONFLUENCE_DOWNLOAD_SEARCH_HINT,
    parameters: CONFLUENCE_DOWNLOAD_SCHEMA,
    adapter: {
      source: "confluence",
      validateFileText: confluenceFileFields,
      buildFileResult: (fields, staged) => ({
        status: "saved_attachment",
        pageId: fields.pageId,
        attachment: fields.attachment,
        sessionAttachment: {
          id: staged.id,
          name: staged.name,
          mimeType: staged.mimeType,
          size: staged.size,
          path: staged.path,
        },
      }),
      // The local tool has no success without a file.
      validatePlainText: () => undefined,
    },
  },
};

/**
 * The agent's result for a decoded file answer: the edge's failure as its
 * text, a file staged exactly once into `sessionId`'s store, or a plain
 * answer, each through `adapter`. Throws, staging nothing, on any refusal.
 */
export function settleFileAnswer<Fields>(
  name: string,
  adapter: FileAdapter<Fields>,
  answer: RemoteFileAnswer,
  sessionId: string,
): ToolResult {
  switch (answer.kind) {
    case "failure":
      throw new Error(
        failureText(name, {
          ok: false,
          code: answer.code,
          message: answer.message,
        }),
      );
    case "plain": {
      const result = adapter.validatePlainText(answer.text);
      if (result === undefined) throw new Error(UNEXPECTED_FILE_ANSWER);
      return jsonResult(result);
    }
    case "file": {
      const fields = adapter.validateFileText(answer.text);
      if (fields === undefined) throw new Error(UNEXPECTED_FILE_ANSWER);
      const staged = stageSessionAttachment(sessionId, {
        name: answer.file.name,
        mimeType: answer.file.mimeType,
        bytes: answer.bytes,
        source: adapter.source,
      });
      return jsonResult(adapter.buildFileResult(fields, staged));
    }
  }
}

/**
 * E for one call: the listing's `maxBytes` and the tool's own limit
 * argument, clamped as the local tool clamps it.
 */
export function effectiveFileBytes(
  name: RemoteFileName,
  limits: RemoteFileLimits,
  args: Record<string, unknown>,
): number {
  const { limitParam, hardMaxBytes } = remoteFileRow(name);
  const asked = args[limitParam];
  return Math.min(
    limits.maxBytes,
    clamp(
      typeof asked === "number" ? asked : undefined,
      limits.defaultBytes,
      1,
      hardMaxBytes,
    ),
  );
}

const sameLimits = (
  a: RemoteFileLimits | undefined,
  b: RemoteFileLimits,
): boolean =>
  a !== undefined &&
  a.limitParam === b.limitParam &&
  a.defaultBytes === b.defaultBytes &&
  a.maxBytes === b.maxBytes;

/** The link's refusal as this server's text. */
function refusalText(err: RemoteToolRefusal): string {
  switch (err.code) {
    case "tools_unavailable":
      return NO_TOOLS;
    case "unexpected_file":
      return UNEXPECTED_FILE_ANSWER;
    case "corrupted_file":
      return FILE_CORRUPTED;
    case "file_busy":
      return FILE_BUSY_HERE;
    default:
      return UNREACHABLE;
  }
}

/** The remote file tool; its `sideEffects` comes from the catalog. */
export type RemoteFileAgentTool = AgentTool & { classifiedByCatalog: true };

/** The agent tool for an accepted gateway file tool. */
export function remoteFileTool(
  descriptor: RemoteFileDescriptor,
): RemoteFileAgentTool {
  // The name from the accepted listing, never from an answer.
  const { name, product } = descriptor;
  const { adapter, ...definition } = FILE_ADAPTERS[name];
  /** The gate, before the call and again on its answer. */
  const gate = (): RemoteFileLimits => {
    if (!remoteToolsConnected()) throw new Error(UNREACHABLE);
    if (!remoteProductEnabled(product)) throw new Error(DISABLED[product]);
    const limits = remoteFileLimits(name);
    if (!limits) throw new Error(noLongerOffered(name));
    return limits;
  };
  return {
    name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.searchHint ? { searchHint: definition.searchHint } : {}),
    classifiedByCatalog: true,
    async execute(params, ctx: ToolCallContext): Promise<ToolResult> {
      const port = remoteToolPort();
      if (!port) throw new Error(UNREACHABLE);
      const limits = gate();
      const args = isRecord(params) ? params : {};
      const maxBytes = effectiveFileBytes(name, limits, args);
      const signal = ctx.signal ?? new AbortController().signal;
      try {
        return await port.callFile(
          name,
          args,
          signal,
          { maxBytes },
          (answer) => {
            if (signal.aborted) throw new Error(CANCELLED);
            if (!sameLimits(gate(), limits))
              throw new Error(noLongerOffered(name));
            return settleFileAnswer(
              name,
              adapter,
              answer,
              ctx.session.sessionId,
            );
          },
        );
      } catch (err) {
        if (err instanceof RemoteToolRefusal) throw new Error(refusalText(err));
        throw err;
      }
    },
  };
}
