import assert from "node:assert/strict";
import { test } from "vitest";
import { WebSocketServer } from "ws";
import {
  connectSttWhenReady,
  encodeSttFrames,
  encodeSttHeader,
  parseSttReply,
  SttConnection,
} from "./sttClient.ts";

test("the header carries the sample rate and the promised payload length", () => {
  const header = encodeSttHeader(16000, 6400);
  assert.equal(header.length, 8);
  assert.equal(header.readInt32LE(0), 16000);
  assert.equal(header.readInt32LE(4), 6400);
});

test("frames are a header plus the exact sample bytes, chunked", () => {
  // Long enough to span several chunks at the ~200 ms frame size.
  const samples = new Float32Array(16000 * 3);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 20);

  const frames = encodeSttFrames(samples, 16000);
  const header = frames[0]!;
  assert.equal(
    header.readInt32LE(4),
    samples.byteLength,
    "header must promise the real byte count",
  );
  assert.ok(
    frames.length > 2,
    "a 3 s utterance should be chunked, not one giant frame",
  );

  const body = Buffer.concat(frames.slice(1));
  assert.equal(
    body.length,
    samples.byteLength,
    "no sample may be dropped or duplicated",
  );
  assert.deepEqual(
    new Float32Array(body.buffer, body.byteOffset, samples.length),
    samples,
  );
});

test("replies parse from JSON, and a bare string degrades to itself", () => {
  assert.equal(
    parseSttReply('{"text":"hello there","timestamps":[0.1]}').text,
    "hello there",
  );
  assert.equal(parseSttReply("plain text reply").text, "plain text reply");
  assert.equal(parseSttReply('{"notext":true}').text, "");
});

/**
 * Round-trip against a stand-in that implements the recognizer's accumulate-then-
 * reply contract, so the framing is verified against a real socket rather than
 * just asserted on buffers. Also proves one connection serves several utterances.
 */
test("decodes over a socket that accumulates the promised bytes before replying", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const received: number[] = [];
  server.on("connection", (ws) => {
    let expected = 0;
    let got = 0;
    ws.on("message", (raw, isBinary) => {
      if (!isBinary) return;
      const chunk = raw as Buffer;
      if (expected === 0) {
        expected = chunk.readInt32LE(4);
        got = chunk.length - 8;
      } else {
        got += chunk.length;
      }
      if (got === expected) {
        received.push(expected);
        expected = 0;
        got = 0;
        ws.send(JSON.stringify({ text: `decoded ${received.length}` }));
      }
    });
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };

  const connection = new SttConnection(`ws://127.0.0.1:${port}`);
  try {
    await connection.connect();
    const first = await connection.decode(new Float32Array(8000), 16000);
    assert.equal(first.text, "decoded 1");
    const second = await connection.decode(new Float32Array(4000), 16000);
    assert.equal(second.text, "decoded 2");
    assert.deepEqual(received, [8000 * 4, 4000 * 4]);
  } finally {
    connection.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an empty utterance short-circuits instead of confusing the recognizer", async () => {
  const connection = new SttConnection("ws://127.0.0.1:1");
  assert.deepEqual(await connection.decode(new Float32Array(0), 16000), {
    text: "",
  });
});

test("decoding without a connection fails loudly", async () => {
  const connection = new SttConnection("ws://127.0.0.1:1");
  await assert.rejects(
    () => connection.decode(new Float32Array(10), 16000),
    /not open/,
  );
});

/**
 * Readiness waiting must not use a bare TCP probe: the recognizer logs a
 * connection that dies before the handshake as `[error] handle_read_handshake`,
 * which is misleading noise in the log you check when something is really wrong.
 * Retrying the real handshake means pre-listen attempts are refused by the kernel
 * and never reach it.
 */
test("retries the handshake until the recognizer starts listening", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  // Free the port again so the first attempts are refused, like a loading model.
  await new Promise((resolve) => server.close(resolve));

  let connections = 0;
  let late: WebSocketServer | undefined;
  const startLate = setTimeout(() => {
    late = new WebSocketServer({ port, host: "127.0.0.1" });
    late.on("connection", () => {
      connections += 1;
    });
  }, 600);

  try {
    const connection = await connectSttWhenReady(
      `ws://127.0.0.1:${port}`,
      20_000,
      () => true,
    );
    assert.equal(connection.open, true);
    // Exactly one connection reached the server: the successful one.
    assert.equal(connections, 1);
    connection.close();
  } finally {
    clearTimeout(startLate);
    if (late) await new Promise((resolve) => late!.close(resolve));
  }
});

test("gives up when the recognizer never listens", async () => {
  // Port 1 is privileged and closed, so every attempt is refused.
  await assert.rejects(
    () => connectSttWhenReady("ws://127.0.0.1:1", 300, () => true),
    /did not accept connections within/,
  );
});

test("stops waiting as soon as the recognizer process is gone", async () => {
  await assert.rejects(
    // A generous deadline must not be waited out when the child has died. The
    // message is the proof, not a stopwatch: burning the deadline raises the
    // "did not accept connections" error instead, so only the fail-fast branch
    // can produce this one.
    () => connectSttWhenReady("ws://127.0.0.1:1", 60_000, () => false),
    /exited before it was ready/,
  );
});
