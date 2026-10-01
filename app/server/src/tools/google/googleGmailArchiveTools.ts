import type { ApprovalCard, GmailArchiveApprovalItem } from "@assistant/shared";
import { errorText } from "../../errors.ts";
import {
  ensureGoogleAccessToken,
  getGoogleToolConfig,
} from "../../googleSettings.ts";
import { defineAgentTool } from "../../mcp/tool.ts";
import {
  approvalCardReference,
  createApproval,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me/";
const MAX_ARCHIVE_THREADS = 100;
// Approval cards are permanent audit records in one JSON store. Keep a batch
// large enough for cleanup, but small enough to review and re-read cheaply.
const MAX_ARCHIVE_MESSAGES = 200;
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

type GmailArchiveParams = {
  threadIds?: string[];
};

interface GmailMessageMetadata {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  payload?: {
    headers?: Array<{ name?: string; value?: string }>;
  };
}

interface GmailThreadMetadata {
  id?: string;
  messages?: GmailMessageMetadata[];
}

const gmailArchiveParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["threadIds"],
  properties: {
    threadIds: {
      type: "array",
      minItems: 1,
      maxItems: MAX_ARCHIVE_THREADS,
      items: { type: "string" },
      description:
        "Gmail thread ids returned by google_gmail_read. Every message currently carrying the INBOX label in these threads is listed on one all-or-nothing approval card; later mail in the same threads is not included.",
    },
  },
} as const;

/**
 * Resolve thread ids into frozen message ids before asking. Approving can then
 * use Gmail's one batchModify request without sweeping in mail that arrived
 * while the card was waiting.
 */
export const googleGmailArchiveTool = defineAgentTool<GmailArchiveParams>({
  name: "google_gmail_archive",
  label: "Gmail: Archive Emails",
  description:
    "Prepare an all-or-nothing Gmail archive proposal, only when the user explicitly asks to archive email. First use google_gmail_read to identify the exact thread ids, then pass all intended threads in one call. This tool fetches metadata, lists the sender and subject of every inbox message on a confirmation card, and stops. Nothing is archived until the user approves the card. Approval removes only the INBOX label from the message ids shown; it never trashes or deletes mail, and mail arriving in those threads after the proposal stays in the inbox.",
  parameters: gmailArchiveParamsSchema,
  async execute(params, ctx) {
    const threadIds = normalizeThreadIds(params.threadIds);
    const config = getGoogleToolConfig();
    if (!config.grantedScopes.includes(GMAIL_MODIFY_SCOPE))
      throw new Error(
        "Gmail archive permission is not granted. Reauthorize Google Workspace in Settings before preparing an archive approval.",
      );
    const accessToken = await ensureGoogleAccessToken(config);
    const items: GmailArchiveApprovalItem[] = [];
    const seenMessageIds = new Set<string>();

    for (const threadId of threadIds) {
      const thread = await getThreadMetadata(threadId, accessToken, ctx.signal);
      for (const message of thread.messages ?? []) {
        if (!message.id || !message.labelIds?.includes("INBOX")) continue;
        if (seenMessageIds.has(message.id)) continue;
        seenMessageIds.add(message.id);
        items.push({
          messageId: message.id,
          threadId: message.threadId ?? thread.id ?? threadId,
          sender: header(message, "From") || "(unknown sender)",
          subject: header(message, "Subject") || "(no subject)",
          gmailUrl: gmailThreadUrl(message.threadId ?? thread.id ?? threadId),
        });
      }
    }

    if (items.length === 0)
      throw new Error(
        "None of the selected Gmail threads contains a message in the inbox.",
      );
    if (items.length > MAX_ARCHIVE_MESSAGES)
      throw new Error(
        `The selected threads contain ${items.length} inbox messages. Gmail allows at most ${MAX_ARCHIVE_MESSAGES} messages in one archive approval; narrow the selection and try again.`,
      );

    const title =
      items.length === 1 ? "Archive 1 email" : `Archive ${items.length} emails`;
    const summary = `${items.length} email${items.length === 1 ? "" : "s"} in ${threadIds.length} thread${threadIds.length === 1 ? "" : "s"}`;
    const card = createApproval({
      sessionId: ctx.session.sessionId,
      kind: "gmailArchive",
      title,
      summary,
      sourceToolCallId: ctx.toolCallId,
      body: { kind: "gmailArchive", items },
    });

    return {
      content: [
        {
          type: "text",
          text: `Prepared one Gmail approval for ${items.length} email${items.length === 1 ? "" : "s"}. Nothing has been archived yet. Do not claim the archive happened until the approved result appears. ${approvalCardReference(card)}`,
        },
      ],
      terminate: true,
    };
  },
});

registerApprovalExecutor("gmailArchive", {
  async execute(card: ApprovalCard) {
    if (card.body.kind !== "gmailArchive")
      throw new Error("Mismatched approval body for gmailArchive.");
    if (card.body.items.length === 0)
      throw new Error("The Gmail archive approval contains no messages.");
    if (card.body.items.length > MAX_ARCHIVE_MESSAGES)
      throw new Error(
        `The Gmail archive approval exceeds the ${MAX_ARCHIVE_MESSAGES}-message limit.`,
      );

    const config = getGoogleToolConfig();
    if (!config.grantedScopes.includes(GMAIL_MODIFY_SCOPE))
      throw new Error(
        "Gmail archive permission is no longer granted. Reauthorize Google Workspace in Settings, then prepare a new archive approval.",
      );
    const accessToken = await ensureGoogleAccessToken(config);
    await gmailRequest(
      "messages/batchModify",
      accessToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: card.body.items.map((item) => item.messageId),
          removeLabelIds: ["INBOX"],
        }),
      },
      "archive email",
    );
    const count = card.body.items.length;
    return {
      resultSummary: `Archived ${count} email${count === 1 ? "" : "s"}`,
    };
  },
});

export const assistantGoogleGmailArchiveTools = [googleGmailArchiveTool];

function normalizeThreadIds(value: string[] | undefined): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("threadIds must contain at least one Gmail thread id.");
  if (value.length > MAX_ARCHIVE_THREADS)
    throw new Error(
      `threadIds accepts at most ${MAX_ARCHIVE_THREADS} Gmail threads.`,
    );
  const ids = [...new Set(value.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0)
    throw new Error("threadIds must contain at least one Gmail thread id.");
  return ids;
}

async function getThreadMetadata(
  threadId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<GmailThreadMetadata> {
  const params = new URLSearchParams({ format: "metadata" });
  params.append("metadataHeaders", "From");
  params.append("metadataHeaders", "Subject");
  return gmailRequest<GmailThreadMetadata>(
    `threads/${encodeURIComponent(threadId)}?${params}`,
    accessToken,
    { method: "GET", ...(signal ? { signal } : {}) },
    "read email metadata",
  );
}

async function gmailRequest<T = Record<string, never>>(
  path: string,
  accessToken: string,
  init: RequestInit,
  action: string,
): Promise<T> {
  const response = await fetch(`${GMAIL_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    const reconnect =
      response.status === 401 || response.status === 403
        ? " Reconnect Google Workspace in Settings so Gmail archive permission is granted."
        : "";
    const uncertain =
      action === "archive email"
        ? " Gmail did not confirm the archive. Check the inbox before trying again."
        : "";
    throw new Error(
      `Gmail could not ${action} (HTTP ${response.status}): ${text.slice(0, 700)}.${reconnect}${uncertain}`,
    );
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`Gmail returned an invalid response: ${errorText(err)}`);
  }
}

function header(message: GmailMessageMetadata, name: string): string {
  return (
    message.payload?.headers
      ?.find((entry) => entry.name?.toLowerCase() === name.toLowerCase())
      ?.value?.trim() ?? ""
  );
}

function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}
