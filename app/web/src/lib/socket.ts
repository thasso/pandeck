import type {
  ClientMessage,
  ServerMessage,
  TimelineCacheDescriptor,
} from "@assistant/shared";
import { withToken } from "./serverOrigin.ts";
import { sessionIdFromPathname } from "./sessionRoutes.ts";
import {
  perfStatsEnabled,
  recordServerMessage,
  recordSessionLoadMark,
  utf8Length,
} from "./perfStats.ts";

type Listener = (msg: ServerMessage) => void;
type StatusListener = (connected: boolean) => void;

/**
 * Thin auto-reconnecting WebSocket wrapper around the server protocol.
 */
export class AssistantSocket {
  private ws: WebSocket | undefined;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private queue: ClientMessage[] = [];
  private reconnectTimer: number | undefined;
  private closed = false;

  constructor(private readonly url: string | (() => string)) {}

  connect(): void {
    this.closed = false;
    // Already have a live (or pending) socket — don't open a second one. A
    // duplicate socket would stay registered as its own viewer server-side, so
    // every broadcast would be delivered twice and dispatched twice (duplicate
    // prompts, responses, commit cards and spinners during a turn).
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING ||
        this.ws.readyState === WebSocket.OPEN)
    )
      return;
    this.open();
  }

  /**
   * Detach and close the current socket (if any). Superseded sockets must have
   * their handlers cleared so a lingering connection can't keep feeding the
   * shared listener set or trigger its own reconnect after being replaced.
   */
  private teardownActiveSocket(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = undefined;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // Already closing/closed.
    }
  }

  private open(): void {
    // Never leave a previous socket open alongside a new one.
    this.teardownActiveSocket();
    const ws = new WebSocket(
      typeof this.url === "function" ? this.url() : this.url,
    );
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.emitStatus(true);
      const pending = this.queue;
      this.queue = [];
      for (const msg of pending) this.send(msg);
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      const raw = event.data as string;
      // The dev HUD needs the frame SIZE and the parse cost, which only exist
      // here (everything downstream sees the parsed object). Measured only
      // while the HUD is on: the UTF-8 count walks the whole frame.
      const measuring = perfStatsEnabled();
      const parseStart = measuring ? performance.now() : 0;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw) as ServerMessage;
      } catch {
        return;
      }
      if (measuring) {
        const parsedAt = performance.now();
        recordServerMessage(msg.type, utf8Length(raw), parsedAt - parseStart);
        if (msg.type === "snapshot")
          recordSessionLoadMark(
            "snapshotParsed",
            msg.snapshot.sessionId,
            parsedAt,
          );
      }
      for (const l of this.listeners) l(msg);
    };

    ws.onclose = () => {
      // Ignore a superseded socket's close; only the active socket drives
      // status + reconnect.
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.emitStatus(false);
      if (!this.closed) this.scheduleReconnect();
    };

    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, 1000);
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
    }
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private emitStatus(connected: boolean): void {
    for (const l of this.statusListeners) l(connected);
  }

  dispose(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.teardownActiveSocket();
  }
}

export function defaultSocketUrl(
  timelineCache?: TimelineCacheDescriptor,
): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const route = initialSessionRouteQuery(timelineCache);
  // In dev the page is served by Vite (e.g. :5173) and `/ws` is proxied to the
  // server. Connect straight to the server instead, so a Vite restart or crash
  // can't sever the live agent connection — the server keeps running and the
  // socket just reconnects to it. Override the port/host with VITE_SERVER_ORIGIN.
  // In prod the server serves the page itself, so the same origin is correct.
  if (import.meta.env.DEV) {
    const origin =
      import.meta.env.VITE_SERVER_ORIGIN ?? `${location.hostname}:8787`;
    return withToken(`${proto}://${origin}/ws${route}`);
  }
  return withToken(`${proto}://${location.host}/ws${route}`);
}

function initialSessionRouteQuery(
  timelineCache?: TimelineCacheDescriptor,
): string {
  const id = sessionIdFromPathname(location.pathname);
  if (!id) return "";
  const params = new URLSearchParams({ sessionId: id });
  if (
    timelineCache &&
    timelineCache.entryCount > 0 &&
    timelineCache.lastEntryId !== null &&
    timelineCache.lastEntrySeq !== null
  ) {
    params.set("tlv", String(timelineCache.projectionVersion));
    params.set("tlst", String(timelineCache.startIndex));
    params.set("tlc", String(timelineCache.entryCount));
    params.set("tlid", timelineCache.lastEntryId);
    params.set("tls", String(timelineCache.lastEntrySeq));
    params.set("tlf", timelineCache.fingerprint);
  }
  return `?${params.toString()}`;
}
