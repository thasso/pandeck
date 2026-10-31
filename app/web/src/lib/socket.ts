import type {
  ClientMessage,
  ServerMessage,
  TimelineCacheDescriptor,
} from "@assistant/shared";
import { createClientId } from "./clientId.ts";
import { devServerHost, withToken } from "./serverOrigin.ts";
import { ServerFrameReader } from "./serverFrames.ts";
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
 * How long a page coming back waits for any frame on its open socket before it
 * treats the socket as dead and replaces it. A frame normally arrives within one
 * round trip; a too-short wait only costs an unneeded reconnect.
 */
const LIVENESS_PROBE_TIMEOUT_MS = 1500;

/**
 * Whether a text frame is the `pong` answering probe `id`. Checked on ARRIVAL,
 * so a large frame still inflating ahead of it cannot delay the release.
 */
function answersProbe(data: unknown, id: string): boolean {
  if (typeof data !== "string" || data.length > 256) return false;
  try {
    const msg = JSON.parse(data) as ServerMessage;
    return msg.type === "pong" && msg.id === id;
  } catch {
    return false;
  }
}

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
  /** Set while a liveness probe waits for proof the open socket still works. */
  private probe: { id: string; timer: number } | undefined;
  private removeLifecycleListeners: (() => void) | undefined;

  constructor(private readonly url: string | (() => string)) {}

  connect(): void {
    this.closed = false;
    this.listenForResume();
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
    this.endProbe();
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

    ws.binaryType = "arraybuffer";
    const frames = new ServerFrameReader(
      (raw) => {
        if (this.ws === ws) this.dispatch(raw);
      },
      (error) => {
        if (this.ws !== ws) return;
        // Every later frame builds on the one lost: reconnect and resync.
        console.warn("[socket] unreadable server frame; reconnecting", error);
        ws.close();
      },
    );
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      // Only this probe's own pong proves the connection works now: any
      // other frame may have waited in the event queue since before suspension.
      if (this.probe && answersProbe(event.data, this.probe.id)) {
        this.socketProvedAlive();
        return;
      }
      frames.push(event.data as string | ArrayBuffer);
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

  private dispatch(raw: string): void {
    // The dev HUD needs the message SIZE and the parse cost, which only exist
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
    // Transport-only; a pong answering a superseded probe proves nothing.
    if (msg.type === "pong") return;
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
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.open();
    }, 1000);
  }

  /**
   * Make sure the socket works NOW: the page came back from the background or
   * the network returned. A suspended phone browser can leave its socket
   * reading as open long after the connection died, and the close only arrives
   * once the OS gives up, so everything sent meanwhile is lost. An open socket
   * is pinged and replaced unless that ping's pong arrives within
   * {@link LIVENESS_PROBE_TIMEOUT_MS}; a pending reconnect runs at once.
   */
  private checkLiveness(): void {
    if (this.closed) return;
    const ws = this.ws;
    if (!ws) {
      if (this.reconnectTimer === undefined) return;
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.open();
      return;
    }
    // A socket still connecting settles by itself; one probe at a time.
    if (ws.readyState !== WebSocket.OPEN || this.probe) return;
    const id = createClientId();
    ws.send(JSON.stringify({ type: "ping", id } satisfies ClientMessage));
    const timer = window.setTimeout(() => {
      this.probe = undefined;
      if (this.ws !== ws) return;
      // Detached first, so the dead socket's late close cannot schedule a
      // second reconnect. The status listeners see the held sends as unsent
      // (`unsentRequestIds`); they go out on the new socket.
      this.teardownActiveSocket();
      this.emitStatus(false);
      this.open();
    }, LIVENESS_PROBE_TIMEOUT_MS);
    this.probe = { id, timer };
  }

  private socketProvedAlive(): void {
    this.endProbe();
    const pending = this.queue;
    this.queue = [];
    for (const msg of pending) this.send(msg);
  }

  private endProbe(): void {
    if (!this.probe) return;
    window.clearTimeout(this.probe.timer);
    this.probe = undefined;
  }

  /**
   * Request ids of the writes still waiting in the send queue. They were never
   * transmitted, so losing the socket did not lose them: they go out on the
   * next one, and their mutations stay pending meanwhile.
   */
  unsentRequestIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const msg of this.queue)
      if ("requestId" in msg && typeof msg.requestId === "string")
        ids.add(msg.requestId);
    return ids;
  }

  private listenForResume(): void {
    if (this.removeLifecycleListeners || typeof document === "undefined")
      return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") this.checkLiveness();
    };
    const onResume = () => this.checkLiveness();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onResume);
    window.addEventListener("online", onResume);
    this.removeLifecycleListeners = () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onResume);
      window.removeEventListener("online", onResume);
    };
  }

  send(msg: ClientMessage): void {
    // While a probe is out the socket may be dead: hold sends until it answers
    // or is replaced, so nothing is written into a connection nobody reads.
    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.probe) {
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
    this.removeLifecycleListeners?.();
    this.removeLifecycleListeners = undefined;
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
  // socket just reconnects to it. Override the port/host with VITE_SERVER_ORIGIN,
  // or opt into the proxy with VITE_SERVER_PROXY (see `devServerHost`).
  // In prod the server serves the page itself, so the same origin is correct.
  if (import.meta.env.DEV) {
    return withToken(`${proto}://${devServerHost()}/ws${route}`);
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
