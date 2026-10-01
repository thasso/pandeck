/**
 * The `/ws/speech` trust boundary and per-connection utterance state machine.
 *
 * The browser streams audio *while* the user speaks (little-endian signed 16-bit
 * mono PCM in binary frames, bracketed by JSON `start`/`stop`), so a long
 * dictation is not one big upload at the end and a slow link overlaps transfer
 * with speech. The recognizer needs the total sample count up front, so the
 * complete utterance is buffered here and decoded once on `stop`.
 *
 * The browser keeps its own authoritative copy of the audio and falls back to
 * `POST /api/speech/transcribe` if this socket dies mid-utterance, so there is
 * deliberately no resume protocol, no acks, and no partial-buffer retention.
 */
import type { WebSocket } from "ws";
import type {
  SpeechClientMessage,
  SpeechServerMessage,
  SpeechToTextSettings,
} from "@assistant/shared";
import { applySpeechVocabulary } from "@assistant/shared";
import { errorText } from "../errors.ts";
import { getSettings } from "../settings.ts";
import {
  sttEngine,
  type SttTranscribeResult,
  type SttWarmup,
} from "./sttEngine.ts";

/** Rates a browser `AudioContext` can plausibly produce. */
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 48_000;
/** Headroom over the exact utterance bound (a tenth), for frame granularity. */
const BUFFER_HEADROOM_DIVISOR = 10;

/** Validate one inbound JSON frame. Returns the reason it was rejected, if it was. */
export function validateSpeechClientMessage(
  raw: unknown,
): { ok: true; msg: SpeechClientMessage } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, reason: "not an object" };
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== "string")
    return { ok: false, reason: "missing type" };
  if (typeof msg.utteranceId !== "string" || !msg.utteranceId)
    return { ok: false, reason: "missing utteranceId" };

  switch (msg.type) {
    case "warm":
      return { ok: true, msg: { type: "warm", utteranceId: msg.utteranceId } };
    case "start": {
      const rawRate = msg.sampleRate;
      if (typeof rawRate !== "number" || !Number.isFinite(rawRate))
        return { ok: false, reason: "sampleRate must be a number" };
      // Round BEFORE bounding: a browser may report 48000.0000001, which is a
      // legitimate 48 kHz context, not an out-of-range rate.
      const rate = Math.round(rawRate);
      if (rate < MIN_SAMPLE_RATE || rate > MAX_SAMPLE_RATE) {
        return {
          ok: false,
          reason: `sampleRate must be between ${MIN_SAMPLE_RATE} and ${MAX_SAMPLE_RATE}`,
        };
      }
      return {
        ok: true,
        msg: { type: "start", utteranceId: msg.utteranceId, sampleRate: rate },
      };
    }
    case "stop":
      return { ok: true, msg: { type: "stop", utteranceId: msg.utteranceId } };
    case "cancel":
      return {
        ok: true,
        msg: { type: "cancel", utteranceId: msg.utteranceId },
      };
    default:
      return { ok: false, reason: `unknown type "${msg.type}"` };
  }
}

/** Int16 PCM → float32 in [-1, 1), which is what the recognizer consumes. */
export function pcm16ToFloat32(buffer: Buffer): Float32Array {
  const count = Math.floor(buffer.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = buffer.readInt16LE(i * 2) / 32768;
  return out;
}

/**
 * Byte ceiling for one utterance: the configured seconds at the declared rate,
 * plus headroom. Derived rather than a flat constant — a flat 8 MB would wrongly
 * reject a legitimate 120 s utterance from a 48 kHz `AudioContext` (11.5 MB).
 */
export function maxUtteranceBytes(
  sampleRate: number,
  settings: SpeechToTextSettings,
): number {
  // Integer arithmetic: scaling by 1.1 in floating point leaves fuzz that makes
  // the cap non-proportional to the rate.
  const exact =
    Math.ceil(Math.max(1, settings.maxUtteranceSeconds) * sampleRate) * 2;
  return exact + Math.ceil(exact / BUFFER_HEADROOM_DIVISOR);
}

/** Apply post-decode vocabulary rules and trim recognizer padding. */
export function finalizeTranscript(
  text: string,
  settings: SpeechToTextSettings,
): string {
  return applySpeechVocabulary(text.trim(), settings.vocabulary);
}

/** Minimal recognizer seam: keeps socket-state tests independent of a real model process. */
export interface SpeechRecognizer {
  beginWarmup(settings: SpeechToTextSettings): SttWarmup;
  transcribe(
    samples: Float32Array,
    sampleRate: number,
    settings: SpeechToTextSettings,
  ): Promise<SttTranscribeResult>;
}

/** One browser connection: at most one utterance in flight, buffered in memory. */
class SpeechSession {
  private utteranceId: string | undefined;
  private sampleRate = 16_000;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private decoding = false;
  /** The recording id that owns the background model-load reservation. */
  private warmupUtteranceId: string | undefined;
  private releaseWarmup: (() => void) | undefined;

  constructor(
    private readonly ws: WebSocket,
    private readonly recognizer: SpeechRecognizer,
  ) {}

  handleJson(raw: unknown): void {
    const result = validateSpeechClientMessage(raw);
    if (!result.ok) {
      this.send({
        type: "error",
        message: `Rejected speech frame: ${result.reason}`,
      });
      this.ws.close(1008, "Invalid speech frame");
      return;
    }
    const msg = result.msg;
    switch (msg.type) {
      case "warm":
        return this.onWarm(msg.utteranceId);
      case "start":
        return this.onStart(msg.utteranceId, msg.sampleRate);
      case "stop":
        return void this.onStop(msg.utteranceId);
      case "cancel":
        return this.reset();
    }
  }

  handleBinary(chunk: Buffer): void {
    if (!this.utteranceId) {
      this.send({
        type: "error",
        message: "Audio arrived before a start frame.",
      });
      this.ws.close(1008, "Audio before start");
      return;
    }
    const limit = maxUtteranceBytes(this.sampleRate, this.settings());
    if (this.bytes + chunk.length > limit) {
      this.send({
        type: "error",
        utteranceId: this.utteranceId,
        message: "That dictation was too long.",
      });
      this.reset();
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  dispose(): void {
    this.reset();
  }

  /** Begin warming before microphone capture has discovered its sample rate. */
  private onWarm(utteranceId: string): void {
    if (this.decoding || this.utteranceId) {
      this.send({
        type: "error",
        utteranceId,
        message: "A dictation is already in progress.",
      });
      return;
    }
    if (this.warmupUtteranceId === utteranceId) return;
    if (this.warmupUtteranceId) {
      this.send({
        type: "error",
        utteranceId,
        message: "A dictation is already preparing.",
      });
      return;
    }
    const settings = this.settings();
    if (!settings.enabled) {
      this.send({
        type: "error",
        utteranceId,
        message: "Dictation is disabled in settings.",
      });
      return;
    }
    const warmup = this.recognizer.beginWarmup(settings);
    this.warmupUtteranceId = utteranceId;
    this.releaseWarmup = warmup.release;
  }

  private onStart(utteranceId: string, sampleRate: number): void {
    if (this.decoding) {
      this.send({
        type: "error",
        utteranceId,
        message: "The previous dictation is still being transcribed.",
      });
      return;
    }
    if (this.utteranceId) {
      this.send({
        type: "error",
        utteranceId,
        message: "A dictation is already in progress.",
      });
      return;
    }
    const settings = this.settings();
    if (!settings.enabled) {
      this.releaseCurrentWarmup();
      this.send({
        type: "error",
        utteranceId,
        message: "Dictation is disabled in settings.",
      });
      return;
    }
    // `start` remains valid without `warm`; this path just cannot overlap model
    // loading with browser microphone setup.
    if (!this.warmupUtteranceId) {
      const warmup = this.recognizer.beginWarmup(settings);
      this.warmupUtteranceId = utteranceId;
      this.releaseWarmup = warmup.release;
    } else if (this.warmupUtteranceId !== utteranceId) {
      this.send({
        type: "error",
        utteranceId,
        message: "A different dictation is already preparing.",
      });
      return;
    }
    this.utteranceId = utteranceId;
    this.sampleRate = sampleRate;
    this.chunks = [];
    this.bytes = 0;
    this.send({ type: "accepted", utteranceId });
  }

  private async onStop(utteranceId: string): Promise<void> {
    if (this.utteranceId !== utteranceId) {
      this.send({
        type: "error",
        utteranceId,
        message: "No matching dictation is in progress.",
      });
      return;
    }
    const settings = this.settings();
    const samples = pcm16ToFloat32(Buffer.concat(this.chunks));
    const sampleRate = this.sampleRate;
    const audioMs = Math.round((samples.length / sampleRate) * 1000);
    this.chunks = [];
    this.bytes = 0;
    this.utteranceId = undefined;
    this.decoding = true;
    try {
      const result = await this.recognizer.transcribe(
        samples,
        sampleRate,
        settings,
      );
      this.send({
        type: "transcript",
        utteranceId,
        text: finalizeTranscript(result.text, settings),
        audioMs,
        decodeMs: result.decodeMs,
      });
    } catch (err) {
      this.send({ type: "error", utteranceId, message: errorText(err) });
    } finally {
      this.decoding = false;
      this.releaseCurrentWarmup();
    }
  }

  private reset(): void {
    this.utteranceId = undefined;
    this.chunks = [];
    this.bytes = 0;
    this.releaseCurrentWarmup();
  }

  private releaseCurrentWarmup(): void {
    const release = this.releaseWarmup;
    this.warmupUtteranceId = undefined;
    this.releaseWarmup = undefined;
    release?.();
  }

  private settings(): SpeechToTextSettings {
    return getSettings().speechToText;
  }

  private send(msg: SpeechServerMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }
}

/** Wire one accepted `/ws/speech` connection to its own session. */
export function attachSpeechSocket(
  ws: WebSocket,
  recognizer: SpeechRecognizer = sttEngine,
): void {
  const session = new SpeechSession(ws, recognizer);
  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      session.handleBinary(
        Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer),
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      ws.close(1008, "Invalid speech frame");
      return;
    }
    session.handleJson(parsed);
  });
  ws.on("close", () => session.dispose());
  ws.on("error", () => session.dispose());
}
