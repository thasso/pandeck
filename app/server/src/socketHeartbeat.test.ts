import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startSocketHeartbeat } from "./socketHeartbeat.ts";

const INTERVAL_MS = 40;
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A server whose every socket runs the heartbeat; resolves each server-side socket. */
async function heartbeatServer(): Promise<{
  port: number;
  accepted: Promise<WebSocket>;
}> {
  const wss = new WebSocketServer({ noServer: true });
  const http: Server = createServer();
  let accept!: (ws: WebSocket) => void;
  const accepted = new Promise<WebSocket>((resolve) => (accept = resolve));
  http.on("upgrade", (req, socket, head) =>
    wss.handleUpgrade(req, socket, head, (ws) => {
      startSocketHeartbeat(ws, INTERVAL_MS);
      accept(ws);
    }),
  );
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  cleanups.push(() => {
    for (const ws of wss.clients) ws.terminate();
    http.close();
  });
  return { port: (http.address() as AddressInfo).port, accepted };
}

test("a socket that answers pings stays open", async () => {
  const { port, accepted } = await heartbeatServer();
  const client = new WebSocket(`ws://127.0.0.1:${port}/`);
  cleanups.push(() => client.terminate());
  const server = await accepted;
  let pings = 0;
  client.on("ping", () => pings++);
  await new Promise((r) => setTimeout(r, INTERVAL_MS * 5));
  assert.ok(pings >= 3, `expected repeated pings, got ${pings}`);
  assert.equal(server.readyState, WebSocket.OPEN);
});

test("a socket that stops answering is terminated after one missed ping", async () => {
  const { port, accepted } = await heartbeatServer();
  // A raw client that completes the handshake and then never reads or answers:
  // the half-open socket a suspended phone leaves behind.
  const raw = connect(port, "127.0.0.1", () =>
    raw.write(
      "GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    ),
  );
  raw.on("error", () => {});
  cleanups.push(() => raw.destroy());
  const server = await accepted;
  const started = Date.now();
  await once(server, "close");
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed >= INTERVAL_MS * 1.5,
    `closed after ${elapsed}ms, before a ping could go unanswered`,
  );
});
