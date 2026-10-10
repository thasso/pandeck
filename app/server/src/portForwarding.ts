import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { RawData, WebSocket } from "ws";
import type { PortForwardGrant } from "@assistant/shared/portForwarding";
import {
  PORT_FORWARD_MAX_PORT,
  PORT_FORWARD_MIN_PORT,
} from "@assistant/shared/portForwarding";

export const PORT_FORWARD_PATH = "/ws/port-forward";
const PORT_FORWARD_GRANT_TTL_MS = 24 * 60 * 60_000;
const PORT_FORWARD_MAX_GRANTS = 16;
const PORT_FORWARD_MAX_CONNECTIONS_PER_GRANT = 16;
const PORT_FORWARD_MAX_CONNECTIONS = 64;
export const PORT_FORWARD_MAX_FRAME_BYTES = 64 * 1024;
/** Client bytes one connection may hold while its target is not reading. */
export const PORT_FORWARD_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
/**
 * Queued bytes are copied into frame-sized chunks, so what a queue retains is
 * this many chunks however many frames filled them.
 */
const MAX_QUEUED_CHUNKS =
  PORT_FORWARD_MAX_QUEUED_BYTES / PORT_FORWARD_MAX_FRAME_BYTES;
const TARGET_HOST = "127.0.0.1";
const CONNECT_TIMEOUT_MS = 10_000;

function isPortForwardPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= PORT_FORWARD_MIN_PORT &&
    value <= PORT_FORWARD_MAX_PORT
  );
}

export class PortForwardGrantError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 404 | 409 | 429,
  ) {
    super(message);
  }
}

interface GrantRecord {
  id: string;
  token: string;
  port: number;
  expiresAtMs: number;
  leases: Set<PortForwardLease>;
  expiryTimer?: NodeJS.Timeout;
}

export class PortForwardLease {
  private released = false;
  private terminate: (() => void) | undefined;

  constructor(
    readonly port: number,
    private readonly onRelease: () => void,
  ) {}

  setTerminate(terminate: () => void): void {
    if (this.released) terminate();
    else this.terminate = terminate;
  }

  revoke(): void {
    this.terminate?.();
    this.release();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.terminate = undefined;
    this.onRelease();
  }
}

/** In-memory, restart-invalidated credentials for the binary forwarding socket. */
export class PortForwardGrantStore {
  private readonly byToken = new Map<string, GrantRecord>();
  private readonly byId = new Map<string, GrantRecord>();
  private activeConnections = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits = {
      grants: PORT_FORWARD_MAX_GRANTS,
      connectionsPerGrant: PORT_FORWARD_MAX_CONNECTIONS_PER_GRANT,
      connections: PORT_FORWARD_MAX_CONNECTIONS,
      ttlMs: PORT_FORWARD_GRANT_TTL_MS,
    },
  ) {}

  mint(port: number): PortForwardGrant {
    if (!isPortForwardPort(port)) {
      throw new PortForwardGrantError(
        `Port must be an integer from ${PORT_FORWARD_MIN_PORT} through ${PORT_FORWARD_MAX_PORT}.`,
        400,
      );
    }
    this.pruneExpired();
    if (this.byId.size >= this.limits.grants) {
      throw new PortForwardGrantError(
        "Too many active port-forward grants.",
        429,
      );
    }
    const record: GrantRecord = {
      id: randomBytes(12).toString("base64url"),
      token: randomBytes(32).toString("base64url"),
      port,
      expiresAtMs: this.now() + this.limits.ttlMs,
      leases: new Set(),
    };
    this.byId.set(record.id, record);
    this.byToken.set(record.token, record);
    record.expiryTimer = setTimeout(() => {
      if (this.byId.get(record.id) === record) this.remove(record);
    }, this.limits.ttlMs);
    record.expiryTimer.unref();
    return this.publicGrant(record);
  }

  claim(token: string | undefined): PortForwardLease {
    if (!token)
      throw new PortForwardGrantError("Missing forwarding grant.", 401);
    this.pruneExpired();
    const record = this.byToken.get(token);
    if (!record)
      throw new PortForwardGrantError("Invalid forwarding grant.", 401);
    if (record.leases.size >= this.limits.connectionsPerGrant) {
      throw new PortForwardGrantError(
        "This forwarding grant has too many active connections.",
        429,
      );
    }
    if (this.activeConnections >= this.limits.connections) {
      throw new PortForwardGrantError(
        "The server has too many active forwarded connections.",
        429,
      );
    }

    this.activeConnections += 1;
    const lease = new PortForwardLease(record.port, () => {
      if (record.leases.delete(lease)) this.activeConnections -= 1;
    });
    record.leases.add(lease);
    return lease;
  }

  revoke(id: string): boolean {
    const record = this.byId.get(id);
    if (!record) return false;
    this.remove(record);
    return true;
  }

  revokeAll(): void {
    for (const record of [...this.byId.values()]) this.remove(record);
  }

  get size(): number {
    this.pruneExpired();
    return this.byId.size;
  }

  sweepExpired(): void {
    this.pruneExpired();
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const record of [...this.byId.values()]) {
      if (record.expiresAtMs <= now) this.remove(record);
    }
  }

  private remove(record: GrantRecord): void {
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    this.byId.delete(record.id);
    this.byToken.delete(record.token);
    for (const lease of [...record.leases]) lease.revoke();
  }

  private publicGrant(record: GrantRecord): PortForwardGrant {
    return {
      id: record.id,
      token: record.token,
      port: record.port,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      expiresAtMs: record.expiresAtMs,
    };
  }
}

export function bearerGrant(
  authorization: string | undefined,
): string | undefined {
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length).trim();
  return token || undefined;
}

interface QueuedChunk {
  buffer: Buffer;
  length: number;
}

/** Normalize ws's accepted binary representations without decoding bytes. */
function binaryBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

/**
 * Why the target refused, as the close reason the shell shows the user. It
 * stays inside a close frame's 123 bytes.
 */
function targetRefusal(port: number, error: NodeJS.ErrnoException): string {
  return error.code === "ECONNREFUSED"
    ? `nothing is listening on port ${port} there`
    : `could not connect to port ${port} there (${error.code ?? "unknown error"})`;
}

/**
 * Bridge one authenticated WebSocket to the grant's fixed loopback port.
 *
 * Both directions keep one write in flight and read no further until it is
 * accepted. Node's `ws` server socket can stop reading frames (`pause`), so a
 * slow target backpressures the client over TCP. Bun's built-in `ws` cannot
 * (docs/deployment.md#bun-runtime-differences): its frames queue here instead,
 * and a connection whose queue passes `PORT_FORWARD_MAX_QUEUED_BYTES` is closed.
 */
export function attachPortForwardSocket(
  ws: WebSocket,
  lease: PortForwardLease,
  connect: (port: number) => Socket = (port) =>
    createConnection({ host: TARGET_HOST, port, allowHalfOpen: false }),
): void {
  const reader = ws as Partial<Pick<WebSocket, "pause" | "resume">>;
  const pauseReader = (): void => reader.pause?.call(ws);
  const resumeReader = (): void => reader.resume?.call(ws);
  const tcp = connect(lease.port);
  tcp.setNoDelay(true);
  // Do not let ws parse ahead while the target is connecting or while one target
  // write is backpressured. Without pause, frames wait in queuedForTarget
  // instead. Either way a text frame is classified before any of its payload
  // can reach the TCP socket.
  pauseReader();
  let settled = false;
  let connected = false;
  let connectTimer: NodeJS.Timeout | undefined;
  const queuedForTarget: QueuedChunk[] = [];
  let writingToTarget = false;
  let clientClosed = false;
  const pendingClientFrames: Buffer[] = [];
  let sendingToClient = false;
  let targetClosed = false;

  /** A `code` closes the WebSocket after the frames already sent; none aborts. */
  const close = (code?: number, reason?: string): void => {
    if (settled) return;
    settled = true;
    if (connectTimer) clearTimeout(connectTimer);
    queuedForTarget.length = 0;
    pendingClientFrames.length = 0;
    lease.release();
    tcp.destroy();
    if (code !== undefined && ws.readyState === ws.OPEN) {
      // A paused reader would never see the peer's closing frame.
      resumeReader();
      ws.close(code, reason);
    } else if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.terminate();
    }
  };
  const writeToTarget = (bytes: Buffer): void => {
    writingToTarget = true;
    tcp.write(bytes, (error) => {
      writingToTarget = false;
      if (error) close();
      else writeNextToTarget();
    });
  };
  const writeNextToTarget = (): void => {
    if (settled || writingToTarget || !connected) return;
    // At most MAX_QUEUED_CHUNKS entries, so shift() stays cheap.
    const next = queuedForTarget.shift();
    if (!next) {
      if (clientClosed) close();
      else resumeReader();
      return;
    }
    writeToTarget(next.buffer.subarray(0, next.length));
  };
  /** Appends to the open tail chunk; false once the queue would pass its cap. */
  const queueForTarget = (payload: Buffer): boolean => {
    for (let offset = 0; offset < payload.length;) {
      let tail = queuedForTarget.at(-1);
      if (!tail || tail.length === tail.buffer.length) {
        if (queuedForTarget.length >= MAX_QUEUED_CHUNKS) return false;
        tail = {
          buffer: Buffer.allocUnsafeSlow(PORT_FORWARD_MAX_FRAME_BYTES),
          length: 0,
        };
        queuedForTarget.push(tail);
      }
      const copied = payload.copy(tail.buffer, tail.length, offset);
      tail.length += copied;
      offset += copied;
    }
    return true;
  };
  const sendNextToClient = (): void => {
    if (settled || sendingToClient) return;
    const next = pendingClientFrames.shift();
    if (!next) {
      if (targetClosed) close(1000);
      else tcp.resume();
      return;
    }
    sendingToClient = true;
    try {
      ws.send(next, { binary: true, compress: false }, (error) => {
        sendingToClient = false;
        if (error) close();
        else sendNextToClient();
      });
    } catch {
      close();
    }
  };

  lease.setTerminate(close);
  if (settled) return;

  // A target that never connects is closed with a reason, because the shell
  // shows it to the user: their browser sees only a reset.
  connectTimer = setTimeout(
    () => close(1011, `timed out connecting to port ${lease.port} there`),
    CONNECT_TIMEOUT_MS,
  );
  connectTimer.unref();
  tcp.once("connect", () => {
    connected = true;
    if (connectTimer) clearTimeout(connectTimer);
    writeNextToTarget();
  });
  tcp.on("data", (chunk: Buffer) => {
    if (settled) return;
    tcp.pause();
    // Bun reads up to 512 KiB at a time; the shell accepts 64 KiB messages.
    for (
      let offset = 0;
      offset < chunk.length;
      offset += PORT_FORWARD_MAX_FRAME_BYTES
    )
      pendingClientFrames.push(
        chunk.subarray(offset, offset + PORT_FORWARD_MAX_FRAME_BYTES),
      );
    sendNextToClient();
  });
  ws.on("message", (data, isBinary) => {
    if (settled) return;
    if (!isBinary) {
      close(1003, "Forwarded data must be binary");
      return;
    }
    const payload = binaryBuffer(data);
    // Bun ignores the server's maxPayload, so the frame limit is checked here.
    if (payload.length > PORT_FORWARD_MAX_FRAME_BYTES) {
      close(1009, "Frame too large");
      return;
    }
    // An empty frame carries nothing, and queuing it would still cost memory.
    if (payload.length === 0) return;
    pauseReader();
    // A frame the target can take now is written as it is. Queued frames are
    // copied, so a flood of tiny ones cannot hold more than the cap.
    if (connected && !writingToTarget && queuedForTarget.length === 0)
      writeToTarget(payload);
    else if (!queueForTarget(payload))
      close(1008, "Forwarding target is not reading");
  });
  tcp.once("error", (error: NodeJS.ErrnoException) => {
    if (connected) close();
    else close(1011, targetRefusal(lease.port, error));
  });
  // The target's own end still delivers what it sent before it.
  tcp.once("close", () => {
    targetClosed = true;
    if (!sendingToClient && pendingClientFrames.length === 0) close(1000);
  });
  ws.once("error", () => close());
  // Frames the client sent before its close still reach the target.
  ws.once("close", () => {
    clientClosed = true;
    if (!writingToTarget && queuedForTarget.length === 0) close();
  });
}
