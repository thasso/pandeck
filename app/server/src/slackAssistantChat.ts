import { errorText } from "./errors.ts";
import {
  enqueuePermanentAssistant,
  hasPermanentAssistantMessage,
  permanentAssistantIsBusy,
  subscribePermanentAssistant,
  type PermanentAssistantDelivery,
} from "./permanentAssistant.ts";
import {
  getSlackRuntimeSettings,
  getSlackToolConfig,
} from "./slackSettings.ts";
import {
  slackSocketMode,
  type SlackSocketEnvelope,
} from "./slackSocketMode.ts";

interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
}
let unsubscribeSocket: (() => void) | undefined;
let unsubscribeDelivery: (() => void) | undefined;
const acceptingEventKeys = new Set<string>();

export function startSlackAssistantChat(): void {
  if (!unsubscribeSocket)
    unsubscribeSocket = slackSocketMode.subscribe(handleSlackAssistantEnvelope);
  if (!unsubscribeDelivery)
    unsubscribeDelivery = subscribePermanentAssistant(handleDelivery);
}

export function stopSlackAssistantChat(): void {
  unsubscribeSocket?.();
  unsubscribeSocket = undefined;
  unsubscribeDelivery?.();
  unsubscribeDelivery = undefined;
}

export async function handleSlackAssistantEnvelope(
  envelope: SlackSocketEnvelope,
): Promise<void> {
  if (envelope.type !== "events_api") return;
  const payload = envelope.payload ?? {};
  const event = payload.event as SlackMessageEvent | undefined;
  const settings = getSlackRuntimeSettings();
  if (!event || event.type !== "message" || event.channel_type !== "im") return;
  if (
    event.subtype ||
    event.bot_id ||
    !event.channel ||
    !event.ts ||
    !event.text?.trim()
  )
    return;
  if (
    !settings.accountUserId ||
    event.user !== settings.accountUserId ||
    event.user === settings.botUserId
  )
    return;

  const dedupeKey = `slack:${payload.team_id ?? payload.team?.id ?? "team"}:${event.channel}:${event.ts}`;
  if (
    hasPermanentAssistantMessage(dedupeKey) ||
    acceptingEventKeys.has(dedupeKey)
  )
    return;
  acceptingEventKeys.add(dedupeKey);
  const queued = permanentAssistantIsBusy();
  let placeholderTs: string | undefined;
  try {
    const placeholder = await botApi("chat.postMessage", {
      channel: event.channel,
      text: queued
        ? "Queued — I’m finishing another request first…"
        : "Working on it…",
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
    });
    placeholderTs =
      typeof placeholder.ts === "string" ? placeholder.ts : undefined;
  } catch (error) {
    console.warn(
      `[slack-assistant] placeholder failed; request remains queued: ${errorText(error)}`,
    );
  }
  enqueuePermanentAssistant({
    dedupeKey,
    source: "slack",
    sourceMetadata: {
      channel: event.channel,
      messageTs: event.ts,
      threadTs: event.thread_ts,
      placeholderTs,
    },
    text: event.text.trim(),
  });
  acceptingEventKeys.delete(dedupeKey);
}

async function handleDelivery(
  delivery: PermanentAssistantDelivery,
): Promise<void> {
  if (
    delivery.item.source !== "slack" ||
    (delivery.state !== "completed" && delivery.state !== "failed")
  )
    return;
  const channel = stringMeta(delivery.item.sourceMetadata.channel);
  const ts = stringMeta(delivery.item.sourceMetadata.placeholderTs);
  if (!channel || !ts) return;
  const text =
    delivery.state === "failed"
      ? `I couldn’t complete that request. Please try again.\n\n_${slackMrkdwn(delivery.error ?? "Unknown error", 500)}_`
      : slackMrkdwn(delivery.response ?? "Done.", 39_000);
  await updatePlaceholderWithRetry(channel, ts, text);
}

async function botApi(
  method: string,
  params: Record<string, string>,
): Promise<Record<string, any>> {
  const config = getSlackToolConfig("bot");
  if (!config.enabled || !config.token)
    throw new Error("Slack bot account is not connected");
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params),
  });
  const json = JSON.parse(await response.text()) as {
    ok?: boolean;
    error?: string;
    [key: string]: any;
  };
  if (!response.ok || !json.ok)
    throw new Error(
      `Slack ${method} failed: ${json.error ?? `HTTP ${response.status}`}`,
    );
  return json;
}

async function updatePlaceholderWithRetry(
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await botApi("chat.update", { channel, ts, text });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4)
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

function stringMeta(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Convert the common Markdown emitted by models into Slack's mrkdwn dialect. */
export function slackMrkdwn(value: string, max: number): string {
  const clean = value
    .replace(
      /<personal-assistant-additional-instructions>[\s\S]*?<\/personal-assistant-additional-instructions>/gi,
      "",
    )
    .trim();
  const converted = clean
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
        .replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>")
        .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
        .replace(/__([^_\n]+)__/g, "*$1*")
        .replace(/~~([^~\n]+)~~/g, "~$1~");
    })
    .join("");
  return converted.length <= max
    ? converted
    : `${converted.slice(0, max - 1)}…`;
}
