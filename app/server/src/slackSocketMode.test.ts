import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "vitest";
import { WebSocket } from "ws";
import {
  MAX_SLACK_SOCKET_PAYLOAD_BYTES,
  SlackSocketModeClient,
  type SlackSocketEnvelope,
} from "./slackSocketMode.ts";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed.push({
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
    this.readyState = WebSocket.CLOSED;
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(
  overrides: Partial<
    ConstructorParameters<typeof SlackSocketModeClient>[0]
  > = {},
) {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const clock = { now: 1_000 };
  const client = new SlackSocketModeClient({
    appToken: "xapp-test",
    teamId: "T1",
    expectedUserId: () => "U1",
    enabled: () => true,
    openConnection: async () => "wss://example.test/socket",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimer: (callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return { id: timers.length } as unknown as NodeJS.Timeout;
    },
    clearTimer: () => undefined,
    now: () => clock.now,
    random: () => 0.5,
    logger: { info: () => undefined, warn: () => undefined },
    ...overrides,
  });
  return { client, sockets, timers, clock };
}

/** Fires the pending reconnect timer and settles the attempt it starts. */
async function reconnect(fx: ReturnType<typeof fixture>): Promise<void> {
  fx.timers.at(-1)!.callback();
  await flush();
}

function emitEnvelope(socket: FakeSocket, envelope: SlackSocketEnvelope): void {
  socket.emit("message", Buffer.from(JSON.stringify(envelope)));
}

describe("SlackSocketModeClient", () => {
  test("opens an outbound connection and acknowledges before dispatch", async () => {
    const { client, sockets } = fixture();
    const received: string[] = [];
    client.subscribe(async (envelope) => {
      received.push(envelope.envelope_id!);
    });
    client.start();
    await flush();
    const socket = sockets[0]!;
    socket.emit("open");
    emitEnvelope(socket, {
      envelope_id: "E1",
      type: "events_api",
      payload: { team_id: "T1", event: { user: "U1" } },
    });
    assert.deepEqual(socket.sent, [JSON.stringify({ envelope_id: "E1" })]);
    await flush();
    assert.deepEqual(received, ["E1"]);
    assert.equal(client.snapshot().state, "connected");
  });

  test("logs only a redacted authorized event label", async () => {
    const logs: string[] = [];
    const { client, sockets } = fixture({
      logger: {
        info: (...args: unknown[]) => logs.push(args.join(" ")),
        warn: () => undefined,
      },
    });
    client.start();
    await flush();
    const socket = sockets[0]!;
    socket.emit("open");
    emitEnvelope(socket, {
      envelope_id: "E1",
      type: "events_api",
      payload: {
        team_id: "T1",
        event: {
          type: "message",
          channel_type: "im",
          user: "U1",
          text: "top secret message",
        },
      },
    });
    await flush();
    assert.ok(
      logs.some((line) =>
        line.includes("received message.im from authorized user"),
      ),
    );
    assert.ok(logs.every((line) => !line.includes("top secret message")));
  });

  test("acknowledges retries but dispatches each envelope only once", async () => {
    const { client, sockets } = fixture();
    let calls = 0;
    client.subscribe(() => {
      calls++;
    });
    client.start();
    await flush();
    const socket = sockets[0]!;
    socket.emit("open");
    const envelope = {
      envelope_id: "E1",
      type: "interactive",
      payload: { team: { id: "T1" }, user: { id: "U1" } },
    };
    emitEnvelope(socket, envelope);
    emitEnvelope(socket, { ...envelope, retry_attempt: 1 });
    await flush();
    assert.equal(socket.sent.length, 2);
    assert.equal(calls, 1);
  });

  test("drops unexpected workspaces and users after acknowledging", async () => {
    const { client, sockets } = fixture();
    let calls = 0;
    client.subscribe(() => {
      calls++;
    });
    client.start();
    await flush();
    const socket = sockets[0]!;
    socket.emit("open");
    emitEnvelope(socket, {
      envelope_id: "wrong-team",
      payload: { team_id: "T2", event: { user: "U1" } },
    });
    emitEnvelope(socket, {
      envelope_id: "wrong-user",
      payload: { team_id: "T1", event: { user: "U2" } },
    });
    await flush();
    assert.equal(socket.sent.length, 2);
    assert.equal(calls, 0);
  });

  test("drops oversized untrusted envelopes before parsing or acknowledgement", async () => {
    const warnings: string[] = [];
    const { client, sockets } = fixture({
      logger: {
        info: () => undefined,
        warn: (...args: unknown[]) => warnings.push(args.join(" ")),
      },
    });
    let calls = 0;
    client.subscribe(() => {
      calls += 1;
    });
    client.start();
    await flush();
    const socket = sockets[0]!;
    socket.emit("open");
    socket.emit(
      "message",
      Buffer.from(
        `{"envelope_id":"large","padding":"${"x".repeat(MAX_SLACK_SOCKET_PAYLOAD_BYTES)}"}`,
      ),
    );
    await flush();
    assert.equal(socket.sent.length, 0);
    assert.equal(calls, 0);
    assert.ok(warnings.some((line) => line.includes("oversized envelope")));
  });

  test("backs off and reconnects after close", async () => {
    const { client, sockets, timers } = fixture();
    client.start();
    await flush();
    const first = sockets[0]!;
    first.emit("open");
    first.emit("close");
    assert.equal(client.snapshot().state, "reconnecting");
    assert.equal(timers.length, 1);
    assert.equal(timers[0]!.delay, 1000);
    timers[0]!.callback();
    await flush();
    assert.equal(sockets.length, 2);
  });

  test("escalates backoff across connections Slack refuses", async () => {
    const fx = fixture();
    fx.client.start();
    await flush();
    let socket = fx.sockets[0]!;
    // Slack refuses within a second of open and drops the socket ~10s later,
    // so opening must not clear the attempt counter.
    for (const [attemptWhileOpen, expectedDelay] of [
      [0, 1_000],
      [1, 2_000],
      [2, 4_000],
    ]) {
      socket.emit("open");
      emitEnvelope(socket, {
        type: "disconnect",
        reason: "too_many_websockets",
      });
      assert.equal(fx.client.snapshot().reconnectAttempt, attemptWhileOpen);
      fx.clock.now += 10_013;
      socket.emit("close", 1006);
      assert.equal(fx.timers.at(-1)!.delay, expectedDelay);
      await reconnect(fx);
      socket = fx.sockets.at(-1)!;
    }
  });

  test("clears the attempt counter only after a connection proves stable", async () => {
    const fx = fixture();
    fx.client.start();
    await flush();
    let socket = fx.sockets[0]!;
    socket.emit("open");
    fx.clock.now += 10_013;
    socket.emit("close", 1006);
    await reconnect(fx);
    socket = fx.sockets.at(-1)!;

    socket.emit("open");
    assert.equal(fx.client.snapshot().state, "connected");
    // The counter stays above zero while connected, until this close proves the
    // connection survived the ~5h refresh period.
    assert.equal(fx.client.snapshot().reconnectAttempt, 1);
    fx.clock.now += 18_003_318;
    emitEnvelope(socket, { type: "disconnect", reason: "warning" });
    socket.emit("close", 1000, Buffer.from("Slack requested reconnect"));
    assert.equal(fx.client.snapshot().reconnectAttempt, 1);
    assert.equal(fx.timers.at(-1)!.delay, 1_000);
  });

  test("treats a long-lived connection Slack refused as a failed attempt", async () => {
    const fx = fixture();
    fx.client.start();
    await flush();
    const socket = fx.sockets[0]!;
    socket.emit("open");
    emitEnvelope(socket, { type: "disconnect", reason: "link_disabled" });
    fx.clock.now += 18_003_318;
    socket.emit("close", 1006);
    assert.equal(fx.client.snapshot().reconnectAttempt, 1);
    await reconnect(fx);
    fx.sockets[1]!.emit("open");
    fx.clock.now += 10_013;
    fx.sockets[1]!.emit("close", 1006);
    assert.equal(fx.timers.at(-1)!.delay, 2_000);
  });

  test("clears the counter when a stable connection closes on an unknown reason", async () => {
    const fx = fixture();
    fx.client.start();
    await flush();
    fx.sockets[0]!.emit("open");
    fx.clock.now += 10_013;
    fx.sockets[0]!.emit("close", 1006);
    await reconnect(fx);
    assert.equal(fx.client.snapshot().reconnectAttempt, 1);

    // Only reasons we recognize as a refusal override the lifetime gate, so a
    // reason Slack adds or truncates cannot pin the counter at the ceiling.
    const socket = fx.sockets[1]!;
    socket.emit("open");
    fx.clock.now += 18_003_318;
    emitEnvelope(socket, { type: "disconnect" });
    socket.emit("close", 1000);
    assert.equal(fx.client.snapshot().reconnectAttempt, 1);
    assert.equal(fx.timers.at(-1)!.delay, 1_000);
  });

  test("still backs off when the handshake itself fails", async () => {
    const fx = fixture({
      openConnection: async () => {
        throw new Error("Slack Socket Mode HTTP 429");
      },
    });
    fx.client.start();
    await flush();
    assert.equal(fx.sockets.length, 0);
    assert.equal(fx.timers.at(-1)!.delay, 1_000);
    await reconnect(fx);
    assert.equal(fx.timers.at(-1)!.delay, 2_000);
    assert.ok(fx.client.snapshot().lastError?.includes("HTTP 429"));
  });

  test("logs the connection sequence, close code, reason and lifetime", async () => {
    const logs: string[] = [];
    let clock = 1_000;
    const { client, sockets, timers } = fixture({
      now: () => clock,
      logger: {
        info: (...args: unknown[]) => logs.push(args.join(" ")),
        warn: () => undefined,
      },
    });
    client.start();
    await flush();
    const first = sockets[0]!;
    first.emit("open");
    clock += 10_500;
    first.emit("close", 1006, Buffer.from("abnormal\nclosure"));
    assert.ok(
      logs.includes("[slack-socket] connected connection=1 attempt=0"),
      logs.join("\n"),
    );
    assert.ok(
      logs.includes(
        "[slack-socket] closed connection=1 code=1006 reason=abnormal closure lifetime=10500ms",
      ),
      logs.join("\n"),
    );

    timers[0]!.callback();
    await flush();
    sockets[1]!.emit("open");
    assert.ok(
      logs.includes("[slack-socket] connected connection=2 attempt=1"),
      logs.join("\n"),
    );
  });

  test("logs a close before the socket ever opened", async () => {
    const logs: string[] = [];
    const { client, sockets } = fixture({
      logger: {
        info: (...args: unknown[]) => logs.push(args.join(" ")),
        warn: () => undefined,
      },
    });
    client.start();
    await flush();
    sockets[0]!.emit("close", 1006);
    assert.ok(
      logs.includes(
        "[slack-socket] closed connection=none code=1006 reason=none lifetime=never-opened",
      ),
      logs.join("\n"),
    );
  });

  test("logs socket errors alongside the recorded status", async () => {
    const warnings: string[] = [];
    const { client, sockets } = fixture({
      logger: {
        info: () => undefined,
        warn: (...args: unknown[]) => warnings.push(args.join(" ")),
      },
    });
    client.start();
    await flush();
    const socket = sockets[0]!;
    socket.emit("open");
    socket.emit("error", new Error("read ECONNRESET"));
    assert.ok(
      warnings.some((line) =>
        line.includes("socket error connection=1: read ECONNRESET"),
      ),
      warnings.join("\n"),
    );
    assert.ok(client.snapshot().lastError?.includes("read ECONNRESET"));
  });

  test("logs the hello and disconnect envelopes Slack sends", async () => {
    const logs: string[] = [];
    const { client, sockets } = fixture({
      logger: {
        info: (...args: unknown[]) => logs.push(args.join(" ")),
        warn: () => undefined,
      },
    });
    let calls = 0;
    client.subscribe(() => {
      calls++;
    });
    client.start();
    await flush();
    const socket = sockets[0]!;
    socket.emit("open");
    emitEnvelope(socket, {
      type: "hello",
      num_connections: 3,
      debug_info: { approximate_connection_time: 18060 },
    });
    emitEnvelope(socket, { type: "disconnect", reason: "refresh_requested" });
    await flush();
    assert.ok(
      logs.includes(
        "[slack-socket] hello connection=1 num_connections=3 approximate_connection_time=18060",
      ),
      logs.join("\n"),
    );
    assert.ok(
      logs.includes(
        "[slack-socket] disconnect requested connection=1 reason=refresh_requested",
      ),
      logs.join("\n"),
    );
    assert.equal(socket.closed.length, 1);
    assert.equal(calls, 0);
  });

  test("does not connect without an app-level token", async () => {
    // What ASSISTANT_SLACK_APP_DISABLED=1 leaves behind in a PR preview: the
    // client must stay down and never reach apps.connections.open.
    let opened = 0;
    const untokened = fixture({
      appToken: "",
      openConnection: async () => {
        opened++;
        return "wss://example.test/socket";
      },
    });
    untokened.client.start();
    await flush();
    assert.equal(opened, 0);
    assert.equal(untokened.sockets.length, 0);
    assert.equal(untokened.client.snapshot().state, "disabled");
  });

  test("does not connect when disabled and closes on stop", async () => {
    const disabled = fixture({ enabled: () => false });
    disabled.client.start();
    await flush();
    assert.equal(disabled.sockets.length, 0);
    assert.equal(disabled.client.snapshot().state, "disabled");

    const active = fixture();
    active.client.start();
    await flush();
    active.client.stop();
    assert.equal(active.sockets[0]!.closed.length, 1);
    assert.equal(active.client.snapshot().state, "stopped");
  });
});
