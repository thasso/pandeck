import { defineAgentTool, type ToolCallContext } from "../../mcp/tool.ts";
import { localDayBoundsMs } from "@assistant/shared/zonedTime";
import {
  getSlackHuddleConfig,
  type SlackHuddleConfig,
} from "../../slackSettings.ts";

type DetailLevel = "compact" | "standard" | "full";
type RawHuddle = Record<string, any>;
type Conversation = {
  id?: string;
  name?: string;
  user?: string;
  members?: string[];
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
};
type User = {
  id?: string;
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HISTORY_RESPONSE_BYTES = 2_000_000;
const MAX_ENRICHMENT_RESPONSE_BYTES = 256_000;
const MAX_ENRICHMENT_CALLS = 40;

export const slackHuddleHistoryTool = defineAgentTool<{
  date?: string;
  maxResults?: number;
  detailLevel?: DetailLevel;
}>({
  name: "slack_huddle_history",
  label: "Slack: Huddle history (experimental)",
  description:
    "Read bounded personal Slack Huddle attendance history through the separately enabled experimental browser-session capability. It answers only questions about actual Huddle attendance, participants, timing, or duration; unknown attendance or timing fields are uncertainty, not absence.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      date: {
        type: "string",
        description:
          "User-local day in YYYY-MM-DD format. Filters returned recent Huddles to that day.",
      },
      maxResults: {
        type: "number",
        description:
          "Maximum Huddles to return. Defaults to configured Slack limit, maximum 100.",
      },
      detailLevel: {
        type: "string",
        enum: ["compact", "standard", "full"],
        description:
          "compact is the bounded default; standard/full retain progressively more attendance evidence. Raw Slack objects are never returned.",
      },
    },
  } as const,
  async execute(params, ctx) {
    const config = getSlackHuddleConfig();
    const maxResults = clamp(
      params.maxResults ?? config.defaultMaxResults ?? 20,
      1,
      100,
    );
    const detailLevel = normalizeDetail(params.detailLevel);
    if (params.date && !ISO_DATE_RE.test(params.date))
      throw new Error("date must be YYYY-MM-DD.");

    const response = await fetchHuddles(config, maxResults, ctx.signal);
    const filtered = params.date
      ? filterByDate(response.huddles, params.date, config.timezone)
      : response.huddles;
    const selected = filtered.slice(0, maxResults);
    const enrichment = await enrichHuddles(selected, config, detailLevel, ctx);
    const huddles = selected.map((huddle, index) =>
      normalizeHuddle(huddle, index, config, enrichment, detailLevel),
    );

    const payload = {
      capability: "huddle_history",
      identity: {
        provider: "slack",
        credential: "experimental_browser_session",
        source: config.source,
        teamId: config.teamId,
        workspaceHost: config.workspaceHost,
        userOAuthEnrichment: Boolean(config.userToken),
      },
      experimental: true,
      date: params.date ?? null,
      returned: huddles.length,
      detailLevel,
      completeness: {
        historySource: "undocumented_slack_browser_api",
        resultLimit: maxResults,
        metadataEnrichment: !config.userToken
          ? "unavailable_without_personal_oauth"
          : enrichment.exhausted || enrichment.failedCalls > 0
            ? "partial"
            : "complete_for_returned_records",
        metadataCalls: enrichment.calls,
        metadataFailures: enrichment.failedCalls,
        metadataCallLimitReached: enrichment.exhausted,
        caveat:
          "Slack may omit attendance or end-time evidence; unknown values are preserved as unknown.",
      },
      huddles,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: payload,
    };
  },
});

export const assistantSlackHuddleTools = [slackHuddleHistoryTool];

/** One OWN Slack huddle attendance record for the day scanner. */
export interface OwnHuddleAttendance {
  id: string | null;
  channelId: string | null;
  /** Epoch seconds. */
  start: number | null;
  end: number | null;
  durationSeconds: number | null;
  /** joined/missed/unknown for the connected account only. */
  selfStatus: string;
  /** How many people were involved (participant history), for the report. */
  participantCount: number;
  /**
   * Who was in the huddle — the KEY context for what it was about (e.g. a 1:1
   * with a report → people management). Display names via personal OAuth
   * (best-effort); `self` flags the connected account.
   */
  participants: Array<{
    id: string;
    name: string | null;
    self: boolean;
    status: string;
  }>;
  huddleLink: string | null;
}

/** Resolve participant display names across the day's huddles via personal OAuth (bounded, best-effort). */
async function resolveHuddleParticipantNames(
  huddles: RawHuddle[],
  config: SlackHuddleConfig,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!config.userToken) return names;
  const ids = unique(huddles.flatMap((huddle) => participantIds(huddle)));
  let calls = 0;
  for (const id of ids) {
    if (calls >= MAX_ENRICHMENT_CALLS) break;
    calls += 1;
    try {
      const response = await personalApi(
        "users.info",
        { user: id },
        config.userToken,
        signal,
      );
      const user = response?.user as User | undefined;
      const label =
        user?.profile?.display_name ||
        user?.profile?.real_name ||
        user?.real_name ||
        user?.name;
      if (label) names.set(id, label);
    } catch {
      // Best-effort: a failed lookup leaves that id unnamed rather than failing.
    }
  }
  return names;
}

/**
 * Day-scan core (Task 171): the huddles I was in on one user-local day,
 * OWN attendance plus WHO ELSE was there (the primary signal for what the huddle
 * was about, for time-tracking). Participant DISPLAY NAMES are resolved via
 * personal OAuth (`users.info`, bounded) — the attendance privacy carve-out
 * (see dayScan CLAUDE.md): names + status only, never message content. Uses the
 * raw browser `huddles.history` fetch for the huddle list; self attendance needs
 * the connected `accountUserId` (else `unknown`).
 */
export async function collectOwnHuddleAttendanceForDay(
  config: SlackHuddleConfig,
  date: string,
  signal?: AbortSignal,
  maxResults = 50,
): Promise<OwnHuddleAttendance[]> {
  const limit = clamp(maxResults, 1, 100);
  const { huddles } = await fetchHuddles(config, limit, signal);
  const forDay = filterByDate(huddles, date, config.timezone);
  const names = await resolveHuddleParticipantNames(forDay, config, signal);
  return forDay.map((huddle) => {
    const start = normalizeEpoch(
      huddle.date_start ?? huddle.start_date ?? huddle.created ?? huddle.ts,
    );
    const end = normalizeEpoch(
      huddle.date_end ?? huddle.end_date ?? huddle.updated,
    );
    const ids = participantIds(huddle);
    return {
      id: stringValue(huddle.id),
      channelId: channelId(huddle) ?? null,
      start,
      end,
      durationSeconds:
        start !== null && end !== null && end >= start ? end - start : null,
      selfStatus: config.accountUserId
        ? participantStatus(config.accountUserId, huddle)
        : "unknown",
      participantCount: ids.length,
      participants: ids.map((id) => ({
        id,
        name: names.get(id) ?? null,
        self: Boolean(config.accountUserId && id === config.accountUserId),
        status: participantStatus(id, huddle),
      })),
      huddleLink: safeSlackLink(huddle.huddle_link, config.workspaceHost),
    };
  });
}

async function fetchHuddles(
  config: SlackHuddleConfig,
  limit: number,
  signal?: AbortSignal,
): Promise<{ huddles: RawHuddle[] }> {
  if (signal?.aborted) throw new Error("Slack Huddle request aborted.");
  const params = new URLSearchParams({
    limit: String(limit),
    slack_route: config.teamId,
  });
  const response = await fetch(
    `https://${config.workspaceHost}/api/huddles.history?${params}`,
    {
      headers: {
        Authorization: `Bearer ${config.clientToken}`,
        Cookie: `d=${config.clientCookieD}`,
        Accept: "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 assistant-slack-huddles/1.0",
        "X-Requested-With": "XMLHttpRequest",
      },
      ...(signal !== undefined ? { signal } : {}),
    },
  );
  const text = await readBoundedResponseText(
    response,
    MAX_HISTORY_RESPONSE_BYTES,
    signal,
    "Slack huddles.history",
  );
  if (!response.ok)
    throw new Error(`Slack huddles.history HTTP ${response.status}.`);
  let json: { ok?: boolean; error?: string; huddles?: RawHuddle[] };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new Error("Slack huddles.history returned invalid JSON.");
  }
  if (!json.ok)
    throw new Error(
      `Slack huddles.history failed: ${json.error ?? "unknown_error"}. Refresh the browser session in Settings → Slack Huddles.`,
    );
  return {
    huddles: Array.isArray(json.huddles) ? json.huddles.slice(0, limit) : [],
  };
}

type Enrichment = {
  users: Map<string, string>;
  conversations: Map<string, Conversation>;
  rooms: Map<string, Record<string, any>>;
  calls: number;
  failedCalls: number;
  exhausted: boolean;
};

async function enrichHuddles(
  huddles: RawHuddle[],
  config: SlackHuddleConfig,
  detail: DetailLevel,
  ctx: ToolCallContext,
): Promise<Enrichment> {
  const users = new Map<string, string>();
  const conversations = new Map<string, Conversation>();
  const rooms = new Map<string, Record<string, any>>();
  if (!config.userToken)
    return {
      users,
      conversations,
      rooms,
      calls: 0,
      failedCalls: 0,
      exhausted: false,
    };

  let calls = 0;
  let failedCalls = 0;
  let exhausted = false;
  const call = async (
    method: string,
    body: Record<string, string>,
  ): Promise<Record<string, any> | null> => {
    if (calls >= MAX_ENRICHMENT_CALLS) {
      exhausted = true;
      return null;
    }
    calls += 1;
    try {
      return await personalApi(method, body, config.userToken!, ctx.signal);
    } catch (error) {
      if (
        ctx.signal?.aborted ||
        (error instanceof SlackEnrichmentError && error.rateLimited)
      )
        throw error;
      failedCalls += 1;
      return null;
    }
  };

  if (detail !== "compact") {
    for (const huddle of huddles.slice(0, 10)) {
      const channel = channelId(huddle);
      const threadTs = stringValue(huddle.thread_root_ts);
      if (!channel || !threadTs) continue;
      const response = await call("conversations.replies", {
        channel,
        ts: threadTs,
        limit: "1",
        inclusive: "true",
      });
      const room = response?.messages?.[0]?.room;
      if (room && typeof room === "object") rooms.set(huddleKey(huddle), room);
    }
  }

  const channelIds = unique(huddles.map(channelId).filter(Boolean) as string[]);
  for (const id of channelIds) {
    const response = await call("conversations.info", {
      channel: id,
      include_num_members: "false",
    });
    if (response?.channel)
      conversations.set(id, response.channel as Conversation);
  }

  const userIds = new Set<string>();
  for (const huddle of huddles) {
    for (const id of participantIds(huddle, rooms.get(huddleKey(huddle))))
      userIds.add(id);
    const creator = stringValue(huddle.created_by);
    if (creator) userIds.add(creator);
  }
  for (const conversation of conversations.values()) {
    if (conversation.user) userIds.add(conversation.user);
    for (const id of conversation.members ?? []) userIds.add(id);
  }
  for (const id of userIds) {
    const response = await call("users.info", { user: id });
    const user = response?.user as User | undefined;
    const label =
      user?.profile?.display_name ||
      user?.profile?.real_name ||
      user?.real_name ||
      user?.name;
    if (label) users.set(id, label);
  }
  return { users, conversations, rooms, calls, failedCalls, exhausted };
}

async function personalApi(
  method: string,
  values: Record<string, string>,
  token: string,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  const body = new URLSearchParams(values);
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    ...(signal !== undefined ? { signal } : {}),
  });
  const text = await readBoundedResponseText(
    response,
    MAX_ENRICHMENT_RESPONSE_BYTES,
    signal,
    `Slack ${method}`,
  );
  if (!response.ok)
    throw new SlackEnrichmentError(
      `Slack ${method} HTTP ${response.status}`,
      response.status === 429,
    );
  let json: Record<string, any>;
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    throw new SlackEnrichmentError(
      `Slack ${method} returned invalid JSON`,
      false,
    );
  }
  if (!json.ok)
    throw new SlackEnrichmentError(
      `Slack ${method} failed: ${json.error ?? "unknown_error"}`,
      json.error === "ratelimited",
    );
  return json;
}

function normalizeHuddle(
  huddle: RawHuddle,
  index: number,
  config: SlackHuddleConfig,
  enrichment: Enrichment,
  detail: DetailLevel,
) {
  const start = normalizeEpoch(
    huddle.date_start ?? huddle.start_date ?? huddle.created ?? huddle.ts,
  );
  const end = normalizeEpoch(
    huddle.date_end ?? huddle.end_date ?? huddle.updated,
  );
  const channel = channelId(huddle);
  const room = enrichment.rooms.get(huddleKey(huddle));
  const ids = participantIds(huddle, room);
  const participants = ids.map((id) => ({
    id,
    label: enrichment.users.get(id) ?? id,
    status: participantStatus(id, huddle, room),
  }));
  const self = config.accountUserId
    ? participants.find(
        (participant) => participant.id === config.accountUserId,
      )
    : undefined;
  const conversation = channel
    ? enrichment.conversations.get(channel)
    : undefined;
  const common = {
    index,
    id: stringValue(huddle.id),
    start,
    end,
    startLocal: start ? formatEpoch(start, config.timezone) : null,
    endLocal: end ? formatEpoch(end, config.timezone) : null,
    durationMinutes:
      start && end && end >= start ? Math.round((end - start) / 60) : null,
    channelId: channel,
    conversation: conversation
      ? {
          id: conversation.id ?? channel,
          kind: conversationKind(conversation),
          label: conversationLabel(conversation, channel!, enrichment.users),
        }
      : channel
        ? { id: channel, kind: "unknown", label: channel }
        : null,
    huddleLink: safeSlackLink(huddle.huddle_link, config.workspaceHost),
    threadRootTs: stringValue(huddle.thread_root_ts),
    createdBy: stringValue(huddle.created_by),
    createdByLabel: huddle.created_by
      ? (enrichment.users.get(String(huddle.created_by)) ??
        String(huddle.created_by))
      : null,
    selfAttendance: config.accountUserId
      ? { userId: config.accountUserId, status: self?.status || "unknown" }
      : { status: "unknown", reason: "connected_user_id_unavailable" },
    participants,
    uncertainty: {
      startKnown: start !== null,
      endKnown: end !== null,
      selfAttendanceKnown: Boolean(self?.status && self.status !== "unknown"),
    },
  };
  if (detail === "compact") return common;
  const standard = {
    ...common,
    externalUniqueId: stringValue(huddle.external_unique_id),
    channelType: stringValue(huddle.channel_type),
    participantHistory: stringArray(huddle.participant_history),
    missedParticipantIds: Object.keys(objectValue(huddle.missed_participants)),
    inviteStatusByUser: normalizeStatusRecord(
      huddle.last_invite_status_by_user,
    ),
  };
  return detail === "full"
    ? {
        ...standard,
        participantEvents: normalizeParticipantEvents(
          room?.participants_events,
        ),
      }
    : standard;
}

function participantIds(
  huddle: RawHuddle,
  room?: Record<string, any>,
): string[] {
  return unique([
    ...stringArray(huddle.participant_history),
    ...Object.keys(objectValue(room?.participants_events)),
    ...Object.keys(objectValue(huddle.missed_participants)),
    ...Object.keys(objectValue(huddle.last_invite_status_by_user)),
  ]).slice(0, 100);
}

function participantStatus(
  id: string,
  huddle: RawHuddle,
  room?: Record<string, any>,
): string {
  const event = objectValue(room?.participants_events)[id] as
    Record<string, any> | undefined;
  if (event)
    return event.joined === true
      ? "joined"
      : event.joined === false
        ? "not_joined"
        : "unknown";
  if (stringArray(huddle.participant_history).includes(id)) return "joined";
  if (objectValue(huddle.missed_participants)[id]) return "missed";
  const invited = objectValue(huddle.last_invite_status_by_user)[id];
  return invited === undefined ? "unknown" : String(invited);
}

function filterByDate(
  huddles: RawHuddle[],
  date: string,
  timezone: string,
): RawHuddle[] {
  const bounds = localDayBoundsMs(date, timezone);
  const start = bounds.startMs / 1000;
  const end = bounds.endMs / 1000;
  return huddles.filter((huddle) => {
    const value = normalizeEpoch(
      huddle.date_start ??
        huddle.start_date ??
        huddle.created ??
        huddle.ts ??
        huddle.date_end ??
        huddle.end_date,
    );
    return value !== null && value >= start && value < end;
  });
}

function normalizeEpoch(value: unknown): number | null {
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    number < 1_500_000_000 ||
    number > 2_200_000_000_000
  )
    return null;
  return number > 10_000_000_000
    ? Math.floor(number / 1000)
    : Math.floor(number);
}
function formatEpoch(seconds: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(seconds * 1000));
}
function channelId(huddle: RawHuddle): string | undefined {
  const value = huddle.channels?.[0] ?? huddle.channel_id ?? huddle.channel;
  return stringValue(value) ?? undefined;
}
function huddleKey(huddle: RawHuddle): string {
  return (
    stringValue(huddle.id) ??
    `${channelId(huddle) ?? "unknown"}:${stringValue(huddle.thread_root_ts) ?? "unknown"}`
  );
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : null;
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, 100)
    : [];
}
function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function normalizeStatusRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(objectValue(value))
      .slice(0, 100)
      .map(([id, status]) => [id, String(status).slice(0, 100)]),
  );
}
function normalizeParticipantEvents(
  value: unknown,
): Record<
  string,
  { joined: boolean | null; start: number | null; end: number | null }
> {
  return Object.fromEntries(
    Object.entries(objectValue(value))
      .slice(0, 100)
      .map(([id, raw]) => {
        const event = objectValue(raw);
        return [
          id,
          {
            joined: typeof event.joined === "boolean" ? event.joined : null,
            start: normalizeEpoch(
              event.date_start ??
                event.start_date ??
                event.started ??
                event.start,
            ),
            end: normalizeEpoch(
              event.date_end ?? event.end_date ?? event.ended ?? event.end,
            ),
          },
        ];
      }),
  );
}
function unique(values: string[]): string[] {
  return [...new Set(values)];
}
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Number(value) || min)));
}
function normalizeDetail(value?: DetailLevel): DetailLevel {
  return value === "standard" || value === "full" ? value : "compact";
}
function conversationKind(conversation: Conversation): string {
  return conversation.is_im
    ? "dm"
    : conversation.is_mpim
      ? "group_dm"
      : conversation.is_private
        ? "private_channel"
        : "channel";
}
function conversationLabel(
  conversation: Conversation,
  fallback: string,
  users: Map<string, string>,
): string {
  if (conversation.is_im)
    return `DM with ${conversation.user ? (users.get(conversation.user) ?? conversation.user) : "unknown person"}`;
  if (conversation.is_mpim)
    return `group DM with ${(conversation.members ?? []).map((id) => users.get(id) ?? id).join(", ") || "unknown participants"}`;
  return conversation.name ? `#${conversation.name}` : fallback;
}
function safeSlackLink(value: unknown, workspaceHost: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === workspaceHost || url.hostname.endsWith(".slack.com"))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

class SlackEnrichmentError extends Error {
  constructor(
    message: string,
    readonly rateLimited: boolean,
  ) {
    super(message);
  }
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      `${label} response exceeded the ${maxBytes.toLocaleString("en-US")} byte safety limit.`,
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      if (signal?.aborted) throw new Error(`${label} request aborted.`);
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `${label} response exceeded the ${maxBytes.toLocaleString("en-US")} byte safety limit.`,
        );
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
