import { defineAgentTool, type ToolCallContext } from "../../mcp/tool.ts";
import { getSlackPublicApiConfig } from "../../slackSettings.ts";
import { isSlackPrivateDownloadHost } from "../../slackUrls.ts";
import { stageSessionAttachment } from "../../sessionAttachments.ts";
import {
  SLACK_CONVERSATION_READ_DESCRIPTION,
  SLACK_SEARCH_DESCRIPTION,
  SLACK_THREAD_READ_DESCRIPTION,
  SLACK_UNREAD_DESCRIPTION,
  SlackApiError,
  clamp,
  compactObject,
  identity,
  publicFile,
  requireSlackTs,
  runSlackConversationRead,
  runSlackSearch,
  runSlackThreadRead,
  runSlackUnread,
  slackApi,
  slackConversationReadParamsSchema,
  slackSearchParamsSchema,
  slackThreadReadParamsSchema,
  slackUnreadParamsSchema,
  truncate,
  type SlackConversationReadParams,
  type SlackFile,
  type SlackReadConfig,
  type SlackSearchParams,
  type SlackThreadReadParams,
  type SlackUnreadParams,
} from "../../slackRead.ts";

export { clearSlackMetadataCaches } from "../../slackRead.ts";

export const slackSearchTool = defineAgentTool<SlackSearchParams>({
  name: "slack_search",
  label: "Slack: Search",
  description: SLACK_SEARCH_DESCRIPTION,
  parameters: slackSearchParamsSchema,
  async execute(params, ctx) {
    return result(await runSlackSearch(params, localConfig(), deps(ctx)));
  },
});

export const slackConversationReadTool =
  defineAgentTool<SlackConversationReadParams>({
    name: "slack_conversation_read",
    label: "Slack: Read conversation",
    description: SLACK_CONVERSATION_READ_DESCRIPTION,
    parameters: slackConversationReadParamsSchema,
    async execute(params, ctx) {
      return result(
        await runSlackConversationRead(params, localConfig(), deps(ctx)),
      );
    },
  });

export const slackThreadReadTool = defineAgentTool<SlackThreadReadParams>({
  name: "slack_thread_read",
  label: "Slack: Read thread",
  description: SLACK_THREAD_READ_DESCRIPTION,
  parameters: slackThreadReadParamsSchema,
  async execute(params, ctx) {
    return result(await runSlackThreadRead(params, localConfig(), deps(ctx)));
  },
});

export const slackUnreadTool = defineAgentTool<SlackUnreadParams>({
  name: "slack_unread",
  label: "Slack: Read personal unread messages",
  description: SLACK_UNREAD_DESCRIPTION,
  parameters: slackUnreadParamsSchema,
  async execute(params, ctx) {
    return result(await runSlackUnread(params, localConfig(), deps(ctx)));
  },
});

export const slackFileReadTool = defineAgentTool<{
  fileId: string;
  conversation?: string;
  messageTs?: string;
  threadTs?: string;
  maxCharacters?: number;
  maxDownloadBytes?: number;
}>({
  name: "slack_file_read",
  label: "Slack: Read file",
  description:
    "Read a Slack file with personal user OAuth: text-like files return bounded inline content; binary files (PDF, images, docs) are downloaded and staged as a session attachment you can copy into the KB. External, deleted, or inaccessible files return safe metadata/status only.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["fileId"],
    properties: {
      fileId: {
        type: "string",
        description: "Slack file id from a normalized message, e.g. F123.",
      },
      conversation: {
        type: "string",
        description: "Optional originating conversation id/name.",
      },
      messageTs: {
        type: "string",
        description: "Optional originating message timestamp.",
      },
      threadTs: {
        type: "string",
        description: "Optional originating thread root timestamp.",
      },
      maxCharacters: {
        type: "number",
        description:
          "Maximum extracted text characters. Defaults to 20,000; maximum 100,000.",
      },
      maxDownloadBytes: {
        type: "number",
        description:
          "Maximum bytes downloaded. Defaults to 10 MiB; maximum 20 MiB.",
      },
    },
  } as const,
  async execute(params, ctx) {
    const config = getSlackPublicApiConfig();
    const fileId = params.fileId?.trim();
    if (!/^F[A-Z0-9]+$/i.test(fileId))
      throw new Error("fileId must be a Slack file id such as F123.");
    const origin = compactObject({
      conversation: params.conversation?.trim(),
      messageTs: params.messageTs
        ? requireSlackTs(params.messageTs, "messageTs")
        : undefined,
      threadTs: params.threadTs
        ? requireSlackTs(params.threadTs, "threadTs")
        : undefined,
    });
    let file: SlackFile;
    try {
      file = ((await slackApi("files.info", { file: fileId }, config, ctx))
        .file ?? {}) as SlackFile;
    } catch (error) {
      if (
        error instanceof SlackApiError &&
        [
          "file_not_found",
          "not_found",
          "channel_not_found",
          "not_in_channel",
          "no_permission",
          "missing_scope",
        ].includes(error.code)
      ) {
        return result({
          capability: "file_read",
          identity: identity(config),
          file: { id: fileId },
          origin,
          status: fileStatus(error.code),
        });
      }
      throw error;
    }
    const metadata = publicFile(fileId, file);
    if (file.mode === "tombstone")
      return result({
        capability: "file_read",
        identity: identity(config),
        file: metadata,
        origin,
        status: "deleted",
      });
    if (file.is_external || file.mode === "external")
      return result({
        capability: "file_read",
        identity: identity(config),
        file: metadata,
        origin,
        status: "external_metadata_only",
      });
    const mime = normalizeMime(file.mimetype);
    const downloadUrl = file.url_private_download ?? file.url_private;
    if (!downloadUrl)
      return result({
        capability: "file_read",
        identity: identity(config),
        file: metadata,
        origin,
        status: "download_unavailable",
      });
    const maxBytes = clamp(
      params.maxDownloadBytes ?? 10 * 1024 * 1024,
      1,
      20 * 1024 * 1024,
    );
    const maxCharacters = clamp(params.maxCharacters ?? 20_000, 1, 100_000);
    if (typeof file.size === "number" && file.size > maxBytes)
      return result({
        capability: "file_read",
        identity: identity(config),
        file: metadata,
        origin,
        status: "download_limit_reached",
        downloadedBytes: 0,
      });
    const downloaded = await downloadSlackFile(
      downloadUrl,
      config.token,
      maxBytes,
      ctx,
    );
    const detectedMime = downloaded.mimeType;
    const fileForResult = { ...metadata, detectedMimeType: detectedMime };
    // Text-like content (by declared or served MIME) is returned inline, bounded.
    if (isTextLikeMime(mime) || isTextLikeMime(detectedMime)) {
      const content = new TextDecoder("utf-8", { fatal: false }).decode(
        downloaded.bytes,
      );
      return result({
        capability: "file_read",
        identity: identity(config),
        file: fileForResult,
        origin,
        status: downloaded.truncated ? "download_limit_reached" : "content",
        content: truncate(content, maxCharacters),
        contentTruncated:
          downloaded.truncated || content.length > maxCharacters,
        downloadedBytes: downloaded.bytes.byteLength,
      });
    }
    // Binary files (PDF, images, docs, …) are staged into the session attachment
    // store BY REFERENCE: the raw bytes never enter the model context. Follow up
    // with kb_write (sourceAttachmentId) to copy the file into the KB.
    if (downloaded.truncated || downloaded.bytes.byteLength === 0)
      return result({
        capability: "file_read",
        identity: identity(config),
        file: fileForResult,
        origin,
        status: "download_limit_reached",
        downloadedBytes: downloaded.bytes.byteLength,
      });
    const staged = stageSessionAttachment(ctx.session.sessionId, {
      name: file.name ?? file.title ?? `${fileId}`,
      mimeType: file.mimetype ?? detectedMime,
      bytes: downloaded.bytes,
      source: "slack",
    });
    return result({
      capability: "file_read",
      identity: identity(config),
      file: fileForResult,
      origin,
      status: "saved_attachment",
      attachment: {
        id: staged.id,
        name: staged.name,
        mimeType: staged.mimeType,
        size: staged.size,
      },
      downloadedBytes: downloaded.bytes.byteLength,
    });
  },
});

export const assistantSlackTools = [
  slackSearchTool,
  slackConversationReadTool,
  slackThreadReadTool,
  slackUnreadTool,
  slackFileReadTool,
];

/**
 * The core's config for the local tools: metadata keyed by team and token
 * tail as before, and `slack_unread` re-lists conversations on every call.
 */
function localConfig(): SlackReadConfig {
  const config = getSlackPublicApiConfig();
  return {
    ...config,
    cacheKey: `${config.teamId}:${config.token.slice(-12)}`,
    unreadListMaxAgeMs: 0,
  };
}
function deps(ctx: ToolCallContext) {
  return { signal: ctx.signal };
}
function result(payload: Record<string, unknown>) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    details: payload,
  };
}
function fileStatus(code: string) {
  return code === "file_not_found" || code === "not_found"
    ? "inaccessible_or_deleted"
    : code === "missing_scope"
      ? "files_read_scope_missing"
      : "permission_restricted";
}
function normalizeMime(value?: string) {
  return (
    value?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream"
  );
}
function isTextLikeMime(mime: string) {
  return (
    mime.startsWith("text/") ||
    [
      "application/json",
      "application/ld+json",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
      "application/javascript",
      "application/x-ndjson",
      "application/sql",
    ].includes(mime) ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}
async function downloadSlackFile(
  initialUrl: string,
  token: string,
  maxBytes: number,
  ctx: ToolCallContext,
): Promise<{ bytes: Uint8Array; mimeType: string; truncated: boolean }> {
  let url: URL;
  try {
    url = new URL(initialUrl);
  } catch {
    throw new Error("Slack returned an invalid private file URL.");
  }
  if (!isAllowedSlackDownloadUrl(url))
    throw new Error("Slack returned an unsafe private file URL.");
  const timeout = AbortSignal.timeout(15_000);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": "personal-assistant-slack/1.0",
      },
      redirect: "manual",
      signal,
    });
    if (response.status === 429)
      throw new Error(
        `Slack file download rate limited; retry after ${response.headers.get("retry-after") ?? "unknown"} seconds.`,
      );
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 3)
        throw new Error("Slack file download exceeded the redirect limit.");
      url = new URL(location, url);
      if (!isAllowedSlackDownloadUrl(url))
        throw new Error("Slack file download redirected to an unsafe URL.");
      continue;
    }
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404
    )
      throw new Error(
        `Slack file download is inaccessible (HTTP ${response.status}).`,
      );
    if (!response.ok)
      throw new Error(
        `Slack file download failed with HTTP ${response.status}.`,
      );
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      return {
        bytes: new Uint8Array(),
        mimeType: normalizeMime(
          response.headers.get("content-type") ?? undefined,
        ),
        truncated: true,
      };
    }
    const reader = response.body?.getReader();
    if (!reader)
      return {
        bytes: new Uint8Array(),
        mimeType: normalizeMime(
          response.headers.get("content-type") ?? undefined,
        ),
        truncated: false,
      };
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = maxBytes - total;
      if (next.value.byteLength > remaining) {
        if (remaining > 0) chunks.push(next.value.subarray(0, remaining));
        total += Math.max(0, remaining);
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      bytes,
      mimeType: normalizeMime(
        response.headers.get("content-type") ?? undefined,
      ),
      truncated,
    };
  }
  throw new Error("Slack file download failed.");
}
function isAllowedSlackDownloadUrl(url: URL) {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    isSlackPrivateDownloadHost(url.hostname)
  );
}
