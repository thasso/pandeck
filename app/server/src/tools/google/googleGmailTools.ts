import { inflateRawSync } from "node:zlib";
import { defineAgentTool } from "../../mcp/tool.ts";
import {
  ensureGoogleAccessToken,
  getGoogleToolConfig,
} from "../../googleSettings.ts";
import { formatLocalDateTime } from "../../googleTime.ts";

type GmailReadMode = "search" | "thread" | "message";

type GmailReadParams = {
  mode: GmailReadMode;
  query?: string;
  threadId?: string;
  messageId?: string;
  labelIds?: string[];
  includeSpamTrash?: boolean;
  maxResults?: number;
  maxChars?: number;
  render?: boolean;
};

type GmailListThreadsPage = {
  threads?: Array<{ id?: string; snippet?: string; historyId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

type GmailLabel = {
  id?: string;
  name?: string;
  type?: "system" | "user";
};

type GmailLabelsResponse = { labels?: GmailLabel[] };

type GmailMessagePartBody = {
  attachmentId?: string;
  size?: number;
  data?: string;
};
type GmailAttachmentResponse = { data?: string; size?: number };

type GmailMessagePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
};

type GmailMessage = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailMessagePart;
};

type GmailThread = {
  id?: string;
  historyId?: string;
  snippet?: string;
  messages?: GmailMessage[];
};

type NormalizedGmailMessageSummary = {
  id: string | null;
  threadId: string | null;
  date: string | null;
  localDate: string | null;
  from: string | null;
  fromName: string | null;
  fromEmail: string | null;
  to: string | null;
  subject: string;
  snippet: string;
  unread: boolean;
  labels: string[];
  labelIds: string[];
  gmailUrl: string | null;
};

type NormalizedGmailThreadSummary = {
  id: string;
  gmailUrl: string;
  subject: string;
  snippet: string;
  unread: boolean;
  inbox: boolean;
  starred: boolean;
  important: boolean;
  messageCount: number;
  firstDate: string | null;
  latestDate: string | null;
  localFirstDate: string | null;
  localLatestDate: string | null;
  latestFrom: string | null;
  participants: Array<{
    name: string | null;
    email: string | null;
    label: string;
  }>;
  labels: string[];
  labelIds: string[];
  messages: NormalizedGmailMessageSummary[];
};

type NormalizedGmailMessageFull = NormalizedGmailMessageSummary & {
  text: string;
  textCharCount: number;
  truncated: boolean;
  attachments: Array<{
    filename: string;
    mimeType: string | null;
    attachmentId: string | null;
    size: number | null;
  }>;
};

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me/";
const METADATA_HEADERS = [
  "Subject",
  "From",
  "To",
  "Cc",
  "Date",
  "Message-ID",
  "In-Reply-To",
  "References",
];
const LABEL_CACHE_TTL_MS = 10 * 60 * 1000;
let labelCache: { fetchedAt: number; labels: Map<string, string> } | null =
  null;

const gmailReadParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: {
    mode: {
      type: "string",
      enum: ["search", "thread", "message"],
      description:
        "What to read: search Gmail as threads, fetch one full thread, or fetch one full message.",
    },
    query: {
      type: "string",
      description:
        "Gmail search syntax query for mode=search, e.g. 'from:alice newer:2026/06/01', 'label:Minutes', or 'in:inbox'. Defaults to in:inbox.",
    },
    threadId: {
      type: "string",
      description:
        "Gmail thread id for mode=thread. Search results return thread ids.",
    },
    messageId: {
      type: "string",
      description:
        "Gmail message id for mode=message. Search/thread results return message ids.",
    },
    labelIds: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional Gmail label ids to restrict search, e.g. INBOX, UNREAD, SENT, Label_123.",
    },
    includeSpamTrash: {
      type: "boolean",
      description: "Include Spam and Trash in searches. Defaults to false.",
    },
    maxResults: {
      type: "number",
      description:
        "Maximum threads returned by search. Defaults to 10, maximum 50.",
    },
    maxChars: {
      type: "number",
      description:
        "Maximum body text characters returned for mode=thread/message. Defaults to 12000, maximum 100000.",
    },
    render: {
      type: "boolean",
      description:
        "Set true when the user explicitly asks for a visual Gmail table/thread display. Search render shows only metadata/snippets; browser expansion loads thread bodies without adding them to assistant context.",
    },
  },
} as const;

const googleGmailReadTool = defineAgentTool<GmailReadParams>({
  name: "google_gmail_read",
  label: "Gmail: Read/Search",
  description:
    "Read-only Gmail access for searching email threads and fetching selected thread/message contents. Search is thread-aware and returns metadata, labels, participants, read/unread state and snippets but no bodies — a thread counts as unread when any message in it carries UNREAD. Do not pull bodies for every hit: use mode=thread/message only for the relevant one(s). Cite an email with its gmailUrl, never a placeholder like [email](...).",
  parameters: gmailReadParamsSchema,
  async execute(params) {
    const config = getGoogleToolConfig();
    const accessToken = await ensureGoogleAccessToken(config);
    const labelMap = await getLabelMap(accessToken);

    if (params.mode === "search") {
      const query = params.query?.trim() || "in:inbox";
      const maxResults = clamp(params.maxResults ?? 10, 1, 50);
      const page = await searchThreads({
        accessToken,
        query,
        ...(params.labelIds !== undefined ? { labelIds: params.labelIds } : {}),
        includeSpamTrash: params.includeSpamTrash === true,
        maxResults,
      });
      const threads = [] as NormalizedGmailThreadSummary[];
      for (const item of page.threads ?? []) {
        if (!item.id) continue;
        const thread = await getThreadMetadata(item.id, accessToken);
        threads.push(normalizeThreadSummary(thread, labelMap));
      }
      threads.sort((a, b) => dateMs(b.latestDate) - dateMs(a.latestDate));
      const renderRequested = params.render === true;
      const payload = {
        mode: "search" as const,
        query,
        resultSizeEstimate: page.resultSizeEstimate ?? null,
        returned: threads.length,
        renderRequested,
        ...(renderRequested
          ? { availableCategories: availableGmailCategories(labelMap) }
          : {}),
        presentationGuidance:
          params.render === true
            ? "The UI renders these Gmail threads as a wide table. Search results intentionally contain metadata/snippets only; expanding a row in the browser loads the thread body without adding it to assistant context. Use mode=thread only if the assistant needs selected body text as context."
            : "Search results are thread-level metadata/snippets only. Use mode=thread with a selected threadId before summarizing email body contents.",
        threads: renderRequested ? threads : threads.map(compactThreadSummary),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    }

    if (params.mode === "thread") {
      const threadId = params.threadId?.trim();
      if (!threadId) throw new Error("threadId is required when mode=thread.");
      const maxChars = clamp(params.maxChars ?? 12_000, 1_000, 100_000);
      const payload = await getGmailThreadPreview(
        threadId,
        maxChars,
        accessToken,
        labelMap,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ...payload, renderRequested: params.render === true },
              null,
              2,
            ),
          },
        ],
        details: { ...payload, renderRequested: params.render === true },
      };
    }

    if (params.mode === "message") {
      const messageId = params.messageId?.trim();
      if (!messageId)
        throw new Error("messageId is required when mode=message.");
      const maxChars = clamp(params.maxChars ?? 12_000, 1_000, 100_000);
      const message = await getMessageFull(messageId, accessToken);
      const normalized = normalizeMessageFull(message, labelMap, maxChars);
      const payload = {
        mode: "message" as const,
        messageId,
        threadId: message.threadId ?? null,
        renderRequested: params.render === true,
        presentationGuidance:
          "This is one selected Gmail message body. Cite gmailUrl when useful.",
        message: normalized,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    }

    throw new Error(
      `Unsupported Gmail read mode: ${(params as { mode?: string }).mode ?? "(missing)"}`,
    );
  },
});

export const assistantGoogleGmailTools = [googleGmailReadTool];

export async function getGmailThreadTextPreview(
  threadId: string,
  maxChars = 20_000,
) {
  const cleanThreadId = threadId.trim();
  if (!cleanThreadId) throw new Error("threadId is required.");
  const config = getGoogleToolConfig();
  const accessToken = await ensureGoogleAccessToken(config);
  const labelMap = await getLabelMap(accessToken);
  return getGmailThreadPreview(cleanThreadId, maxChars, accessToken, labelMap, {
    includeReadableAttachments: true,
  });
}

async function getGmailThreadPreview(
  threadId: string,
  maxChars: number,
  accessToken: string,
  labelMap: Map<string, string>,
  options?: { includeReadableAttachments?: boolean },
) {
  const thread = await getThreadFull(threadId, accessToken);
  const budget = { remaining: clamp(maxChars, 1_000, 100_000) };
  const fullMessages = sortMessages(thread.messages ?? []);
  const messages = fullMessages.map((message) =>
    normalizeMessageFull(message, labelMap, budget.remaining, budget),
  );
  if (options?.includeReadableAttachments) {
    for (let i = 0; i < messages.length && budget.remaining > 0; i++) {
      const message = messages[i];
      if (message)
        await appendReadableAttachmentText(
          message,
          fullMessages[i],
          accessToken,
          budget,
        );
    }
  }
  const summary = normalizeThreadSummary(thread, labelMap);
  const payload = {
    mode: "thread" as const,
    threadId,
    gmailUrl: gmailThreadUrl(threadId),
    subject: summary.subject,
    unread: summary.unread,
    messageCount: messages.length,
    latestDate: summary.latestDate,
    localLatestDate: summary.localLatestDate,
    participants: summary.participants,
    labels: summary.labels,
    labelIds: summary.labelIds,
    availableCategories: availableGmailCategories(labelMap),
    totalTextCharCount: messages.reduce(
      (sum, message) => sum + message.textCharCount,
      0,
    ),
    truncated: messages.some((message) => message.truncated),
    presentationGuidance:
      "This thread body was loaded on demand. Cite gmailUrl when useful; do not duplicate long email text unless the user asks.",
    messages,
  };
  return payload;
}

async function searchThreads({
  accessToken,
  query,
  labelIds,
  includeSpamTrash,
  maxResults,
}: {
  accessToken: string;
  query: string;
  labelIds?: string[];
  includeSpamTrash: boolean;
  maxResults: number;
}): Promise<GmailListThreadsPage> {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(maxResults),
    includeSpamTrash: String(includeSpamTrash),
  });
  for (const labelId of labelIds ?? []) {
    const clean = labelId.trim();
    if (clean) params.append("labelIds", clean);
  }
  return gmailGet<GmailListThreadsPage>(`threads?${params}`, accessToken);
}

async function getThreadMetadata(
  threadId: string,
  accessToken: string,
): Promise<GmailThread> {
  const params = metadataParams();
  return gmailGet<GmailThread>(
    `threads/${encodeURIComponent(threadId)}?${params}`,
    accessToken,
  );
}

async function getThreadFull(
  threadId: string,
  accessToken: string,
): Promise<GmailThread> {
  return gmailGet<GmailThread>(
    `threads/${encodeURIComponent(threadId)}?format=full`,
    accessToken,
  );
}

async function getMessageFull(
  messageId: string,
  accessToken: string,
): Promise<GmailMessage> {
  return gmailGet<GmailMessage>(
    `messages/${encodeURIComponent(messageId)}?format=full`,
    accessToken,
  );
}

async function getMessageAttachment(
  messageId: string,
  attachmentId: string,
  accessToken: string,
): Promise<GmailAttachmentResponse> {
  return gmailGet<GmailAttachmentResponse>(
    `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    accessToken,
  );
}

function metadataParams(): URLSearchParams {
  const params = new URLSearchParams({ format: "metadata" });
  for (const header of METADATA_HEADERS)
    params.append("metadataHeaders", header);
  return params;
}

async function gmailGet<T>(pathOrUrl: string, accessToken: string): Promise<T> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${GMAIL_API_BASE}${pathOrUrl.replace(/^\//, "")}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `Gmail API returned HTTP ${res.status}: ${text.slice(0, 700)}`,
    );
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function getLabelMap(accessToken: string): Promise<Map<string, string>> {
  if (labelCache && Date.now() - labelCache.fetchedAt < LABEL_CACHE_TTL_MS)
    return labelCache.labels;
  const response = await gmailGet<GmailLabelsResponse>("labels", accessToken);
  const map = new Map<string, string>();
  for (const label of response.labels ?? []) {
    if (label.id) map.set(label.id, label.name || label.id);
  }
  labelCache = { fetchedAt: Date.now(), labels: map };
  return map;
}

function normalizeThreadSummary(
  thread: GmailThread,
  labelMap: Map<string, string>,
): NormalizedGmailThreadSummary {
  const messages = sortMessages(thread.messages ?? []);
  const summaries = messages.map((message) =>
    normalizeMessageSummary(message, labelMap),
  );
  const allLabelIds = unique(
    messages.flatMap((message) => message.labelIds ?? []),
  );
  const latest = messages[messages.length - 1];
  const first = messages[0];
  const subject = latest
    ? header(latest, "Subject") ||
      summaries.find((m) => m.subject)?.subject ||
      "(no subject)"
    : "(no subject)";
  const participants = participantList(messages);
  return {
    id: thread.id ?? latest?.threadId ?? "",
    gmailUrl: gmailThreadUrl(thread.id ?? latest?.threadId ?? ""),
    subject,
    snippet: cleanSnippet(
      thread.snippet ||
        latest?.snippet ||
        summaries[summaries.length - 1]?.snippet ||
        "",
    ),
    unread: allLabelIds.includes("UNREAD"),
    inbox: allLabelIds.includes("INBOX"),
    starred: allLabelIds.includes("STARRED"),
    important: allLabelIds.includes("IMPORTANT"),
    messageCount: messages.length,
    firstDate: first ? isoDate(first) : null,
    latestDate: latest ? isoDate(latest) : null,
    localFirstDate: first ? formatLocalDateTime(isoDate(first)) : null,
    localLatestDate: latest ? formatLocalDateTime(isoDate(latest)) : null,
    latestFrom: latest ? header(latest, "From") || null : null,
    participants,
    labels: labelsFor(allLabelIds, labelMap),
    labelIds: allLabelIds,
    messages: summaries,
  };
}

function compactThreadSummary(thread: NormalizedGmailThreadSummary) {
  return {
    id: thread.id,
    gmailUrl: thread.gmailUrl,
    subject: thread.subject,
    snippet: thread.snippet,
    unread: thread.unread,
    messageCount: thread.messageCount,
    localLatestDate: thread.localLatestDate,
    latestFrom: thread.latestFrom,
    participants: thread.participants,
    labels: thread.labels,
  };
}

function normalizeMessageSummary(
  message: GmailMessage,
  labelMap: Map<string, string>,
): NormalizedGmailMessageSummary {
  const labelIds = message.labelIds ?? [];
  const from = header(message, "From") || null;
  const parsedFrom = parseAddress(from);
  const date = isoDate(message);
  return {
    id: message.id ?? null,
    threadId: message.threadId ?? null,
    date,
    localDate: formatLocalDateTime(date),
    from,
    fromName: parsedFrom.name,
    fromEmail: parsedFrom.email,
    to: header(message, "To") || null,
    subject: header(message, "Subject") || "(no subject)",
    snippet: cleanSnippet(message.snippet ?? ""),
    unread: labelIds.includes("UNREAD"),
    labels: labelsFor(labelIds, labelMap),
    labelIds,
    gmailUrl: message.threadId ? gmailThreadUrl(message.threadId) : null,
  };
}

function normalizeMessageFull(
  message: GmailMessage,
  labelMap: Map<string, string>,
  maxChars: number,
  sharedBudget?: { remaining: number },
): NormalizedGmailMessageFull {
  const summary = normalizeMessageSummary(message, labelMap);
  const extracted = extractMessageText(message.payload);
  const available = sharedBudget
    ? Math.max(0, sharedBudget.remaining)
    : maxChars;
  const text =
    extracted.text.length > available
      ? `${extracted.text.slice(0, Math.max(0, available))}…`
      : extracted.text;
  if (sharedBudget)
    sharedBudget.remaining = Math.max(0, sharedBudget.remaining - text.length);
  return {
    ...summary,
    text,
    textCharCount: text.length,
    truncated: extracted.text.length > available,
    attachments: extracted.attachments,
  };
}

function sortMessages(messages: GmailMessage[]): GmailMessage[] {
  return [...messages].sort((a, b) => dateMs(isoDate(a)) - dateMs(isoDate(b)));
}

function header(message: GmailMessage, name: string): string {
  const value = message.payload?.headers?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  )?.value;
  return value?.trim() ?? "";
}

function isoDate(message: GmailMessage): string | null {
  const internal = Number(message.internalDate);
  if (Number.isFinite(internal) && internal > 0)
    return new Date(internal).toISOString();
  const rawDate = header(message, "Date");
  if (!rawDate) return null;
  const parsed = new Date(rawDate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function participantList(
  messages: GmailMessage[],
): Array<{ name: string | null; email: string | null; label: string }> {
  const out: Array<{
    name: string | null;
    email: string | null;
    label: string;
  }> = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const parsed = parseAddress(header(message, "From") || null);
    const key = (parsed.email || parsed.label).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
    if (out.length >= 8) break;
  }
  return out;
}

function parseAddress(value: string | null): {
  name: string | null;
  email: string | null;
  label: string;
} {
  const clean = (value ?? "").trim();
  if (!clean) return { name: null, email: null, label: "" };
  const match = clean.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>/);
  const email =
    (
      match?.[2] ??
      clean.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ??
      ""
    ).trim() || null;
  const rawName = (match?.[1] ?? "").trim().replace(/^"|"$/g, "") || null;
  const label = rawName && email ? `${rawName} <${email}>` : email || clean;
  return { name: rawName, email, label };
}

function labelsFor(
  labelIds: string[],
  labelMap: Map<string, string>,
): string[] {
  return unique(labelIds.map((id) => labelMap.get(id) ?? id));
}

function availableGmailCategories(
  labelMap: Map<string, string>,
): Array<{ id: string; name: string }> {
  return [...labelMap.entries()]
    .filter(([id]) => id.startsWith("CATEGORY_"))
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function extractMessageText(payload: GmailMessagePart | undefined): {
  text: string;
  attachments: Array<{
    filename: string;
    mimeType: string | null;
    attachmentId: string | null;
    size: number | null;
  }>;
} {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: Array<{
    filename: string;
    mimeType: string | null;
    attachmentId: string | null;
    size: number | null;
  }> = [];

  const visit = (part: GmailMessagePart | undefined) => {
    if (!part) return;
    const filename = part.filename?.trim();
    const attachmentId = part.body?.attachmentId ?? null;
    if (filename || attachmentId) {
      attachments.push({
        filename: filename || "attachment",
        mimeType: part.mimeType ?? null,
        attachmentId,
        size: part.body?.size ?? null,
      });
      return;
    }
    const decoded = part.body?.data ? decodeBase64Url(part.body.data) : "";
    if (decoded && part.mimeType === "text/plain") plain.push(decoded);
    else if (decoded && part.mimeType === "text/html")
      html.push(stripHtml(decoded));
    for (const child of part.parts ?? []) visit(child);
  };

  visit(payload);
  const text = (plain.length ? plain.join("\n\n") : html.join("\n\n")).trim();
  return { text, attachments };
}

function decodeBase64Url(value: string): string {
  return decodeBase64UrlBuffer(value).toString("utf8");
}

function decodeBase64UrlBuffer(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

async function appendReadableAttachmentText(
  message: NormalizedGmailMessageFull,
  raw: GmailMessage | undefined,
  accessToken: string,
  budget: { remaining: number },
): Promise<void> {
  if (!raw?.id || budget.remaining <= 0) return;
  const blocks: string[] = [];
  let attachmentTruncated = false;
  for (const attachment of message.attachments) {
    if (
      !attachment.attachmentId ||
      budget.remaining <= 0 ||
      !isReadableAttachment(attachment.filename, attachment.mimeType)
    )
      continue;
    const response = await getMessageAttachment(
      raw.id,
      attachment.attachmentId,
      accessToken,
    );
    if (!response.data) continue;
    const extracted = extractReadableAttachmentText(
      decodeBase64UrlBuffer(response.data),
      attachment.filename,
      attachment.mimeType,
    );
    if (!extracted.text.trim()) continue;
    const header = `Attachment: ${attachment.filename}${attachment.mimeType ? ` (${attachment.mimeType})` : ""}`;
    const available = Math.max(0, budget.remaining - header.length - 2);
    const body =
      extracted.text.length > available
        ? `${extracted.text.slice(0, available)}…`
        : extracted.text;
    attachmentTruncated =
      attachmentTruncated ||
      extracted.truncated ||
      extracted.text.length > available;
    budget.remaining = Math.max(
      0,
      budget.remaining - header.length - body.length - 2,
    );
    blocks.push(`${header}\n${body}`);
  }
  if (!blocks.length) return;
  const appended = `${message.text ? `${message.text}\n\n---\n\n` : ""}${blocks.join("\n\n---\n\n")}`;
  message.text = appended;
  message.textCharCount = appended.length;
  message.truncated =
    message.truncated || attachmentTruncated || budget.remaining <= 0;
}

function isReadableAttachment(
  filename: string,
  mimeType: string | null,
): boolean {
  const lower = filename.toLowerCase();
  const mime = (mimeType ?? "").toLowerCase();
  return (
    mime.startsWith("text/") ||
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lower.endsWith(".docx") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".md") ||
    lower.endsWith(".html") ||
    lower.endsWith(".htm")
  );
}

function extractReadableAttachmentText(
  buffer: Buffer,
  filename: string,
  mimeType: string | null,
): { text: string; truncated: boolean } {
  const lower = filename.toLowerCase();
  const mime = (mimeType ?? "").toLowerCase();
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lower.endsWith(".docx")
  ) {
    return { text: extractDocxText(buffer), truncated: false };
  }
  const raw = buffer.toString("utf8");
  if (mime === "text/html" || lower.endsWith(".html") || lower.endsWith(".htm"))
    return { text: stripHtml(raw), truncated: false };
  return { text: raw.trim(), truncated: false };
}

function extractDocxText(buffer: Buffer): string {
  const parts = readZipEntries(buffer)
    .filter((entry) =>
      /^word\/(document|header\d*|footer\d*)\.xml$/i.test(entry.name),
    )
    .sort((a, b) =>
      a.name === "word/document.xml"
        ? -1
        : b.name === "word/document.xml"
          ? 1
          : a.name.localeCompare(b.name),
    )
    .map((entry) => docxXmlToText(entry.data.toString("utf8")))
    .filter(Boolean);
  return parts.join("\n\n").trim();
}

type ZipEntry = { name: string; data: Buffer };

function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) return [];
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  while (
    offset + 46 <= buffer.length &&
    buffer.readUInt32LE(offset) === 0x02014b50
  ) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart =
      localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data =
      method === 0
        ? compressed
        : method === 8
          ? inflateRawSync(compressed)
          : Buffer.alloc(0);
    if (data.length) entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 66_000);
  for (let offset = buffer.length - 22; offset >= min; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function docxXmlToText(xml: string): string {
  return decodeHtmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/gi, "\t")
      .replace(/<w:br\b[^>]*\/>/gi, "\n")
      .replace(/<\/w:p>/gi, "\n")
      .replace(/<\/w:tr>/gi, "\n")
      .replace(/<\/w:tc>/gi, "\t")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    );
}

function gmailThreadUrl(threadId: string): string {
  return threadId
    ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`
    : "";
}

function cleanSnippet(value: string): string {
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

function dateMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
