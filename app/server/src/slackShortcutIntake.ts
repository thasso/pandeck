import type { TaskExternalLink, TaskItem } from "@assistant/shared";
import { PORT, PUBLIC_BASE_URL, SLACK_STATIC_CONFIG } from "./config.ts";
import { errorText } from "./errors.ts";
import { getProject } from "./projectRegistry.ts";
import {
  getSlackRuntimeSettings,
  getSlackToolConfig,
} from "./slackSettings.ts";
import { getSettings } from "./settings.ts";
import {
  slackSocketMode,
  type SlackSocketEnvelope,
} from "./slackSocketMode.ts";
import { isSlackPrivateDownloadHost } from "./slackUrls.ts";
import { curateTaskIntake } from "./taskIntakeAgent.ts";
import { createTask, listTasks, readTask, updateTask } from "./tasks.ts";

export const SLACK_CREATE_TASK_CALLBACK_ID = "personal_assistant_create_task";
const MAX_THREAD_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_CONTEXT_MESSAGE_CHARS = 4_000;
const MAX_TASK_CONTEXT_CHARS = 100_000;
const MAX_FILES = 20;
const MAX_ATTACHMENTS = 20;
const MAX_CONVERSATION_MEMBERS = 10;
const MAX_CONVERSATION_LABEL_CHARS = 300;
const MAX_EXTERNAL_LINK_TITLE_CHARS = 350;
const MAX_SLACK_API_RESPONSE_BYTES = 1_000_000;
const SLACK_API_TIMEOUT_MS = 15_000;
const CURATION_PENDING_MARKER =
  "Task Intake Agent curation is pending and can be retried by using the Slack shortcut again.";

type SlackMessage = {
  ts?: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  reply_count?: number;
  files?: Array<{
    name?: string;
    title?: string;
    mimetype?: string;
    permalink?: string;
  }>;
  attachments?: Array<{
    title?: string;
    text?: string;
    fallback?: string;
    title_link?: string;
  }>;
};

type ShortcutPayload = {
  type?: string;
  callback_id?: string;
  response_url?: string;
  team?: { id?: string };
  user?: { id?: string };
  channel?: { id?: string; name?: string };
  message_ts?: string;
  message?: SlackMessage;
};

type SlackApiResponse = Record<string, any> & { ok?: boolean; error?: string };

let unsubscribe: (() => void) | undefined;

export function startSlackShortcutIntake(): void {
  if (unsubscribe) return;
  unsubscribe = slackSocketMode.subscribe(handleSlackShortcutEnvelope);
}

export function stopSlackShortcutIntake(): void {
  unsubscribe?.();
  unsubscribe = undefined;
}

export async function handleSlackShortcutEnvelope(
  envelope: SlackSocketEnvelope,
): Promise<void> {
  if (envelope.type !== "interactive") return;
  const payload = envelope.payload as ShortcutPayload | undefined;
  if (
    payload?.type !== "message_action" ||
    payload.callback_id !== SLACK_CREATE_TASK_CALLBACK_ID
  )
    return;
  const settings = getSlackRuntimeSettings();
  if (
    payload.team?.id !== SLACK_STATIC_CONFIG.teamId ||
    !settings.accountUserId ||
    payload.user?.id !== settings.accountUserId
  ) {
    console.warn(
      "[slack-shortcut] ignored shortcut from unexpected workspace or user",
    );
    return;
  }

  const channelId = payload.channel?.id?.trim();
  const messageTs = (payload.message_ts ?? payload.message?.ts)?.trim();
  if (
    !channelId ||
    !/^[CDG][A-Z0-9]{1,30}$/.test(channelId) ||
    !messageTs ||
    !/^\d{10}\.\d{1,6}$/.test(messageTs)
  ) {
    await respondPrivately(
      payload,
      "Could not create a task because Slack did not include a valid message reference.",
    );
    return;
  }

  const sourceUrl = slackMessageUrl(channelId, messageTs);
  const existing = findTaskBySlackMessage(channelId, messageTs);
  const isPendingRetry =
    existing?.description.includes(CURATION_PENDING_MARKER) === true;
  if (existing && !isPendingRetry) {
    const existingSourceUrl =
      existing.externalLinks?.find(
        (link) => link.type === "source" && link.source === "slack",
      )?.url ?? sourceUrl;
    await sendExistingTaskFeedback(payload, existing, existingSourceUrl);
    return;
  }

  // Persist first: enrichment may fail, but the user's intake must never be lost.
  const selected = payload.message ?? { ts: messageTs };
  const intakeSettings = getSettings().taskIntakeAgent;
  const configuredProject = intakeSettings.projectId
    ? getProject(intakeSettings.projectId)
    : null;
  const intakeProjectId =
    configuredProject && configuredProject.status !== "archived"
      ? configuredProject.id
      : undefined;
  if (intakeSettings.projectId && !intakeProjectId) {
    console.warn(
      `[slack-shortcut] configured Task intake project is unavailable; creating without project link`,
    );
  }
  const task =
    existing ??
    createTask({
      title: taskTitle(selected.text),
      description: pendingDescription(payload, selected, sourceUrl),
      status: "todo",
      ...(intakeProjectId !== undefined ? { projectId: intakeProjectId } : {}),
      externalLinks: [
        slackSourceLink(
          sourceUrl,
          payload.channel?.name
            ? `#${clipInline(payload.channel.name.replace(/^#/, ""), MAX_CONVERSATION_LABEL_CHARS - 1)}`
            : undefined,
        ),
      ],
      // `createdBy: "user"` is honest — the user asked for this import — but it is
      // NOT typed into the Backlog, so it stays untriaged and lands in the Inbox.
      // Triage is deliberately a separate axis from who wanted the Task.
      source: { createdBy: "user" },
    });
  // Start private App-DM feedback immediately and in parallel with enrichment.
  // The Task is already durable (and broadcast to web clients) before this call.
  const progress = postShortcutProgress(payload.user!.id!, task.id, sourceUrl);

  let confirmation: string;
  let finalSourceUrl = sourceUrl;
  try {
    const enriched = await enrichShortcut(payload, selected, sourceUrl);
    finalSourceUrl = enriched.permalink;
    try {
      const curated = await curateTaskIntake(
        {
          title: taskTitle(selected.text, enriched.authorName),
          description: enriched.description,
          sourceUrl: enriched.permalink,
          ...(enriched.conversationLabel !== undefined
            ? { sourceLabel: enriched.conversationLabel }
            : {}),
          ...(task.projectId !== undefined
            ? { projectId: task.projectId }
            : {}),
        },
        intakeSettings,
      );
      const updated = updateTask(task.id, {
        title: curated.title,
        description: curated.description,
        externalLinks: [
          slackSourceLink(enriched.permalink, enriched.conversationLabel),
        ],
      });
      confirmation = `${isPendingRetry ? "Updated" : "Created"} Pandeck Task #${updated.id}: ${updated.title}`;
      console.info(
        `[slack-shortcut] ${isPendingRetry ? "curated" : "created"} Task #${updated.id} from authorized Slack message`,
      );
    } catch (error) {
      const reason = errorText(error);
      updateTask(task.id, {
        description: `${enriched.description}\n\n> ${CURATION_PENDING_MARKER} Last error: ${safeInline(reason)}`,
        externalLinks: [
          slackSourceLink(enriched.permalink, enriched.conversationLabel),
        ],
      });
      confirmation = `Created Task #${task.id} with Slack context, but Task Intake Agent curation is pending. Use the shortcut again to retry.`;
      console.warn(
        `[slack-shortcut] Task #${task.id} curation pending: ${reason}`,
      );
    }
  } catch (error) {
    const reason = errorText(error);
    updateTask(task.id, {
      description: `${pendingDescription(payload, selected, sourceUrl)}\n\n> ${CURATION_PENDING_MARKER} Slack context could not be loaded yet. Last error: ${safeInline(reason)}`,
    });
    confirmation = `Created Task #${task.id}, but Slack context could not be loaded yet. Use the shortcut again to retry.`;
    console.warn(
      `[slack-shortcut] Task #${task.id} context pending: ${reason}`,
    );
  }

  // Delivery is deliberately outside enrichment/curation state handling:
  // a Slack delivery failure must never overwrite a successfully curated Task.
  await finishShortcutProgress(
    progress,
    payload,
    task.id,
    confirmation,
    finalSourceUrl,
  );
}

async function enrichShortcut(
  payload: ShortcutPayload,
  selected: SlackMessage,
  fallbackUrl: string,
): Promise<{
  description: string;
  permalink: string;
  conversationLabel?: string;
  authorName?: string;
}> {
  const channelId = payload.channel!.id!;
  const messageTs = payload.message_ts ?? selected.ts!;
  const rootTs = selected.thread_ts ?? messageTs;
  const [permalinkResult, conversationResult, threadResult, nearbyResult] =
    await Promise.allSettled([
      slackApi("chat.getPermalink", {
        channel: channelId,
        message_ts: messageTs,
      }),
      slackApi("conversations.info", { channel: channelId }),
      slackApi("conversations.replies", {
        channel: channelId,
        ts: rootTs,
        limit: MAX_THREAD_MESSAGES,
        inclusive: true,
      }),
      slackApi("conversations.history", {
        channel: channelId,
        latest: messageTs,
        inclusive: true,
        limit: 5,
      }),
    ]);

  if (
    [permalinkResult, conversationResult, threadResult, nearbyResult].every(
      (result) => result.status === "rejected",
    )
  ) {
    throw (permalinkResult as PromiseRejectedResult).reason;
  }
  const permalink =
    safeSlackPermalink(fulfilled(permalinkResult)?.permalink, channelId) ??
    fallbackUrl;
  const conversation = fulfilled(conversationResult)?.channel as
    Record<string, unknown> | undefined;
  const rawChannelName =
    typeof conversation?.name === "string"
      ? conversation.name
      : payload.channel?.name;
  const channelName = rawChannelName
    ? clipInline(rawChannelName, MAX_CONVERSATION_LABEL_CHARS - 1)
    : undefined;
  const threadMessages = (
    (fulfilled(threadResult)?.messages ?? []) as SlackMessage[]
  ).slice(0, MAX_THREAD_MESSAGES);
  const nearbyMessages = (
    (fulfilled(nearbyResult)?.messages ?? []) as SlackMessage[]
  ).slice(0, 5);
  const contextMessages =
    threadMessages.length > 0 ? threadMessages : [selected];
  const userIds = new Set<string>();
  if (typeof conversation?.user === "string") userIds.add(conversation.user);
  if (Array.isArray(conversation?.members)) {
    for (const member of conversation.members.slice(0, 30))
      if (typeof member === "string") userIds.add(member);
  }
  for (const message of [...contextMessages, ...nearbyMessages]) {
    if (message.user) userIds.add(message.user);
    for (const match of message.text?.matchAll(/<@([A-Z0-9]+)>/g) ?? [])
      if (match[1]) userIds.add(match[1]);
  }
  const users = new Map<string, string>();
  await Promise.all(
    [...userIds].slice(0, 30).map(async (id) => {
      try {
        const response = await slackApi("users.info", { user: id });
        const user = response.user;
        const name =
          user?.profile?.display_name ||
          user?.profile?.real_name ||
          user?.real_name ||
          user?.name;
        if (typeof name === "string" && name.trim())
          users.set(id, clipInline(name, 200));
      } catch {
        // IDs remain readable if one profile is inaccessible.
      }
    }),
  );

  const authorName = selected.user ? users.get(selected.user) : undefined;
  const conversationLabel = formatConversationLabel(
    channelId,
    channelName,
    conversation,
    users,
    authorName,
    getSlackRuntimeSettings().accountUserId,
  );
  return {
    permalink,
    ...(conversationLabel !== undefined ? { conversationLabel } : {}),
    ...(authorName !== undefined ? { authorName } : {}),
    description: buildDescription({
      payload,
      selected,
      permalink,
      ...(conversationLabel !== undefined ? { conversationLabel } : {}),
      ...(authorName !== undefined ? { authorName } : {}),
      contextMessages,
      nearbyMessages,
      users,
    }),
  };
}

function buildDescription(input: {
  payload: ShortcutPayload;
  selected: SlackMessage;
  permalink: string;
  conversationLabel?: string;
  authorName?: string;
  contextMessages: SlackMessage[];
  nearbyMessages: SlackMessage[];
  users: Map<string, string>;
}): string {
  const selectedTs = input.payload.message_ts ?? input.selected.ts;
  const lines = [
    `Imported privately from [Slack message](${input.permalink}).`,
    "",
    `- Conversation: ${input.conversationLabel ?? input.payload.channel?.id}`,
    `- Author: ${input.authorName ?? input.selected.user ?? "Unknown"}`,
    `- Slack timestamp: ${selectedTs}`,
    "",
    "## Selected message",
    "",
    renderMessage(input.selected, input.users),
  ];
  const files = renderFiles(input.selected);
  if (files.length) lines.push("", "## Files and attachments", "", ...files);
  if (input.contextMessages.length > 1) {
    lines.push(
      "",
      `## Thread context (${input.contextMessages.length} messages)`,
      "",
    );
    for (const message of input.contextMessages)
      lines.push(`- ${renderMessage(message, input.users)}`);
  } else {
    const nearby = input.nearbyMessages
      .filter((message) => message.ts !== selectedTs)
      .slice(0, 4);
    if (nearby.length) {
      lines.push("", "## Nearby context", "");
      for (const message of nearby)
        lines.push(`- ${renderMessage(message, input.users)}`);
    }
  }
  return clipText(lines.join("\n"), MAX_TASK_CONTEXT_CHARS);
}

function renderMessage(
  message: SlackMessage,
  users: Map<string, string>,
): string {
  const author = clipInline(
    message.user ? (users.get(message.user) ?? message.user) : "Unknown",
    200,
  );
  const text = clipText(
    (message.text?.trim() || "(no text)").replace(
      /<@([A-Z0-9]+)>/g,
      (_all, id: string) => `@${users.get(id) ?? id}`,
    ),
    MAX_CONTEXT_MESSAGE_CHARS,
  );
  return `**${author}** (${clipInline(message.ts ?? "unknown time", 40)}): ${text}`;
}

function renderFiles(message: SlackMessage): string[] {
  const lines: string[] = [];
  for (const file of (message.files ?? []).slice(0, MAX_FILES)) {
    const label = clipInline(file.title || file.name || "Slack file", 300);
    const permalink = safeHttpUrl(file.permalink);
    lines.push(
      `- ${permalink ? `[${label}](${permalink})` : label}${file.mimetype ? ` — ${clipInline(file.mimetype, 100)}` : ""}`,
    );
  }
  for (const attachment of (message.attachments ?? []).slice(
    0,
    MAX_ATTACHMENTS,
  )) {
    const text = clipInline(
      attachment.title ||
        attachment.text ||
        attachment.fallback ||
        "Slack attachment",
      500,
    );
    const titleLink = safeHttpUrl(attachment.title_link);
    lines.push(`- ${titleLink ? `[${text}](${titleLink})` : text}`);
  }
  return lines;
}

function pendingDescription(
  payload: ShortcutPayload,
  selected: SlackMessage,
  sourceUrl: string,
): string {
  return [
    `Imported privately from [Slack message](${sourceUrl}).`,
    "",
    `- Conversation: ${payload.channel?.name ? `#${payload.channel.name}` : payload.channel?.id}`,
    `- Author: ${selected.user ?? "Unknown"}`,
    `- Slack timestamp: ${payload.message_ts ?? selected.ts}`,
    "",
    "## Selected message",
    "",
    clipText(
      selected.text?.trim() || "(Slack message context is pending)",
      MAX_MESSAGE_CHARS,
    ),
  ]
    .join("\n")
    .slice(0, MAX_TASK_CONTEXT_CHARS);
}

function findTaskBySlackMessage(
  channelId: string,
  messageTs: string,
): TaskItem | undefined {
  const compactTs = messageTs.replace(".", "");
  const summary = listTasks({ includeArchived: true }).find((task) =>
    (task.externalLinks ?? []).some((link) => {
      try {
        const url = new URL(link.url);
        const match = url.pathname.match(/\/archives\/([^/]+)\/p(\d{10,16})/i);
        return (
          match?.[1] === channelId &&
          match[2]?.padEnd(16, "0") === compactTs.padEnd(16, "0")
        );
      } catch {
        return false;
      }
    }),
  );
  return summary ? (readTask(summary.id) ?? undefined) : undefined;
}

function slackMessageUrl(channelId: string, messageTs: string): string {
  return `https://${SLACK_STATIC_CONFIG.workspaceHost}/archives/${encodeURIComponent(channelId)}/p${messageTs.replace(".", "")}`;
}

function slackSourceLink(
  url: string,
  conversationLabel?: string,
): TaskExternalLink {
  return {
    url,
    type: "source",
    source: "slack",
    title: conversationLabel
      ? clipInline(
          `Slack message in ${conversationLabel}`,
          MAX_EXTERNAL_LINK_TITLE_CHARS,
        )
      : "Slack message",
  };
}

function formatConversationLabel(
  channelId: string,
  channelName: string | undefined,
  conversation: Record<string, unknown> | undefined,
  users: Map<string, string>,
  authorName: string | undefined,
  currentUserId: string | undefined,
): string | undefined {
  const peerId =
    typeof conversation?.user === "string" ? conversation.user : undefined;
  if (conversation?.is_im === true || channelId.startsWith("D")) {
    const peer = peerId
      ? (users.get(peerId) ?? peerId)
      : (authorName ?? "unknown person");
    return clipInline(`DM with ${peer}`, MAX_CONVERSATION_LABEL_CHARS);
  }
  if (conversation?.is_mpim === true) {
    const names = Array.isArray(conversation.members)
      ? conversation.members
          .slice(0, MAX_CONVERSATION_MEMBERS)
          .flatMap((member) =>
            typeof member === "string" && member !== currentUserId
              ? [clipInline(users.get(member) ?? member, 100)]
              : [],
          )
      : [];
    return names.length > 0
      ? clipInline(
          `group DM with ${names.join(", ")}`,
          MAX_CONVERSATION_LABEL_CHARS,
        )
      : "group DM";
  }
  return channelName
    ? clipInline(
        `#${channelName.replace(/^#/, "")}`,
        MAX_CONVERSATION_LABEL_CHARS,
      )
    : undefined;
}

function taskTitle(text?: string, author?: string): string {
  const clean = text
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean) return clean.length > 100 ? `${clean.slice(0, 97)}…` : clean;
  return author
    ? `Follow up on Slack message from ${author}`
    : "Follow up on Slack message";
}

async function slackApi(
  method: string,
  params: Record<string, string | number | boolean>,
): Promise<SlackApiResponse> {
  const config = getSlackToolConfig("user");
  if (!config.enabled || !config.token)
    throw new Error("Slack personal account is not connected");
  return callSlackApi(method, params, config.token);
}

type ShortcutProgress = { channel: string; ts: string };

async function postShortcutProgress(
  userId: string,
  taskId: string,
  sourceUrl: string,
): Promise<ShortcutProgress | undefined> {
  try {
    const opened = await slackBotApi("conversations.open", { users: userId });
    const channel =
      typeof opened.channel?.id === "string" ? opened.channel.id : undefined;
    if (!channel)
      throw new Error("Slack did not return the Pandeck conversation");
    const posted = await slackBotApi(
      "chat.postMessage",
      shortcutMessageParams(
        channel,
        `:hourglass_flowing_sand: *Task #${taskId} accepted*\nI saved the Slack message and am preparing the Task now.\n\n${shortcutLinks(taskId, sourceUrl)}`,
      ),
    );
    const ts = typeof posted.ts === "string" ? posted.ts : undefined;
    if (!ts)
      throw new Error("Slack did not return a progress message timestamp");
    console.info(
      `[slack-shortcut] posted private progress for Task #${taskId}`,
    );
    return { channel, ts };
  } catch (error) {
    console.warn(
      `[slack-shortcut] private progress unavailable for Task #${taskId}: ${errorText(error)}`,
    );
    return undefined;
  }
}

async function finishShortcutProgress(
  progressPromise: Promise<ShortcutProgress | undefined>,
  payload: ShortcutPayload,
  taskId: string,
  confirmation: string,
  sourceUrl: string,
): Promise<void> {
  const progress = await progressPromise;
  const summary =
    confirmation.includes("pending") || confirmation.startsWith("Could not")
      ? `:warning: *Task #${taskId} needs attention*\n${confirmation}`
      : `:white_check_mark: *Task #${taskId} is ready*\n${confirmation}`;
  const finalText = `${summary}\n\n${shortcutLinks(taskId, sourceUrl)}`;
  if (progress) {
    try {
      await slackBotApi("chat.update", {
        ...shortcutMessageParams(progress.channel, finalText),
        ts: progress.ts,
      });
      console.info(
        `[slack-shortcut] updated private progress for Task #${taskId}`,
      );
      return;
    } catch (error) {
      console.warn(
        `[slack-shortcut] private progress update failed for Task #${taskId}: ${errorText(error)}`,
      );
      try {
        await slackBotApi(
          "chat.postMessage",
          shortcutMessageParams(progress.channel, finalText),
        );
        return;
      } catch (postError) {
        console.warn(
          `[slack-shortcut] private final message failed for Task #${taskId}: ${errorText(postError)}`,
        );
      }
    }
  }
  try {
    await respondPrivately(payload, finalText);
  } catch (error) {
    console.warn(
      `[slack-shortcut] private confirmation failed for Task #${taskId}: ${errorText(error)}`,
    );
  }
}

async function sendExistingTaskFeedback(
  payload: ShortcutPayload,
  task: TaskItem,
  sourceUrl: string,
): Promise<void> {
  const text = `:information_source: *Task already exists*\nTask #${task.id}: ${escapeSlackText(task.title)}\n\n${shortcutLinks(task.id, sourceUrl)}`;
  try {
    const opened = await slackBotApi("conversations.open", {
      users: payload.user!.id!,
    });
    const channel =
      typeof opened.channel?.id === "string" ? opened.channel.id : undefined;
    if (!channel)
      throw new Error("Slack did not return the Pandeck conversation");
    await slackBotApi("chat.postMessage", shortcutMessageParams(channel, text));
    console.info(
      `[slack-shortcut] posted private duplicate feedback for Task #${task.id}`,
    );
    return;
  } catch (error) {
    console.warn(
      `[slack-shortcut] private duplicate feedback unavailable for Task #${task.id}: ${errorText(error)}`,
    );
  }
  try {
    await respondPrivately(payload, text);
  } catch (error) {
    console.warn(
      `[slack-shortcut] private duplicate confirmation failed for Task #${task.id}: ${errorText(error)}`,
    );
  }
}

function shortcutLinks(taskId: string, sourceUrl: string): string {
  return `<${taskWebUrl(taskId)}|Open Task> · <${sourceUrl}|View original Slack message>`;
}

function taskWebUrl(taskId: string): string {
  const base = (PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(
    /\/+$/,
    "",
  );
  return `${base}/tasks/${encodeURIComponent(taskId)}`;
}

function escapeSlackText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function shortcutMessageParams(
  channel: string,
  text: string,
): Record<string, string> {
  const boundedText = clipText(text, 2_800);
  return {
    channel,
    text: boundedText,
    blocks: JSON.stringify([
      { type: "section", text: { type: "mrkdwn", text: boundedText } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Pandeck · Slack Task intake" }],
      },
    ]),
  };
}

async function respondPrivately(
  payload: ShortcutPayload,
  text: string,
): Promise<void> {
  if (await respondThroughInteractionUrl(payload.response_url, text)) return;

  const channel = payload.channel?.id;
  const user = payload.user?.id;
  if (!channel || !user) {
    console.warn(
      "[slack-shortcut] private confirmation unavailable: interaction response and channel/user fallback missing",
    );
    return;
  }
  try {
    await slackBotApi("chat.postEphemeral", { channel, user, text });
    console.info(
      "[slack-shortcut] sent private confirmation through chat.postEphemeral",
    );
  } catch (ephemeralError) {
    // A direct-message channel is already private; posting there is a safe fallback.
    if (channel.startsWith("D")) {
      try {
        await slackBotApi("chat.postMessage", { channel, text });
        console.info(
          "[slack-shortcut] sent private confirmation in direct message",
        );
        return;
      } catch (directError) {
        console.warn(
          `[slack-shortcut] private confirmation failed: ${errorText(directError)}`,
        );
        return;
      }
    }
    console.warn(
      `[slack-shortcut] private confirmation failed: ${errorText(ephemeralError)}`,
    );
  }
}

async function respondThroughInteractionUrl(
  responseUrl: string | undefined,
  text: string,
): Promise<boolean> {
  if (!responseUrl) return false;
  let url: URL;
  try {
    url = new URL(responseUrl);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "hooks.slack.com" ||
    !url.pathname.startsWith("/actions/")
  )
    return false;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "ephemeral",
        replace_original: false,
        text: clipText(text, 2_800),
      }),
      signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    if (response.ok) {
      console.info(
        "[slack-shortcut] sent private confirmation through interaction response",
      );
      return true;
    }
    console.warn(
      `[slack-shortcut] interaction response rejected with HTTP ${response.status}; trying private bot fallback`,
    );
  } catch (error) {
    console.warn(
      `[slack-shortcut] interaction response failed: ${errorText(error)}; trying private bot fallback`,
    );
  }
  return false;
}

async function slackBotApi(
  method: string,
  params: Record<string, string>,
): Promise<SlackApiResponse> {
  const config = getSlackToolConfig("bot");
  if (!config.enabled || !config.token)
    throw new Error("Slack bot account is not connected");
  return callSlackApi(method, params, config.token);
}

async function callSlackApi(
  method: string,
  params: Record<string, string | number | boolean>,
  token: string,
): Promise<SlackApiResponse> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(
      Object.entries(params).map(
        ([key, value]) => [key, String(value)] as [string, string],
      ),
    ),
    signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
  });
  const text = await readBoundedResponseText(
    response,
    MAX_SLACK_API_RESPONSE_BYTES,
    `Slack ${method}`,
  );
  let json: SlackApiResponse;
  try {
    json = JSON.parse(text) as SlackApiResponse;
  } catch {
    throw new Error(`Slack ${method} returned invalid JSON`);
  }
  if (!response.ok || !json.ok)
    throw new Error(
      `Slack ${method} failed: ${json.error ?? `HTTP ${response.status}`}`,
    );
  return json;
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label} response exceeded the ${maxBytes} byte limit`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `${label} response exceeded the ${maxBytes} byte limit`,
        );
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function clipText(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function clipInline(value: string, maxChars: number): string {
  return clipText(value.replace(/[\r\n[\]]+/g, " ").trim(), maxChars);
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      isPrivateHost(url.hostname)
    )
      return undefined;
    const host = url.hostname.toLowerCase();
    if (isSlackPrivateDownloadHost(host)) return undefined;
    const sensitiveQuery = [...url.searchParams.keys()].some((key) =>
      /(^|[-_])(sig(nature)?|token|key|expires?|x-amz|x-goog)([-_]|$)/i.test(
        key,
      ),
    );
    return sensitiveQuery ? undefined : url.toString();
  } catch {
    return undefined;
  }
}

function safeSlackPermalink(
  value: unknown,
  channelId: string,
): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    const expectedHost = SLACK_STATIC_CONFIG.workspaceHost.toLowerCase();
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.hostname.toLowerCase() === expectedHost &&
      url.pathname.startsWith(`/archives/${channelId}/p`)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "::1"
  )
    return true;
  const parts = host.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function fulfilled<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === "fulfilled" ? result.value : undefined;
}

function safeInline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 300);
}
