import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import type {
  SpeechServerMessage,
  SpeechToTextSettings,
} from "@assistant/shared";
import {
  attachSpeechSocket,
  finalizeTranscript,
  maxUtteranceBytes,
  pcm16ToFloat32,
  type SpeechRecognizer,
  validateSpeechClientMessage,
} from "./speechSocket.ts";

function settings(
  overrides: Partial<SpeechToTextSettings> = {},
): SpeechToTextSettings {
  return {
    enabled: true,
    modelId: "",
    numThreads: 8,
    idleShutdownSeconds: 600,
    maxUtteranceSeconds: 120,
    vocabulary: [],
    ...overrides,
  };
}

test("accepts a well-formed start frame and rounds the sample rate", () => {
  const result = validateSpeechClientMessage({
    type: "start",
    utteranceId: "u1",
    sampleRate: 48000.4,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.msg, {
    type: "start",
    utteranceId: "u1",
    sampleRate: 48000,
  });
});

test("rejects frames the browser should never send", () => {
  const cases: unknown[] = [
    null,
    [],
    "start",
    { type: "start", sampleRate: 16000 },
    { type: "start", utteranceId: "u1" },
    { type: "start", utteranceId: "u1", sampleRate: "16000" },
    // Outside anything a browser AudioContext produces.
    { type: "start", utteranceId: "u1", sampleRate: 4000 },
    { type: "start", utteranceId: "u1", sampleRate: 192000 },
    { type: "resume", utteranceId: "u1" },
  ];
  for (const raw of cases) {
    assert.equal(
      validateSpeechClientMessage(raw).ok,
      false,
      `should reject ${JSON.stringify(raw)}`,
    );
  }
});

test("warm, stop, and cancel need only an utterance id", () => {
  assert.equal(
    validateSpeechClientMessage({ type: "warm", utteranceId: "u1" }).ok,
    true,
  );
  assert.equal(
    validateSpeechClientMessage({ type: "stop", utteranceId: "u1" }).ok,
    true,
  );
  assert.equal(
    validateSpeechClientMessage({ type: "cancel", utteranceId: "u1" }).ok,
    true,
  );
  assert.equal(validateSpeechClientMessage({ type: "warm" }).ok, false);
  assert.equal(validateSpeechClientMessage({ type: "stop" }).ok, false);
});

test("pcm16 decodes to float samples and ignores a trailing odd byte", () => {
  const buffer = Buffer.alloc(5);
  buffer.writeInt16LE(0, 0);
  buffer.writeInt16LE(32767, 2);
  buffer[4] = 0x7f; // half a sample from a truncated frame
  const samples = pcm16ToFloat32(buffer);
  assert.equal(samples.length, 2);
  assert.equal(samples[0], 0);
  assert.ok(Math.abs(samples[1]! - 1) < 0.0001);
});

test("pcm16 maps the full negative range without overflowing", () => {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16LE(-32768, 0);
  assert.equal(pcm16ToFloat32(buffer)[0], -1);
});

/**
 * A flat byte cap would reject legitimate long dictation from a 48 kHz
 * AudioContext (120 s = 11.52 MB), which is exactly what Safari hands us.
 */
test("the buffer cap scales with the declared sample rate", () => {
  const at16k = maxUtteranceBytes(16000, settings());
  const at48k = maxUtteranceBytes(48000, settings());
  assert.ok(
    at16k >= 120 * 16000 * 2,
    "16 kHz cap must cover the full utterance",
  );
  assert.ok(
    at48k >= 120 * 48000 * 2,
    "48 kHz cap must cover the full utterance",
  );
  assert.ok(
    at48k > 8 * 1024 * 1024,
    "48 kHz cap must exceed a naive flat 8 MB",
  );
  assert.equal(at48k, at16k * 3);
});

test("a shorter utterance setting lowers the cap", () => {
  assert.ok(
    maxUtteranceBytes(16000, settings({ maxUtteranceSeconds: 10 })) <
      maxUtteranceBytes(16000, settings()),
  );
});

test("finalizing trims and applies vocabulary rewrites", () => {
  const configured = settings({
    vocabulary: [{ from: "forge joe", to: "Forgejo" }],
  });
  assert.equal(
    finalizeTranscript("  Open a PR in forge joe.  ", configured),
    "Open a PR in Forgejo.",
  );
});

class FakeSpeechSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly sent: SpeechServerMessage[] = [];

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as SpeechServerMessage);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

test("warms the recognizer before microphone capture and releases it on cancel", async () => {
  const socket = new FakeSpeechSocket();
  let warmCalls = 0;
  let releases = 0;
  const recognizer: SpeechRecognizer = {
    beginWarmup: () => {
      warmCalls++;
      return {
        release: () => {
          releases++;
        },
      };
    },
    transcribe: async () => ({ text: "", decodeMs: 0 }),
  };

  attachSpeechSocket(socket as never, recognizer);
  socket.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "warm", utteranceId: "u1" })),
    false,
  );

  // Warming is never reported to the browser: recording and streaming go ahead
  // while the model loads, so a cold start is not a UI state.
  assert.equal(warmCalls, 1);
  assert.deepEqual(socket.sent, []);

  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify({ type: "start", utteranceId: "u1", sampleRate: 16000 }),
    ),
    false,
  );
  assert.deepEqual(socket.sent, [{ type: "accepted", utteranceId: "u1" }]);

  socket.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "cancel", utteranceId: "u1" })),
    false,
  );
  assert.equal(releases, 1);

  socket.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "warm", utteranceId: "u2" })),
    false,
  );
  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify({ type: "start", utteranceId: "u2", sampleRate: 16000 }),
    ),
    false,
  );
  socket.emit(
    "message",
    Buffer.from(JSON.stringify({ type: "stop", utteranceId: "u2" })),
    false,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    releases,
    2,
    "release after transcription so the usual idle timer can run",
  );
});
