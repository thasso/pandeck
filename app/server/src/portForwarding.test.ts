import { randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  attachPortForwardSocket,
  PORT_FORWARD_MAX_FRAME_BYTES,
  PORT_FORWARD_MAX_QUEUED_BYTES,
  PortForwardGrantError,
  PortForwardGrantStore,
  PortForwardLease,
} from "./portForwarding.ts";

const servers: Array<{ close(callback: () => void): unknown }> = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("PortForwardGrantStore", () => {
  test("mints scoped expiring grants and revokes active leases", () => {
    let now = 1_000;
    const store = new PortForwardGrantStore(() => now, {
      grants: 2,
      connectionsPerGrant: 1,
      connections: 2,
      ttlMs: 500,
    });
    const grant = store.mint(8080);
    expect(grant).toMatchObject({ port: 8080 });
    expect(grant.token).not.toContain(grant.id);

    const lease = store.claim(grant.token);
    const terminate = vi.fn();
    lease.setTerminate(terminate);
    expect(() => store.claim(grant.token)).toThrow(PortForwardGrantError);

    expect(store.revoke(grant.id)).toBe(true);
    expect(terminate).toHaveBeenCalledOnce();
    expect(() => store.claim(grant.token)).toThrow(PortForwardGrantError);

    const expiring = store.mint(8081);
    now += 501;
    store.sweepExpired();
    expect(() => store.claim(expiring.token)).toThrow(PortForwardGrantError);
  });

  test.each([1023, 65_536, 8080.5, Number.NaN])(
    "rejects invalid port %s",
    (port) => {
      const store = new PortForwardGrantStore();
      expect(() => store.mint(port)).toThrow(PortForwardGrantError);
    },
  );

  test("bounds active grants and global connections", () => {
    const store = new PortForwardGrantStore(Date.now, {
      grants: 1,
      connectionsPerGrant: 2,
      connections: 1,
      ttlMs: 1_000,
    });
    const grant = store.mint(9000);
    expect(() => store.mint(9001)).toThrow(PortForwardGrantError);
    const lease = store.claim(grant.token);
    expect(() => store.claim(grant.token)).toThrow(PortForwardGrantError);
    lease.release();
    expect(store.claim(grant.token).port).toBe(9000);
  });
});

/** Server socket stand-in; `pausing` decides whether it has pause/resume. */
class FakeServerSocket extends EventEmitter {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Buffer[] = [];
  closed: { code: number; reason: string | undefined } | undefined;
  terminated = false;
  paused = false;
  pause?: () => void;
  resume?: () => void;

  constructor(pausing: boolean) {
    super();
    if (pausing) {
      this.pause = vi.fn(() => {
        this.paused = true;
      });
      this.resume = vi.fn(() => {
        this.paused = false;
      });
    }
  }

  send(data: Buffer, _options: unknown, callback: (error?: Error) => void) {
    this.sent.push(data);
    queueMicrotask(() => callback());
  }

  close(code: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 2;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  frame(data: Buffer | string): void {
    this.emit(
      "message",
      Buffer.isBuffer(data) ? data : Buffer.from(data),
      Buffer.isBuffer(data),
    );
  }
}

/** A target whose writes complete only when the test says so. */
class SlowTarget extends EventEmitter {
  readonly writes: Array<{ data: Buffer; done: (error?: Error) => void }> = [];
  destroyed = false;
  readonly pause = vi.fn();
  readonly resume = vi.fn();

  setNoDelay(): this {
    return this;
  }

  write(data: Buffer, done: (error?: Error) => void): boolean {
    this.writes.push({ data, done });
    return false;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  /** Completes the oldest write and returns its bytes. */
  drainOne(): Buffer {
    const next = this.writes.shift();
    if (!next) throw new Error("no pending target write");
    next.done();
    return next.data;
  }
}

function fakeBridge(pausing: boolean) {
  const ws = new FakeServerSocket(pausing);
  const target = new SlowTarget();
  const release = vi.fn();
  attachPortForwardSocket(
    ws as unknown as WebSocket,
    new PortForwardLease(9000, release),
    () => target as unknown as Socket,
  );
  return { ws, target, release };
}

describe("attachPortForwardSocket flow control", () => {
  test("without pause, frames queue in order behind a slow target", () => {
    const { ws, target } = fakeBridge(false);
    ws.frame(Buffer.from("early"));
    expect(target.writes).toHaveLength(0);
    target.emit("connect");
    const tiny = Array.from({ length: 1000 }, (_, index) =>
      Buffer.from([index % 251]),
    );
    for (const frame of tiny) ws.frame(frame);
    expect(target.writes).toHaveLength(1);

    // The queued frames were coalesced into one chunk.
    expect(target.drainOne().toString()).toBe("early");
    expect(target.drainOne().equals(Buffer.concat(tiny))).toBe(true);
    expect(target.writes).toHaveLength(0);
    expect(ws.closed).toBeUndefined();
  });

  test("without pause, a queue past the limit closes the socket", () => {
    const { ws, target, release } = fakeBridge(false);
    target.emit("connect");
    const frame = Buffer.alloc(PORT_FORWARD_MAX_FRAME_BYTES);
    // One frame in flight to the target, then a full queue behind it.
    const fitting = 1 + PORT_FORWARD_MAX_QUEUED_BYTES / frame.length;
    for (let index = 0; index < fitting; index += 1) ws.frame(frame);
    expect(ws.closed).toBeUndefined();

    ws.frame(Buffer.from([1]));
    expect(ws.closed?.code).toBe(1008);
    expect(target.destroyed).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    target.drainOne();
    expect(target.writes).toHaveLength(0);
  });

  test("without pause, an empty-frame flood retains nothing", () => {
    const { ws, target } = fakeBridge(false);
    target.emit("connect");
    ws.frame(Buffer.from("stalled"));
    const empty = Buffer.alloc(0);
    const heapBefore = process.memoryUsage().heapUsed;
    for (let index = 0; index < 1_000_000; index += 1) ws.frame(empty);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(
      64 * 1024 * 1024,
    );
    expect(ws.closed).toBeUndefined();

    target.drainOne();
    expect(target.writes).toHaveLength(0);
  });

  test("without pause, a one-byte-frame flood is closed at the byte cap", () => {
    const { ws, target } = fakeBridge(false);
    target.emit("connect");
    const heapBefore = process.memoryUsage().heapUsed;
    let frames = 0;
    while (!ws.closed && frames <= PORT_FORWARD_MAX_QUEUED_BYTES + 1) {
      ws.frame(Buffer.from([frames % 251]));
      frames += 1;
    }
    expect(ws.closed?.code).toBe(1008);
    // One byte in flight, the cap queued, and the frame that passed it.
    expect(frames).toBe(PORT_FORWARD_MAX_QUEUED_BYTES + 2);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(
      64 * 1024 * 1024,
    );
  });

  test("with pause, the reader waits for each target write", () => {
    const { ws, target } = fakeBridge(true);
    expect(ws.paused).toBe(true);
    target.emit("connect");
    expect(ws.paused).toBe(false);
    ws.frame(Buffer.from("a"));
    expect(ws.paused).toBe(true);
    target.drainOne();
    expect(ws.paused).toBe(false);
  });

  test.each([false, true])(
    "text and oversized frames close before any write (pausing: %s)",
    (pausing) => {
      const text = fakeBridge(pausing);
      text.target.emit("connect");
      text.ws.frame("must not reach TCP");
      expect(text.ws.closed?.code).toBe(1003);
      expect(text.target.writes).toHaveLength(0);

      const oversized = fakeBridge(pausing);
      oversized.target.emit("connect");
      oversized.ws.frame(Buffer.alloc(PORT_FORWARD_MAX_FRAME_BYTES + 1));
      expect(oversized.ws.closed?.code).toBe(1009);
      expect(oversized.target.writes).toHaveLength(0);
    },
  );

  test("target data is sent one bounded frame at a time", async () => {
    const { ws, target } = fakeBridge(false);
    target.emit("connect");
    const chunk = randomBytes(PORT_FORWARD_MAX_FRAME_BYTES * 2 + 5);
    target.emit("data", chunk);
    expect(target.pause).toHaveBeenCalledOnce();
    expect(ws.sent).toHaveLength(1);
    await vi.waitFor(() => expect(target.resume).toHaveBeenCalledOnce());
    expect(ws.sent.map((frame) => frame.length)).toEqual([
      PORT_FORWARD_MAX_FRAME_BYTES,
      PORT_FORWARD_MAX_FRAME_BYTES,
      5,
    ]);
    expect(Buffer.concat(ws.sent).equals(chunk)).toBe(true);
  });

  test("a target that refuses is closed with a reason the shell can show", () => {
    const refused = fakeBridge(false);
    refused.target.emit(
      "error",
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    );
    expect(refused.ws.closed).toEqual({
      code: 1011,
      reason: "nothing is listening on port 9000 there",
    });
    expect(refused.release).toHaveBeenCalledOnce();

    const unreachable = fakeBridge(false);
    unreachable.target.emit(
      "error",
      Object.assign(new Error("connect EADDRNOTAVAIL"), {
        code: "EADDRNOTAVAIL",
      }),
    );
    expect(unreachable.ws.closed?.reason).toBe(
      "could not connect to port 9000 there (EADDRNOTAVAIL)",
    );

    // Once connected, a target error aborts: the stream was already carried.
    const broken = fakeBridge(false);
    broken.target.emit("connect");
    broken.target.emit("error", new Error("read ECONNRESET"));
    expect(broken.ws.closed).toBeUndefined();
    expect(broken.ws.terminated).toBe(true);
  });

  test("a target that never connects is closed with a reason", () => {
    vi.useFakeTimers();
    try {
      const { ws } = fakeBridge(false);
      vi.advanceTimersByTime(10_000);
      expect(ws.closed).toEqual({
        code: 1011,
        reason: "timed out connecting to port 9000 there",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("each side's close first delivers what it already sent", async () => {
    const client = fakeBridge(false);
    client.target.emit("connect");
    client.ws.frame(Buffer.from("last"));
    client.ws.emit("close");
    expect(client.target.destroyed).toBe(false);
    expect(client.target.drainOne().toString()).toBe("last");
    expect(client.target.destroyed).toBe(true);

    const target = fakeBridge(false);
    target.target.emit("connect");
    target.target.emit("data", Buffer.from("bye"));
    target.target.emit("close");
    expect(target.ws.closed).toBeUndefined();
    await vi.waitFor(() => expect(target.ws.closed?.code).toBe(1000));
    expect(Buffer.concat(target.ws.sent).toString()).toBe("bye");
    expect(target.ws.terminated).toBe(false);
  });
});

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing listening address");
  return address.port;
}

async function listenTarget(server: Server): Promise<number> {
  servers.push(server);
  return listen(server);
}

/**
 * Bun's `ws` server sockets have no pause/resume, so under Bun only that mode
 * runs, on Bun's own socket. Under Node both run: the second hides Node's.
 */
const nodeSocketsPause = !process.versions.bun;
describe.each([
  { mode: "pausing", pausing: true },
  { mode: "non-pausing", pausing: false },
])("port forwarding over real sockets ($mode)", ({ pausing }) => {
  const skip = pausing && !nodeSocketsPause;

  /** Routes upgrades the way index.ts does. */
  async function bridgeTo(targetPort: number): Promise<string> {
    const store = new PortForwardGrantStore();
    const grant = store.mint(targetPort);
    const http = createHttpServer();
    const wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: PORT_FORWARD_MAX_FRAME_BYTES,
    });
    http.on("upgrade", (req, socket, head) => {
      const lease = store.claim(grant.token);
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (!pausing)
          Object.defineProperties(ws, {
            pause: { value: undefined },
            resume: { value: undefined },
          });
        attachPortForwardSocket(ws, lease);
      });
    });
    const port = await listen(http);
    // Under Bun, an HTTP server that served a WebSocket never calls back from
    // close(), so teardown does not wait for it.
    servers.push(wss, {
      close(callback) {
        http.close();
        http.closeAllConnections();
        callback();
      },
    });
    return `ws://127.0.0.1:${port}`;
  }

  test.skipIf(skip)(
    "a text frame is rejected before target bytes are written",
    async () => {
      const targetBytes: Buffer[] = [];
      const tcpServer = createServer((socket) => {
        socket.on("data", (chunk) => targetBytes.push(chunk));
      });
      const url = await bridgeTo(await listenTarget(tcpServer));
      const targetConnected = once(tcpServer, "connection");
      const client = new WebSocket(url);
      await once(client, "open");
      await targetConnected;
      client.send("must not reach TCP");
      const [code] = (await once(client, "close")) as [number];
      expect(code).toBe(1003);
      expect(Buffer.concat(targetBytes)).toHaveLength(0);
    },
  );

  test.skipIf(skip)(
    "a malformed frame closes the socket before target bytes are written",
    async () => {
      const targetBytes: Buffer[] = [];
      const tcpServer = createServer((socket) => {
        socket.on("data", (chunk) => targetBytes.push(chunk));
      });
      const url = new URL(await bridgeTo(await listenTarget(tcpServer)));
      const targetConnected = once(tcpServer, "connection");
      const raw = createConnection({ host: url.hostname, port: +url.port });
      await once(raw, "connect");
      raw.write(
        "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n" +
          "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`,
      );
      await once(raw, "data");
      await targetConnected;
      // RSV1 is set, but no extension was negotiated. (Bun does not check the
      // mask bit, so an unmasked frame is not a violation on both runtimes.)
      raw.write(Buffer.from([0xc2, 0x83, 0, 0, 0, 0, 1, 2, 3]));
      raw.resume();
      await once(raw, "close");
      expect(Buffer.concat(targetBytes)).toHaveLength(0);
    },
  );

  test.skipIf(skip)(
    "binary data round-trips and a large target write arrives in bounded frames",
    async () => {
      const reply = randomBytes(2 * 1024 * 1024);
      const tcpServer = createServer((socket) => {
        socket.once("data", (chunk) => {
          expect(chunk).toEqual(Buffer.from([0, 1, 2, 255]));
          socket.end(reply);
        });
      });
      const client = new WebSocket(
        await bridgeTo(await listenTarget(tcpServer)),
      );
      const frames: Buffer[] = [];
      client.on("message", (data: Buffer) => frames.push(data));
      await once(client, "open");
      client.send(Buffer.from([0, 1, 2, 255]));
      const [code] = (await once(client, "close")) as [number];
      expect(code).toBe(1000);
      expect(
        Math.max(...frames.map((frame) => frame.length)),
      ).toBeLessThanOrEqual(PORT_FORWARD_MAX_FRAME_BYTES);
      expect(Buffer.concat(frames).equals(reply)).toBe(true);
    },
  );

  test.skipIf(skip)("client bytes reach a slow target in order", async () => {
    const sent = randomBytes(PORT_FORWARD_MAX_QUEUED_BYTES / 2);
    const received: Buffer[] = [];
    const tcpServer = createServer((socket) => {
      socket.pause();
      setTimeout(() => socket.resume(), 200);
      socket.on("data", (chunk) => received.push(chunk));
    });
    const client = new WebSocket(await bridgeTo(await listenTarget(tcpServer)));
    await once(client, "open");
    for (let offset = 0; offset < sent.length; offset += 32 * 1024)
      client.send(sent.subarray(offset, offset + 32 * 1024));
    await vi.waitFor(
      () =>
        expect(Buffer.concat(received).length).toBeGreaterThanOrEqual(
          sent.length,
        ),
      { timeout: 10_000 },
    );
    expect(Buffer.concat(received).equals(sent)).toBe(true);
    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
    await once(client, "close");
  });

  test.skipIf(pausing)(
    "a client flooding a target that never reads is closed",
    async () => {
      const targets: Socket[] = [];
      const tcpServer = createServer((socket) => {
        socket.pause();
        targets.push(socket);
      });
      const client = new WebSocket(
        await bridgeTo(await listenTarget(tcpServer)),
      );
      await once(client, "open");
      const closed = once(client, "close") as Promise<[number]>;
      const frame = Buffer.alloc(32 * 1024);
      let sentBytes = 0;
      let open = true;
      void closed.then(() => (open = false));
      // Loopback socket buffers absorb several MiB before the queue fills.
      while (open && sentBytes < 256 * 1024 * 1024) {
        await new Promise<void>((resolve) =>
          client.send(frame, () => resolve()),
        );
        sentBytes += frame.length;
      }
      const [code] = await closed;
      for (const socket of targets) socket.destroy();
      expect(code).toBe(1008);
    },
  );
});
