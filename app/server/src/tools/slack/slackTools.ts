import { defineAgentTool, type ToolCallContext } from "../../mcp/tool.ts";
import { localDayBoundsMs } from "@assistant/shared/zonedTime";
import {
  getSlackPublicApiConfig,
  type SlackPublicApiConfig,
} from "../../slackSettings.ts";
import { isSlackPrivateDownloadHost } from "../../slackUrls.ts";
import { stageSessionAttachment } from "../../sessionAttachments.ts";

type DetailLevel = "compact" | "standard" | "full";
type SlackApiResponse = Record<string, any> & {
  ok?: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
};
type SlackConversation = {
  id?: string;
  name?: string;
  user?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  members?: string[];
  last_read?: string;
  latest?: SlackMessage | { ts?: string } | string;
  unread_count?: number;
  unread_count_display?: number;
};
type SlackUser = {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  updated?: number;
  profile?: { display_name?: string; real_name?: string; email?: string };
};
type SlackUserGroup = {
  id?: string;
  handle?: string;
  name?: string;
  date_update?: number;
  users?: string[];
};
type SlackFile = {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  permalink?: string;
  mode?: string;
  is_external?: boolean;
  external_type?: string;
  url_private?: string;
  url_private_download?: string;
};
type SlackMessage = {
  ts?: string;
  thread_ts?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  reply_count?: number;
  latest_reply?: string;
  permalink?: string;
  channel?: { id?: string; name?: string };
  reactions?: Array<{ name?: string; count?: number }>;
  files?: SlackFile[];
  blocks?: Array<{
    type?: string;
    block_id?: string;
    elements?: unknown[];
    accessory?: unknown;
  }>;
  attachments?: Array<{
    id?: number;
    color?: string;
    service_name?: string;
    author_name?: string;
    author_link?: string;
    title?: string;
    text?: string;
    fallback?: string;
    title_link?: string;
    from_url?: string;
    image_url?: string;
    thumb_url?: string;
    footer?: string;
    ts?: number;
  }>;
};
type SlackReference = {
  type: "user" | "channel" | "user_group";
  id: string;
  label: string;
};
type NormalizedMessage = {
  ts: string;
  localTime: string | null;
  channelId?: string;
  channelName?: string;
  userId?: string;
  userName?: string;
  botId?: string;
  subtype?: string;
  text: string;
  rawText?: string;
  references?: SlackReference[];
  threadTs?: string;
  isThreadReply: boolean;
  replyCount?: number;
  latestReply?: string;
  permalink?: string;
  reactions?: Array<{ name: string; count: number }>;
  files?: Array<{
    id?: string;
    name?: string;
    title?: string;
    mimetype?: string;
    filetype?: string;
    size?: number;
    permalink?: string;
    mode?: string;
    isExternal?: boolean;
    externalType?: string;
  }>;
  blocks?: Array<{
    type?: string;
    blockId?: string;
    links?: Array<{ url: string; label?: string }>;
  }>;
  attachments?: Array<{
    id?: number;
    color?: string;
    serviceName?: string;
    authorName?: string;
    authorLink?: string;
    title?: string;
    text?: string;
    fallback?: string;
    link?: string;
    imageLink?: string;
    thumbnailLink?: string;
    footer?: string;
    timestamp?: number;
  }>;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLACK_TS_RE = /^\d{10}(?:\.\d{1,6})?$/;
const METADATA_TTL_MS = 5 * 60_000;
const userListCache = new Map<
  string,
  { fetchedAt: number; users: SlackUser[] }
>();
const userInfoCache = new Map<string, { fetchedAt: number; user: SlackUser }>();
const conversationCache = new Map<
  string,
  { fetchedAt: number; conversations: SlackConversation[] }
>();
const userGroupCache = new Map<
  string,
  { fetchedAt: number; groups: SlackUserGroup[] }
>();
const detailProperty = {
  type: "string",
  enum: ["compact", "standard", "full"],
  description:
    "Output detail. compact is the bounded default; standard/full retain progressively more normalized message metadata.",
} as const;
const limitProperty = {
  type: "number",
  description:
    "Maximum messages to return. Defaults to configured Slack limit, maximum 100.",
} as const;

export const slackSearchTool = defineAgentTool<{
  query: string;
  maxResults?: number;
  detailLevel?: DetailLevel;
  expandThreads?: boolean;
  maxThreadMessages?: number;
  nearbyMessages?: number;
}>({
  name: "slack_search",
  label: "Slack: Search",
  description:
    "Search accessible Slack messages using the connected personal Slack account, with optional bounded thread and nearby-channel expansion. Cite hits with their real permalinks; only content the connected account can see is searchable.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description:
          "Slack search syntax query, e.g. 'to:me after:2026-06-01' or '\"OPS-73\" in:product'.",
      },
      maxResults: limitProperty,
      detailLevel: detailProperty,
      expandThreads: {
        type: "boolean",
        description:
          "Fetch the complete bounded thread for each match. Defaults to false.",
      },
      maxThreadMessages: {
        type: "number",
        description:
          "Maximum messages per expanded thread. Defaults to 25, maximum 100.",
      },
      nearbyMessages: {
        type: "number",
        description:
          "Number of preceding channel messages to attach to each match. Defaults to 0, maximum 20.",
      },
    },
  } as const,
  async execute(params, ctx) {
    const config = getSlackPublicApiConfig();
    const query = params.query?.trim();
    if (!query) throw new Error("query is required.");
    const maxResults = limit(params.maxResults, config);
    const detail = normalizeDetail(params.detailLevel);
    const response = await slackApi(
      "search.messages",
      {
        query,
        count: maxResults,
        page: 1,
        sort: "timestamp",
        sort_dir: "desc",
      },
      config,
      ctx,
    );
    const raw = ((response.messages?.matches ?? []) as SlackMessage[]).slice(
      0,
      maxResults,
    );
    const matches = [];
    for (const message of raw) {
      const channelId = message.channel?.id;
      const normalized = await normalizeMessage(
        message,
        config,
        {
          ...(channelId !== undefined ? { channelId } : {}),
          ...(message.channel?.name !== undefined
            ? { channelName: message.channel?.name }
            : {}),
        },
        ctx,
      );
      const threadTs =
        message.thread_ts || (message.reply_count ? message.ts : undefined);
      const thread =
        params.expandThreads && channelId && threadTs
          ? await readThread(
              channelId,
              threadTs,
              clamp(params.maxThreadMessages ?? 25, 1, 100),
              config,
              ctx,
            )
          : undefined;
      const nearby =
        channelId && message.ts && (params.nearbyMessages ?? 0) > 0
          ? await readNearby(
              channelId,
              message.ts,
              clamp(params.nearbyMessages ?? 0, 0, 20),
              config,
              ctx,
            )
          : undefined;
      matches.push({
        message: forDetail(normalized, detail),
        ...(thread
          ? { thread: thread.map((item) => forDetail(item, detail)) }
          : {}),
        ...(nearby
          ? { nearby: nearby.map((item) => forDetail(item, detail)) }
          : {}),
      });
    }
    return result({
      capability: "search",
      identity: identity(config),
      query,
      total: response.messages?.total ?? matches.length,
      returned: matches.length,
      detailLevel: detail,
      matches,
    });
  },
});

export const slackConversationReadTool = defineAgentTool<{
  conversation: string;
  date?: string;
  oldest?: string;
  latest?: string;
  includeThreads?: boolean;
  maxThreadMessages?: number;
  maxResults?: number;
  detailLevel?: DetailLevel;
}>({
  name: "slack_conversation_read",
  label: "Slack: Read conversation",
  description:
    "Read latest or time-bounded messages from one accessible Slack channel, private channel, DM, or group DM. Once a discussion exposes a thread timestamp, follow it with slack_thread_read instead of widening this read.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["conversation"],
    properties: {
      conversation: {
        type: "string",
        description:
          "Conversation id or channel name, e.g. C123, D123, #product, or product.",
      },
      date: {
        type: "string",
        description: "User-local day in YYYY-MM-DD form.",
      },
      oldest: {
        type: "string",
        description:
          "Lower timestamp bound as Slack timestamp, epoch seconds, or RFC3339.",
      },
      latest: {
        type: "string",
        description:
          "Upper timestamp bound as Slack timestamp, epoch seconds, or RFC3339.",
      },
      includeThreads: {
        type: "boolean",
        description:
          "Include bounded replies for thread roots. Defaults to false.",
      },
      maxThreadMessages: {
        type: "number",
        description:
          "Maximum messages per included thread. Defaults to 25, maximum 100.",
      },
      maxResults: limitProperty,
      detailLevel: detailProperty,
    },
  } as const,
  async execute(params, ctx) {
    const config = getSlackPublicApiConfig();
    const conversation = await resolveConversation(
      params.conversation,
      config,
      ctx,
    );
    const maxResults = limit(params.maxResults, config);
    const detail = normalizeDetail(params.detailLevel);
    const range = historyRange(params, config.timezone);
    const raw = await fetchPages(
      "conversations.history",
      {
        channel: conversation.id,
        inclusive: true,
        limit: Math.min(maxResults, 100),
        ...(range ?? {}),
      },
      "messages",
      maxResults,
      config,
      ctx,
    );
    const messages = [];
    for (const item of raw as SlackMessage[]) {
      const message = await normalizeMessage(
        item,
        config,
        {
          channelId: conversation.id,
          ...(conversation.name !== undefined
            ? { channelName: conversation.name }
            : {}),
        },
        ctx,
      );
      const thread =
        params.includeThreads && item.ts && item.reply_count
          ? await readThread(
              conversation.id,
              item.ts,
              clamp(params.maxThreadMessages ?? 25, 1, 100),
              config,
              ctx,
            )
          : undefined;
      messages.push({
        ...forDetail(message, detail),
        ...(thread
          ? {
              replies: thread.slice(1).map((reply) => forDetail(reply, detail)),
            }
          : {}),
      });
    }
    return result({
      capability: "conversation_read",
      identity: identity(config),
      conversation,
      range: range ?? null,
      returned: messages.length,
      detailLevel: detail,
      messages,
    });
  },
});

export const slackThreadReadTool = defineAgentTool<{
  conversation: string;
  threadTs: string;
  maxResults?: number;
  detailLevel?: DetailLevel;
}>({
  name: "slack_thread_read",
  label: "Slack: Read thread",
  description:
    "Read a complete bounded Slack thread from its ROOT timestamp — Slack's documented Web API cannot resolve an arbitrary reply timestamp back to its root.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["conversation", "threadTs"],
    properties: {
      conversation: { type: "string", description: "Conversation id or name." },
      threadTs: {
        type: "string",
        description: "Thread root timestamp from a search/conversation result.",
      },
      maxResults: limitProperty,
      detailLevel: detailProperty,
    },
  } as const,
  async execute(params, ctx) {
    const config = getSlackPublicApiConfig();
    const conversation = await resolveConversation(
      params.conversation,
      config,
      ctx,
    );
    const threadTs = requireSlackTs(params.threadTs, "threadTs");
    const detail = normalizeDetail(params.detailLevel);
    const messages = await readThread(
      conversation.id,
      threadTs,
      limit(params.maxResults, config),
      config,
      ctx,
    );
    return result({
      capability: "thread_read",
      identity: identity(config),
      conversation,
      threadTs,
      returned: messages.length,
      detailLevel: detail,
      messages: messages.map((message) => forDetail(message, detail)),
    });
  },
});

export const slackUnreadTool = defineAgentTool<{
  conversation?: string;
  person?: string;
  maxConversations?: number;
  maxResults?: number;
  maxPerConversation?: number;
  includeThreads?: boolean;
  maxThreadMessages?: number;
  detailLevel?: DetailLevel;
}>({
  name: "slack_unread",
  label: "Slack: Read personal unread messages",
  description:
    "Aggregate personal unread messages across accessible public/private channels, DMs, and group DMs using Slack's user-specific last-read markers. Conversations listed in uncertainConversations are unknown, never zero unread. Thread coverage is best-effort: Slack exposes no global personal thread-read marker, so only replies under visible unread roots are expanded.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      conversation: {
        type: "string",
        description:
          "Optional conversation id/name filter (exact id or case-insensitive label substring).",
      },
      person: {
        type: "string",
        description:
          "Optional user id or case-insensitive display/real-name filter for DMs and group DMs.",
      },
      maxConversations: {
        type: "number",
        description:
          "Maximum conversations to inspect/return. Defaults to 20, maximum 50.",
      },
      maxResults: limitProperty,
      maxPerConversation: {
        type: "number",
        description:
          "Maximum unread messages per conversation. Defaults to 20, maximum 100.",
      },
      includeThreads: {
        type: "boolean",
        description:
          "Expand replies on unread thread roots. Best-effort; defaults to false.",
      },
      maxThreadMessages: {
        type: "number",
        description:
          "Maximum replies per expanded unread root. Defaults to 25, maximum 100.",
      },
      detailLevel: detailProperty,
    },
  } as const,
  async execute(params, ctx) {
    const config = getSlackPublicApiConfig();
    const detail = normalizeDetail(params.detailLevel);
    const maxResults = limit(params.maxResults, config);
    const maxConversations = clamp(params.maxConversations ?? 20, 1, 50);
    const maxPerConversation = clamp(params.maxPerConversation ?? 20, 1, 100);
    const person = params.person
      ? await resolvePerson(params.person, config, ctx)
      : undefined;
    const listed = await listConversations(config, ctx, true);
    const conversationFilter = params.conversation
      ?.trim()
      .replace(/^#/, "")
      .toLowerCase();
    const prioritized = listed
      .filter((raw) => {
        if (
          conversationFilter &&
          raw.id?.toLowerCase() !== conversationFilter &&
          !raw.name?.toLowerCase().includes(conversationFilter) &&
          !raw.is_im &&
          !raw.is_mpim
        )
          return false;
        if (person && raw.is_im && raw.user !== person.id) return false;
        if (
          person &&
          raw.is_mpim &&
          raw.members?.length &&
          !raw.members.includes(person.id)
        )
          return false;
        return true;
      })
      .sort((a, b) => unreadPriority(b) - unreadPriority(a));
    const inspected = prioritized.slice(0, maxConversations);
    const labeled = [];
    for (const item of inspected)
      labeled.push(await describeConversation(item, config, ctx));
    const candidates = labeled.filter(({ id, name, raw, participantIds }) => {
      if (
        conversationFilter &&
        id.toLowerCase() !== conversationFilter &&
        !name.toLowerCase().includes(conversationFilter) &&
        !raw.name?.toLowerCase().includes(conversationFilter)
      )
        return false;
      if (person && !participantIds.includes(person.id)) return false;
      return true;
    });

    const conversations = [];
    const uncertainConversations = [];
    let remaining = maxResults;
    for (const candidate of candidates) {
      if (!candidate.raw.last_read) {
        uncertainConversations.push({
          ...candidate.public,
          reason: "missing_last_read_marker",
          unreadCount: candidate.raw.unread_count ?? null,
        });
        continue;
      }
      if (
        (candidate.raw.unread_count ?? candidate.raw.unread_count_display) === 0
      )
        continue;
      if (remaining <= 0) break;
      const messageLimit = Math.min(maxPerConversation, remaining);
      const raw = (await fetchPages(
        "conversations.history",
        {
          channel: candidate.id,
          oldest: candidate.raw.last_read,
          inclusive: false,
          limit: Math.min(messageLimit, 100),
        },
        "messages",
        messageLimit,
        config,
        ctx,
      )) as SlackMessage[];
      const messages = [];
      let returnedForConversation = 0;
      let conversationRemaining = maxPerConversation;
      for (const item of raw) {
        if (remaining <= 0 || conversationRemaining <= 0) break;
        const message = await normalizeMessage(
          item,
          config,
          { channelId: candidate.id, channelName: candidate.name },
          ctx,
        );
        remaining--;
        conversationRemaining--;
        returnedForConversation++;
        let replies: NormalizedMessage[] | undefined;
        if (
          params.includeThreads &&
          item.ts &&
          item.reply_count &&
          remaining > 0 &&
          conversationRemaining > 0
        ) {
          const replyBudget = Math.min(remaining, conversationRemaining);
          const threadBudget =
            clamp(params.maxThreadMessages ?? 25, 1, 100) + 1;
          replies = (
            await readThread(candidate.id, item.ts, threadBudget, config, ctx)
          )
            .slice(1)
            .filter(
              (reply) => compareSlackTs(reply.ts, candidate.raw.last_read!) > 0,
            )
            .slice(0, replyBudget);
          remaining -= replies.length;
          conversationRemaining -= replies.length;
          returnedForConversation += replies.length;
        }
        messages.push({
          ...forDetail(message, detail),
          ...(replies?.length
            ? {
                unreadReplies: replies.map((reply) => forDetail(reply, detail)),
              }
            : {}),
        });
      }
      if (
        !messages.length &&
        (candidate.raw.unread_count ??
          candidate.raw.unread_count_display ??
          0) <= 0
      )
        continue;
      conversations.push({
        ...candidate.public,
        lastRead: candidate.raw.last_read,
        localLastRead: formatSlackTs(candidate.raw.last_read, config.timezone),
        unreadCount: candidate.raw.unread_count ?? null,
        unreadCountDisplay: candidate.raw.unread_count_display ?? null,
        returned: returnedForConversation,
        messages,
      });
    }
    return result({
      capability: "unread",
      identity: identity(config),
      filters: {
        conversation: params.conversation ?? null,
        person: person ? { id: person.id, name: person.name } : null,
      },
      scannedConversations: inspected.length,
      matchedConversations: candidates.length,
      returnedConversations: conversations.length,
      returned: maxResults - remaining,
      detailLevel: detail,
      conversations,
      uncertainConversations,
      completeness: {
        conversationEnumeration:
          prioritized.length > inspected.length
            ? "bounded"
            : "complete_for_filters",
        threadReplies: params.includeThreads
          ? "best_effort_for_visible_unread_roots"
          : "not_requested",
        limitation:
          "Slack's documented Web API does not expose a global personal thread-read marker; replies on older roots may be absent.",
      },
    });
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

/** Test/reconnect seam: metadata is otherwise workspace/token scoped and expires after five minutes. */
export function clearSlackMetadataCaches() {
  userListCache.clear();
  userInfoCache.clear();
  conversationCache.clear();
  userGroupCache.clear();
}

function result(payload: Record<string, unknown>) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    details: payload,
  };
}
function identity(config: SlackPublicApiConfig) {
  return {
    provider: "slack",
    credential: "personal_user_oauth",
    teamId: config.teamId,
    workspaceHost: config.workspaceHost,
    source: config.source,
  };
}
function limit(value: number | undefined, config: SlackPublicApiConfig) {
  return clamp(value ?? config.defaultMaxResults ?? 20, 1, 100);
}
function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(Number(value) || min)));
}
function normalizeDetail(value?: DetailLevel): DetailLevel {
  return value === "standard" || value === "full" ? value : "compact";
}
function compactObject(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}
function truncate(value: string, max: number) {
  return value.length <= max
    ? value
    : `${value.slice(0, Math.max(0, max - 1))}…`;
}
function forDetail(
  message: NormalizedMessage,
  detail: DetailLevel,
): Record<string, unknown> {
  if (detail === "full") return message as unknown as Record<string, unknown>;
  const common = compactObject({
    ts: message.ts,
    localTime: message.localTime,
    channelId: message.channelId,
    channelName: message.channelName,
    userId: message.userId,
    userName: message.userName,
    botId: message.botId,
    subtype: message.subtype,
    text: truncate(message.text, detail === "compact" ? 500 : 4000),
    references: message.references,
    threadTs: message.threadTs,
    isThreadReply: message.isThreadReply,
    replyCount: message.replyCount,
    latestReply: message.latestReply,
    permalink: message.permalink,
    files: message.files,
    blocks: message.blocks,
    attachments: message.attachments,
  });
  return common;
}

class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack API ${method} failed: ${code}`);
  }
}
class SlackPersonNotFoundError extends Error {}

async function slackApi(
  method: string,
  params: Record<string, unknown>,
  config: SlackPublicApiConfig,
  ctx: ToolCallContext,
): Promise<SlackApiResponse> {
  if (ctx.signal?.aborted) throw new Error("Slack request aborted.");
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== null && value !== "")
      body.set(key, String(value));
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": "personal-assistant-slack/1.0",
    },
    body,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  const text = await response.text();
  if (response.status === 429)
    throw new Error(
      `Slack rate limited ${method}; retry after ${response.headers.get("retry-after") ?? "unknown"} seconds.`,
    );
  if (!response.ok)
    throw new Error(
      `Slack HTTP ${response.status} for ${method}: ${truncate(text, 500)}`,
    );
  let json: SlackApiResponse;
  try {
    json = JSON.parse(text) as SlackApiResponse;
  } catch {
    throw new Error(`Slack returned invalid JSON for ${method}.`);
  }
  if (!json.ok)
    throw new SlackApiError(method, String(json.error ?? "unknown_error"));
  return json;
}

async function fetchPages(
  method: string,
  params: Record<string, unknown>,
  itemPath: string,
  max: number,
  config: SlackPublicApiConfig,
  ctx: ToolCallContext,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor = "";
  const seenCursors = new Set<string>();
  for (
    let pageNumber = 0;
    pageNumber < 100 && items.length < max;
    pageNumber++
  ) {
    const response = await slackApi(
      method,
      { ...params, cursor: cursor || undefined },
      config,
      ctx,
    );
    const page = response[itemPath];
    if (Array.isArray(page)) items.push(...page.slice(0, max - items.length));
    const nextCursor = response.response_metadata?.next_cursor?.trim() ?? "";
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return items;
}

async function listConversations(
  config: SlackPublicApiConfig,
  ctx: ToolCallContext,
  forceRefresh = false,
): Promise<SlackConversation[]> {
  const key = cacheKey(config);
  const cached = conversationCache.get(key);
  if (
    !forceRefresh &&
    cached &&
    Date.now() - cached.fetchedAt < METADATA_TTL_MS
  )
    return cached.conversations;
  const conversations = (await fetchPages(
    "conversations.list",
    {
      types: "public_channel,private_channel,mpim,im",
      exclude_archived: true,
      limit: 200,
    },
    "channels",
    5000,
    config,
    ctx,
  )) as SlackConversation[];
  conversationCache.set(key, { fetchedAt: Date.now(), conversations });
  return conversations;
}
async function resolvePerson(
  input: string,
  config: SlackPublicApiConfig,
  ctx: ToolCallContext,
): Promise<{ id: string; name: string; username?: string; deleted?: boolean }> {
  const clean = input.trim().replace(/^@/, "");
  if (!clean) throw new Error("person must not be empty.");
  if (/^U[A-Z0-9]+$/i.test(clean)) {
    const user = await getUser(clean, config, ctx);
    return {
      id: clean,
      name: displayName(user),
      ...(user.name !== undefined ? { username: user.name } : {}),
      ...(user.deleted !== undefined ? { deleted: user.deleted } : {}),
    };
  }
  const users = await listUsers(config, ctx);
  const needle = normalizeName(clean);
  const allowEmail =
    config.grantedUserScopes?.includes("users:read.email") ?? false;
  const matches = users.filter((user) => {
    const names = [
      user.name,
      user.real_name,
      user.profile?.display_name,
      user.profile?.real_name,
    ];
    if (allowEmail) names.push(user.profile?.email);
    return names.some((name) => name && normalizeName(name) === needle);
  });
  const active = matches.filter((user) => !user.deleted && user.id);
  if (active.length !== 1) {
    const candidates = matches
      .filter((user) => user.id)
      .slice(0, 10)
      .map(
        (user) =>
          `${displayName(user)} (${user.id}${user.deleted ? ", deleted" : ""})`,
      );
    if (active.length > 1)
      throw new Error(
        `Slack person '${input}' is ambiguous. Candidates: ${candidates.join(", ")}. Use a user id.`,
      );
    if (matches.length)
      throw new Error(
        `Slack person '${input}' only matched deleted users: ${candidates.join(", ")}.`,
      );
    throw new SlackPersonNotFoundError(
      `Could not resolve Slack person '${input}'.`,
    );
  }
  const user = active[0]!;
  return {
    id: user.id!,
    name: displayName(user),
    ...(user.name !== undefined ? { username: user.name } : {}),
  };
}
async function describeConversation(
  raw: SlackConversation,
  config: SlackPublicApiConfig,
  ctx: ToolCallContext,
) {
  if (!raw.id) throw new Error("Slack returned a conversation without an id.");
  let participantIds = raw.members ?? (raw.user ? [raw.user] : []);
  if (raw.is_mpim && !participantIds.length)
    participantIds = (await fetchPages(
      "conversations.members",
      { channel: raw.id, limit: 200 },
      "members",
      200,
      config,
      ctx,
    )) as string[];
  const participantNames =
    raw.is_im || raw.is_mpim
      ? await Promise.all(
          participantIds.map((id) => getUserName(id, config, ctx)),
        )
      : [];
  const kind = raw.is_im
    ? "im"
    : raw.is_mpim
      ? "mpim"
      : raw.is_private
        ? "private_channel"
        : "public_channel";
  const name = raw.is_mpim
    ? participantNames.join(", ") || raw.name || raw.id
    : raw.name || (raw.is_im ? participantNames[0] : undefined) || raw.id;
  return {
    raw,
    id: raw.id,
    name,
    participantIds,
    public: {
      id: raw.id,
      name,
      ...(raw.is_mpim && raw.name ? { slackName: raw.name } : {}),
      kind,
      participantIds,
      participantNames,
    },
  };
}
function unreadPriority(conversation: SlackConversation) {
  const unread =
    conversation.unread_count_display ??
    conversation.unread_count ??
    (conversation.last_read ? 0 : -1);
  const latest =
    typeof conversation.latest === "string"
      ? conversation.latest
      : conversation.latest?.ts;
  return (
    unread * 1e15 + (Number(latest) || Number(conversation.last_read) || 0)
  );
}
function compareSlackTs(left: string, right: string) {
  const normalize = (value: string) => {
    const [seconds = "0", fraction = ""] = value.split(".");
    return `${seconds.padStart(10, "0")}.${fraction.padEnd(6, "0").slice(0, 6)}`;
  };
  return normalize(left).localeCompare(normalize(right));
}
async function resolveConversation(
  input: string,
  config: SlackPublicApiConfig,
  ctx: ToolCallContext,
): Promise<{
  input: string;
  id: string;
  name?: string;
  kind?: string;
  participantIds?: string[];
  participantNames?: string[];
}> {
  const clean = input?.trim().replace(/^[#@]/, "");
  if (!clean) throw new Error("conversation is required.");
  if (/^[CDG][A-Z0-9]+$/i.test(clean)) return { input, id: clean };
  const conversations = await listConversations(config, ctx);
  const needle = normalizeName(clean);
  const named = conversations.filter(
    (item) => item.id && item.name && normalizeName(item.name) === needle,
  );
  const candidates = [...named];
  if (!named.length)
    try {
      const person = await resolvePerson(clean, config, ctx);
      candidates.push(
        ...conversations.filter(
          (item) => item.id && item.is_im && item.user === person.id,
        ),
      );
    } catch (error) {
      if (!(error instanceof SlackPersonNotFoundError)) throw error;
    }
  if (!candidates.length) {
    for (const item of conversations
      .filter((conversation) => conversation.is_mpim)
      .slice(0, 50)) {
      const described = await describeConversation(item, config, ctx);
      if (normalizeName(described.name) === needle) candidates.push(item);
    }
  }
  const unique = [
    ...new Map(candidates.map((item) => [item.id, item])).values(),
  ];
  if (unique.length > 1)
    throw new Error(
      `Slack conversation '${input}' is ambiguous. Candidates: ${unique
        .slice(0, 10)
        .map((item) => `${item.name || item.id} (${item.id})`)
        .join(", ")}. Use a conversation id.`,
    );
  if (!unique[0]?.id)
    throw new Error(
      `Could not resolve Slack conversation '${input}'. Use a channel/DM id, accessible channel name, or an unambiguous person name.`,
    );
  const described = await describeConversation(unique[0], config, ctx);
  return { input, ...described.public };
}
function cacheKey(config: SlackPublicApiConfig) {
  return `${config.teamId}:${config.token.slice(-12)}`;
}
function normalizeName(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}
function displayName(user: SlackUser) {
  return (
    user.profile?.display_name ||
    user.profile?.real_name ||
    user.real_name ||
    user.name ||
    user.id ||
    "Unknown user"
  );
}
async function listUsers(
  config: SlackPublicApiConfig,
  ctx: ToolCallContext,
): Promise<SlackUser[]> {
  const key = cacheKey(config);
  const cached = userListCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < METADATA_TTL_MS)
    return cached.users;
  const users = (await fetchPages(
    "users.list",
    { limit: 200 },
    "members",
    5000,
    config,
    ctx,
  )) as SlackUser[];
  userListCache.set(key, { fetchedAt: Date.now(), users });
  for (const user of users)
    if (user.id)
      userInfoCache.set(`${key}:${user.id}`, { fetchedAt: Date.now(), user });
  return users;
}
async function getUser(
  userId: string,
  config: SlackPublicApiConfig,
  ctx: ToolCallContext,
): Promise<SlackUser> {
  const key = `${cacheKey(config)}:${userId}`;
  const cached = userInfoCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < METADATA_TTL_MS)
    return cached.user;
  try {
    const user = ((await slackApi("users.info", { user: userId }, config, ctx))
      .user ?? { id: userId }) as SlackUser;
    userInfoCache.set(key, { fetchedAt: Date.now(), user });
    return user;
  } catch (error) {
    if (error instanceof SlackApiError && error.code === "user_not_found")
      return { id: userId, deleted: true };
    throw error;
  }
}
async function getUserName(
  userId: string,
  config: SlackPublicApiConfig,
  ctx: ToolCallContext,
): Promise<string> {
  const user = await getUser(userId, config, ctx);
  return user.deleted ? `Deleted user (${userId})` : displayName(user);
}
async function listUserGroups(
  config: SlackPublicApiConfig,
  ctx: ToolCallContext,
): Promise<SlackUserGroup[]> {
  const key = cacheKey(config);
  const cached = userGroupCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < METADATA_TTL_MS)
    return cached.groups;
  try {
    const groups = ((
      await slackApi("usergroups.list", { include_users: false }, config, ctx)
    ).usergroups ?? []) as SlackUserGroup[];
    userGroupCache.set(key, { fetchedAt: Date.now(), groups });
    return groups;
  } catch (error) {
    if (
      error instanceof SlackApiError &&
      ["missing_scope", "no_permission"].includes(error.code)
    ) {
      userGroupCache.set(key, { fetchedAt: Date.now(), groups: [] });
      return [];
    }
    throw error;
  }
}
async function normalizeMessage(
  message: SlackMessage,
  config: SlackPublicApiConfig,
  context: { channelId?: string; channelName?: string },
  ctx: ToolCallContext,
): Promise<NormalizedMessage> {
  const ts = message.ts ?? "";
  const channelId = context.channelId ?? message.channel?.id;
  const rawText = message.text ?? "";
  const resolved = await resolveSlackMarkup(rawText, config, ctx);
  return compactObject({
    ts,
    localTime: formatSlackTs(ts, config.timezone),
    channelId,
    channelName: context.channelName ?? message.channel?.name,
    userId: message.user,
    userName: message.user
      ? await getUserName(message.user, config, ctx)
      : message.username,
    botId: message.bot_id,
    subtype: message.subtype,
    text: resolved.text,
    rawText,
    references: resolved.references.length ? resolved.references : undefined,
    threadTs: message.thread_ts,
    isThreadReply: Boolean(message.thread_ts && message.thread_ts !== ts),
    replyCount: message.reply_count,
    latestReply: message.latest_reply,
    permalink: message.permalink ?? buildPermalink(config, channelId, ts),
    reactions: message.reactions?.map((item) => ({
      name: item.name ?? "",
      count: item.count ?? 0,
    })),
    files: message.files?.map((file) => publicFile(file.id ?? "", file)),
    blocks: normalizeBlocks(message.blocks),
    attachments: message.attachments?.map((item) =>
      compactObject({
        id: item.id,
        color: item.color,
        serviceName: item.service_name,
        authorName: item.author_name,
        authorLink: safePublicLink(item.author_link),
        title: item.title,
        text: item.text ? stripSlackMarkup(item.text) : undefined,
        fallback: item.fallback ? stripSlackMarkup(item.fallback) : undefined,
        link: safePublicLink(item.title_link ?? item.from_url),
        imageLink: safePublicLink(item.image_url),
        thumbnailLink: safePublicLink(item.thumb_url),
        footer: item.footer,
        timestamp: item.ts,
      }),
    ),
  }) as NormalizedMessage;
}
async function resolveSlackMarkup(
  text: string,
  config: SlackPublicApiConfig,
  ctx: ToolCallContext,
): Promise<{ text: string; references: SlackReference[] }> {
  let resolved = text;
  const references: SlackReference[] = [];
  const referenceBudget = 50;
  const allUserIds = [
    ...new Set(
      [...text.matchAll(/<@(U[A-Z0-9]+)>/gi)].map((match) => match[1]!),
    ),
  ];
  const userIds = allUserIds.slice(0, referenceBudget);
  const allChannelIds = [
    ...new Set(
      [...text.matchAll(/<#([CDG][A-Z0-9]+)(?:\|[^>]+)?>/gi)].map(
        (match) => match[1]!,
      ),
    ),
  ];
  const channelIds = allChannelIds.slice(
    0,
    Math.max(0, referenceBudget - userIds.length),
  );
  const allGroupIds = [
    ...new Set(
      [...text.matchAll(/<!subteam\^([A-Z0-9]+)(?:\|[^>]+)?>/gi)].map(
        (match) => match[1]!,
      ),
    ),
  ];
  const groupIds = allGroupIds.slice(
    0,
    Math.max(0, referenceBudget - userIds.length - channelIds.length),
  );
  const includedUsers = new Set(userIds);
  const includedChannels = new Set(channelIds);
  const includedGroups = new Set(groupIds);
  const users = new Map(
    await Promise.all(
      userIds.map(
        async (id) => [id, await getUserName(id, config, ctx)] as const,
      ),
    ),
  );
  const conversations = channelIds.length
    ? await listConversations(config, ctx)
    : [];
  const groups = groupIds.length ? await listUserGroups(config, ctx) : [];
  resolved = resolved.replace(/<@(U[A-Z0-9]+)>/gi, (_all, id: string) => {
    const label = users.get(id) ?? `Unknown user (${id})`;
    if (includedUsers.has(id)) references.push({ type: "user", id, label });
    return `@${label}`;
  });
  resolved = resolved.replace(
    /<#([CDG][A-Z0-9]+)(?:\|([^>]+))?>/gi,
    (_all, id: string, fallback?: string) => {
      const label =
        conversations.find((item) => item.id === id)?.name ||
        fallback ||
        `Unknown channel (${id})`;
      if (includedChannels.has(id))
        references.push({ type: "channel", id, label });
      return `#${label}`;
    },
  );
  resolved = resolved.replace(
    /<!subteam\^([A-Z0-9]+)(?:\|@?([^>]+))?>/gi,
    (_all, id: string, fallback?: string) => {
      const group = groups.find((item) => item.id === id);
      const label =
        group?.handle ||
        group?.name ||
        fallback ||
        `Unknown user group (${id})`;
      if (includedGroups.has(id))
        references.push({ type: "user_group", id, label });
      return `@${label}`;
    },
  );
  return {
    text: stripSlackMarkup(resolved),
    references: [
      ...new Map(
        references.map((reference) => [
          `${reference.type}:${reference.id}`,
          reference,
        ]),
      ).values(),
    ].slice(0, 50),
  };
}
async function readThread(
  channelId: string,
  threadTs: string,
  max: number,
  config: SlackPublicApiConfig,
  ctx: ToolCallContext,
) {
  const raw = (await fetchPages(
    "conversations.replies",
    {
      channel: channelId,
      ts: threadTs,
      inclusive: true,
      limit: Math.min(max, 100),
    },
    "messages",
    max,
    config,
    ctx,
  )) as SlackMessage[];
  return Promise.all(
    raw.map((message) => normalizeMessage(message, config, { channelId }, ctx)),
  );
}
async function readNearby(
  channelId: string,
  timestamp: string,
  max: number,
  config: SlackPublicApiConfig,
  ctx: ToolCallContext,
) {
  const raw = (await fetchPages(
    "conversations.history",
    { channel: channelId, latest: timestamp, inclusive: false, limit: max },
    "messages",
    max,
    config,
    ctx,
  )) as SlackMessage[];
  return Promise.all(
    raw.map((message) => normalizeMessage(message, config, { channelId }, ctx)),
  );
}
function requireSlackTs(value: string, field: string) {
  const clean = value?.trim();
  if (!SLACK_TS_RE.test(clean))
    throw new Error(
      `${field} must be a Slack timestamp such as 1717426730.123456.`,
    );
  return clean;
}
function historyRange(
  params: { date?: string; oldest?: string; latest?: string },
  timezone: string,
): { oldest?: string; latest?: string } | null {
  if (params.date) {
    if (!ISO_DATE_RE.test(params.date))
      throw new Error("date must be YYYY-MM-DD.");
    const { startMs, endMs } = localDayBoundsMs(params.date, timezone);
    return { oldest: String(startMs / 1000), latest: String(endMs / 1000) };
  }
  const oldest = parseTime(params.oldest);
  const latest = parseTime(params.latest);
  return oldest || latest
    ? { ...(oldest ? { oldest } : {}), ...(latest ? { latest } : {}) }
    : null;
}
function parseTime(value?: string) {
  if (!value) return undefined;
  if (SLACK_TS_RE.test(value)) return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed))
    throw new Error(`Invalid Slack/RFC3339 timestamp: ${value}`);
  return String(parsed / 1000);
}
function formatSlackTs(ts: string, timezone: string) {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(seconds * 1000));
}
function stripSlackMarkup(text: string) {
  return text
    .replace(/<([^>|]+)\|([^>]+)>/g, "$2")
    .replace(/<@([A-Z0-9]+)>/g, "@$1")
    .replace(/<([^>]+)>/g, "$1");
}
function buildPermalink(
  config: SlackPublicApiConfig,
  channelId?: string,
  ts?: string,
) {
  if (!config.workspaceHost || !channelId || !ts) return undefined;
  return `https://${config.workspaceHost}/archives/${channelId}/p${ts.replace(".", "")}`;
}
function publicFile(id: string, file: SlackFile) {
  return compactObject({
    id: id || file.id,
    name: file.name,
    title: file.title,
    mimetype: file.mimetype,
    filetype: file.filetype,
    size: file.size,
    permalink: safePublicLink(file.permalink),
    mode: file.mode,
    isExternal: file.is_external,
    externalType: file.external_type,
  });
}
function safePublicLink(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      isSlackPrivateDownloadHost(url.hostname)
    )
      return undefined;
    const sensitiveQuery = [...url.searchParams.keys()].some((key) =>
      /(?:^|[-_])(sig(?:nature)?|token|key|credential|expires?|x-amz)(?:$|[-_])/i.test(
        key,
      ),
    );
    return sensitiveQuery ? undefined : url.toString();
  } catch {
    return undefined;
  }
}
function normalizeBlocks(
  blocks: SlackMessage["blocks"],
): NormalizedMessage["blocks"] {
  return blocks?.slice(0, 50).map((block) =>
    compactObject({
      type: block.type,
      blockId: block.block_id,
      links: collectBlockLinks(block).slice(0, 20),
    }),
  ) as NormalizedMessage["blocks"];
}
function collectBlockLinks(
  value: unknown,
  found: Array<{ url: string; label?: string }> = [],
  depth = 0,
): Array<{ url: string; label?: string }> {
  if (
    depth > 8 ||
    found.length >= 20 ||
    value === null ||
    typeof value !== "object"
  )
    return found;
  if (Array.isArray(value)) {
    for (const item of value) collectBlockLinks(item, found, depth + 1);
    return found;
  }
  const object = value as Record<string, unknown>;
  const url =
    typeof object.url === "string" ? safePublicLink(object.url) : undefined;
  if (url)
    found.push(
      compactObject({
        url,
        label:
          typeof object.text === "string"
            ? truncate(stripSlackMarkup(object.text), 200)
            : undefined,
      }) as { url: string; label?: string },
    );
  for (const [key, item] of Object.entries(object))
    if (key !== "url") collectBlockLinks(item, found, depth + 1);
  return found;
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
