import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { SLACK_STATIC_CONFIG } from "./config.ts";
import { errorText } from "./errors.ts";
import { getSlackRuntimeSettings } from "./slackSettings.ts";

export interface SlackSocketEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: Record<string, any>;
  retry_attempt?: number;
  retry_reason?: string;
  accepts_response_payload?: boolean;
  [key: string]: unknown;
}

export interface SlackSocketStatus {
  state: "disabled" | "connecting" | "connected" | "reconnecting" | "stopped";
  connectedAt?: number;
  lastEnvelopeAt?: number;
  lastError?: string;
  /**
   * Counts attempts since the last connection that proved itself, so it stays
   * above zero while `state` is "connected" until that connection survives
   * `MIN_STABLE_CONNECTION_MS`. Only a stable close clears it.
   */
  reconnectAttempt: number;
}

type EnvelopeHandler = (envelope: SlackSocketEnvelope) => void | Promise<void>;
type SocketLike = EventEmitter & {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

interface SlackSocketModeOptions {
  appToken: string;
  teamId: string;
  expectedUserId: () => string;
  enabled: () => boolean;
  openConnection?: (appToken: string) => Promise<string>;
  createSocket?: (url: string) => SocketLike;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  now?: () => number;
  random?: () => number;
  logger?: Pick<Console, "info" | "warn">;
}

const SEEN_ENVELOPE_TTL_MS = 60 * 60_000;
const MAX_SEEN_ENVELOPES = 10_000;
/**
 * How long a connection must live to count as established. Slack refuses a
 * connection within a second of open and drops it ~10s later, while a healthy
 * connection lives for the full ~5h refresh period, so anything in between
 * separates the two cleanly.
 */
const MIN_STABLE_CONNECTION_MS = 30_000;
/**
 * Disconnect reasons that mean Slack refused the connection rather than
 * retiring it on schedule. Deliberately an allowlist: an unknown or missing
 * reason on a connection that lived out its refresh period must still clear the
 * attempt counter, or one unrecognized reason would pin it at the ceiling for
 * the life of the process.
 */
const REFUSAL_DISCONNECT_REASONS = new Set([
  "too_many_websockets",
  "link_disabled",
]);
export const MAX_SLACK_SOCKET_PAYLOAD_BYTES = 1_000_000;

export class SlackSocketModeClient {
  private readonly options: Required<
    Omit<SlackSocketModeOptions, "openConnection" | "createSocket">
  > &
    Pick<SlackSocketModeOptions, "openConnection" | "createSocket">;
  private socket: SocketLike | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private desired = false;
  private connecting = false;
  private generation = 0;
  private handlers = new Set<EnvelopeHandler>();
  private seen = new Map<string, number>();
  private connectionSeq = 0;
  private status: SlackSocketStatus = { state: "stopped", reconnectAttempt: 0 };

  constructor(options: SlackSocketModeOptions) {
    this.options = {
      ...options,
      expectedUserId: options.expectedUserId,
      enabled: options.enabled,
      setTimer: options.setTimer ?? setTimeout,
      clearTimer: options.clearTimer ?? clearTimeout,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
      logger: options.logger ?? console,
    };
  }

  subscribe(handler: EnvelopeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  snapshot(): SlackSocketStatus {
    return { ...this.status };
  }

  start(): void {
    this.desired = true;
    if (!this.isConfiguredAndEnabled()) {
      this.status = { state: "disabled", reconnectAttempt: 0 };
      return;
    }
    void this.connect();
  }

  reconcile(): void {
    if (this.isConfiguredAndEnabled()) {
      this.start();
    } else {
      this.stop("Slack integration disabled");
      this.status = { state: "disabled", reconnectAttempt: 0 };
    }
  }

  stop(reason = "Server shutting down"): void {
    this.desired = false;
    this.generation++;
    this.connecting = false;
    if (this.reconnectTimer) this.options.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close(1000, reason);
    this.status = { ...this.status, state: "stopped", reconnectAttempt: 0 };
  }

  private isConfiguredAndEnabled(): boolean {
    return Boolean(
      this.options.appToken &&
      this.options.appToken.startsWith("xapp-") &&
      this.options.teamId &&
      this.options.enabled(),
    );
  }

  private async connect(): Promise<void> {
    if (
      !this.desired ||
      this.connecting ||
      this.socket ||
      !this.isConfiguredAndEnabled()
    )
      return;
    this.connecting = true;
    const generation = ++this.generation;
    this.status = {
      ...this.status,
      state: this.status.reconnectAttempt ? "reconnecting" : "connecting",
    };
    try {
      const url = await (
        this.options.openConnection ?? openSlackSocketConnection
      )(this.options.appToken);
      if (!this.desired || generation !== this.generation) return;
      const socket = (
        this.options.createSocket ??
        ((socketUrl) =>
          new WebSocket(socketUrl, {
            maxPayload: MAX_SLACK_SOCKET_PAYLOAD_BYTES,
          }) as SocketLike)
      )(url);
      this.socket = socket;
      const attempt = this.status.reconnectAttempt;
      let sequence = 0;
      let openedAt = 0;
      let refused = false;
      socket.on("open", () => {
        if (generation !== this.generation) return;
        this.connecting = false;
        openedAt = this.options.now();
        sequence = ++this.connectionSeq;
        // Opening proves nothing: Slack refuses a connection only after it is
        // open. The attempt counter is cleared on a stable close instead.
        this.status = {
          state: "connected",
          connectedAt: openedAt,
          reconnectAttempt: attempt,
        };
        this.options.logger.info(
          `[slack-socket] connected connection=${sequence} attempt=${attempt}`,
        );
      });
      socket.on("message", (data: WebSocket.RawData | string | Buffer) => {
        if (generation !== this.generation) return;
        if (this.onMessage(socket, data.toString())) refused = true;
      });
      socket.on("error", (error: Error) => {
        if (generation !== this.generation) return;
        this.status = { ...this.status, lastError: errorText(error) };
        this.options.logger.warn(
          `[slack-socket] socket error connection=${sequence || "none"}: ${errorText(error)}`,
        );
      });
      socket.on("close", (code?: number, reason?: Buffer | string) => {
        if (generation !== this.generation) return;
        this.socket = null;
        this.connecting = false;
        const lifetimeMs = openedAt ? this.options.now() - openedAt : null;
        this.options.logger.info(
          `[slack-socket] closed connection=${sequence || "none"} code=${code ?? "none"} reason=${logSafe(reason)} lifetime=${lifetimeMs === null ? "never-opened" : `${lifetimeMs}ms`}`,
        );
        if (
          !refused &&
          lifetimeMs !== null &&
          lifetimeMs >= MIN_STABLE_CONNECTION_MS
        )
          this.status = { ...this.status, reconnectAttempt: 0 };
        this.scheduleReconnect();
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.connecting = false;
      this.status = { ...this.status, lastError: errorText(error) };
      this.scheduleReconnect();
    }
  }

  /** Returns true when the envelope shows Slack refused this connection. */
  private onMessage(socket: SocketLike, raw: string): boolean {
    if (Buffer.byteLength(raw, "utf8") > MAX_SLACK_SOCKET_PAYLOAD_BYTES) {
      this.options.logger.warn("[slack-socket] ignored oversized envelope");
      return false;
    }
    let envelope: SlackSocketEnvelope;
    try {
      envelope = JSON.parse(raw) as SlackSocketEnvelope;
    } catch {
      this.options.logger.warn("[slack-socket] ignored malformed envelope");
      return false;
    }
    this.status = { ...this.status, lastEnvelopeAt: this.options.now() };
    if (envelope.envelope_id && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }
    if (envelope.type === "disconnect") {
      this.options.logger.info(
        `[slack-socket] disconnect requested connection=${this.connectionSeq} reason=${logSafe(envelope.reason)}`,
      );
      socket.close(1000, "Slack requested reconnect");
      return REFUSAL_DISCONNECT_REASONS.has(String(envelope.reason));
    }
    if (envelope.type === "hello") {
      const debugInfo = (envelope.debug_info ?? {}) as Record<string, unknown>;
      this.options.logger.info(
        `[slack-socket] hello connection=${this.connectionSeq} num_connections=${logSafe(envelope.num_connections)} approximate_connection_time=${logSafe(debugInfo.approximate_connection_time)}`,
      );
      return false;
    }
    if (
      !envelope.envelope_id ||
      this.wasSeen(envelope.envelope_id) ||
      !this.isAllowedEnvelope(envelope)
    )
      return false;
    this.remember(envelope.envelope_id);
    this.options.logger.info(
      `[slack-socket] received ${envelopeLabel(envelope)} from authorized user`,
    );
    for (const handler of this.handlers) {
      Promise.resolve(handler(envelope)).catch((error) =>
        this.options.logger.warn(
          "[slack-socket] envelope handler failed:",
          errorText(error),
        ),
      );
    }
    return false;
  }

  private isAllowedEnvelope(envelope: SlackSocketEnvelope): boolean {
    const payload = envelope.payload ?? {};
    const teamId = payload.team_id ?? payload.team?.id;
    if (teamId && teamId !== this.options.teamId) {
      this.options.logger.warn(
        "[slack-socket] ignored envelope from unexpected workspace",
      );
      return false;
    }
    const expectedUserId = this.options.expectedUserId();
    const userId = payload.user?.id ?? payload.user_id ?? payload.event?.user;
    if (expectedUserId && userId && userId !== expectedUserId) {
      this.options.logger.warn(
        "[slack-socket] ignored envelope from unexpected user",
      );
      return false;
    }
    return true;
  }

  private wasSeen(id: string): boolean {
    const seenAt = this.seen.get(id);
    return (
      seenAt !== undefined && this.options.now() - seenAt < SEEN_ENVELOPE_TTL_MS
    );
  }

  private remember(id: string): void {
    const now = this.options.now();
    this.seen.set(id, now);
    if (this.seen.size <= MAX_SEEN_ENVELOPES) return;
    for (const [key, seenAt] of this.seen) {
      if (
        now - seenAt >= SEEN_ENVELOPE_TTL_MS ||
        this.seen.size > MAX_SEEN_ENVELOPES
      )
        this.seen.delete(key);
      if (this.seen.size <= MAX_SEEN_ENVELOPES) break;
    }
  }

  private scheduleReconnect(): void {
    if (!this.desired || !this.isConfiguredAndEnabled() || this.reconnectTimer)
      return;
    const attempt = this.status.reconnectAttempt + 1;
    // The 30s ceiling holds even for a refused connection: Slack's refusal does
    // not track how many connections the app holds (we have been refused at one
    // and accepted at ten), so waiting longer buys nothing, and the marginal
    // cost of an attempt is a single apps.connections.open call.
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
    const delay = Math.round(base * (0.8 + this.options.random() * 0.4));
    this.status = {
      ...this.status,
      state: "reconnecting",
      reconnectAttempt: attempt,
    };
    this.reconnectTimer = this.options.setTimer(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}

const MAX_LOGGED_FIELD_CHARS = 120;

/** Renders an untrusted close reason or envelope field as one greppable token. */
function logSafe(value: unknown): string {
  if (value === undefined || value === null) return "none";
  const text = (Buffer.isBuffer(value) ? value.toString("utf8") : String(value))
    .replace(/[^\x20-\x7e]+/g, " ")
    .trim();
  if (!text) return "none";
  return text.length > MAX_LOGGED_FIELD_CHARS
    ? `${text.slice(0, MAX_LOGGED_FIELD_CHARS)}…`
    : text;
}

function envelopeLabel(envelope: SlackSocketEnvelope): string {
  const payload = envelope.payload ?? {};
  if (
    envelope.type === "events_api" &&
    typeof payload.event?.type === "string"
  ) {
    return payload.event.type === "message" &&
      typeof payload.event.channel_type === "string"
      ? `message.${payload.event.channel_type}`
      : payload.event.type;
  }
  if (
    envelope.type === "interactive" &&
    typeof payload.callback_id === "string"
  )
    return `shortcut ${payload.callback_id}`;
  return envelope.type || "envelope";
}

async function openSlackSocketConnection(appToken: string): Promise<string> {
  const response = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`Slack Socket Mode HTTP ${response.status}`);
  const json = JSON.parse(text) as {
    ok?: boolean;
    url?: string;
    error?: string;
  };
  if (!json.ok || !json.url)
    throw new Error(
      `Slack Socket Mode connection failed: ${json.error ?? "missing connection URL"}`,
    );
  return json.url;
}

export const slackSocketMode = new SlackSocketModeClient({
  appToken: SLACK_STATIC_CONFIG.appToken,
  teamId: SLACK_STATIC_CONFIG.teamId,
  expectedUserId: () => getSlackRuntimeSettings().accountUserId,
  enabled: () => getSlackRuntimeSettings().enabled,
});
