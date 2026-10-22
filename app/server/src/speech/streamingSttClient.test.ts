import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { test } from "vitest";
import {
  parseStreamingReply,
  StreamingSttConnection,
  type StreamingTranscript,
} from "./streamingSttClient.ts";

test("validates online results without accepting offline or malformed replies", () => {
  assert.deepEqual(
    parseStreamingReply('{"text":"hello","segment":1,"is_final":false}'),
    { text: "hello", segment: 1, isFinal: false },
  );
  for (const frame of [
    '{"text":"offline"}',
    '{"text":1,"segment":0,"is_final":true}',
    '{"text":"x","segment":-1,"is_final":true}',
    "null",
    "Done!",
  ])
    assert.throws(() => parseStreamingReply(frame));
});

test("forwards float32 LE without offline header, finalizes Done, and releases once", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const updates: StreamingTranscript[] = [];
  const errors: Error[] = [];
  let closes = 0;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const audio: Buffer[] = [];
  server.on("connection", (ws) =>
    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        audio.push(Buffer.from(raw as Buffer));
        ws.send(JSON.stringify({ text: "hello", segment: 0, is_final: false }));
      } else {
        assert.equal(raw.toString(), "Done");
        ws.send("Done!");
      }
    }),
  );
  const client = new StreamingSttConnection(
    (update) => updates.push(update),
    (error) => errors.push(error),
    done,
    () => {
      closes++;
    },
  );
  try {
    await client.connect(`ws://127.0.0.1:${address.port}`);
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(-32768, 0);
    pcm.writeInt16LE(16384, 2);
    client.sendPcm16(pcm);
    client.finish();
    await finished;
    assert.equal(audio[0]?.length, 8);
    assert.equal(audio[0]?.readFloatLE(0), -1);
    assert.equal(audio[0]?.readFloatLE(4), 0.5);
    assert.deepEqual(updates, [
      { text: "hello", segment: 0, isFinal: false },
      { text: "hello", segment: 0, isFinal: true },
    ]);
    assert.deepEqual(errors, []);
    client.close();
    assert.equal(closes, 1);
    assert.throws(() => client.sendPcm16(pcm), /not accepting audio/);
  } finally {
    client.close();
    server.close();
    for (const ws of server.clients) ws.terminate();
  }
});

test("unexpected recognizer closure is reported and releases its hold", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let failed!: (error: Error) => void;
  const error = new Promise<Error>((resolve) => {
    failed = resolve;
  });
  let closes = 0;
  const client = new StreamingSttConnection(
    () => {},
    failed,
    () => {},
    () => {
      closes++;
    },
  );
  try {
    await client.connect(`ws://127.0.0.1:${address.port}`);
    for (const ws of server.clients) ws.close();
    assert.match((await error).message, /closed unexpectedly/);
    assert.equal(closes, 1);
  } finally {
    client.close();
    server.close();
  }
});
