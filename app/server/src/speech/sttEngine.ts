/**
 * Owns the one warm recognizer process.
 *
 * Loading the 631 MB int8 Parakeet model costs ~2 s, while decoding costs ~0.06×
 * realtime (a 10 s utterance is well under a second). Spawning a CLI per
 * utterance would therefore be dominated by model load, so the process is held
 * warm — but it also holds ~1.9 GB resident (up to ~2.6 GB after a long
 * utterance), so it is started lazily on the first dictation and shut down again
 * after an idle period.
 *
 * One decode at a time: there is a single model instance, and the recognizer
 * accumulates samples per connection. A short queue absorbs a second speaker
 * (desktop + phone) rather than failing them.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { SpeechToTextSettings } from "@assistant/shared";
import { errorText } from "../errors.ts";
import { releaseChildOomScore } from "../childOomScore.ts";
import {
  connectSttWhenReady,
  type SttConnection,
  type SttDecodeResult,
} from "./sttClient.ts";
import { resolveSttRuntime, sttLogPath } from "./sttConfig.ts";

/** Loopback port range for the recognizer; it only ever accepts local connections. */
const PORT_RANGE = { min: 45_000, max: 46_000 };
/** Model load budget, spent retrying the handshake. Generous: a cold page cache makes the first start slower. */
const READY_TIMEOUT_MS = 60_000;
/** How long a queued utterance may wait for the model before giving up. */
const QUEUE_TIMEOUT_MS = 120_000;
/** Queued utterances beyond the in-flight one; deeper than this is rejected. */
const MAX_QUEUE_DEPTH = 2;
/** Restart backoff after an unexpected exit, so a broken model cannot spin. */
const RESTART_BACKOFF_MS = 5_000;

interface QueueItem {
  samples: Float32Array;
  sampleRate: number;
  resolve: (result: SttDecodeResult) => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
}

export interface SttTranscribeResult {
  text: string;
  decodeMs: number;
}

/** A background warm-up reservation held while the browser is recording. */
export interface SttWarmup {
  /** Release the reservation when recording is cancelled or transcription ends. */
  release: () => void;
}

class SttEngine {
  private child: ChildProcess | undefined;
  private connection: SttConnection | undefined;
  private starting: Promise<void> | undefined;
  private queue: QueueItem[] = [];
  private draining = false;
  private idleTimer: NodeJS.Timeout | undefined;
  /** Active browser recordings that are waiting to submit an utterance. */
  private warmupHolds = 0;
  private notBefore = 0;
  private shuttingDown = false;
  private port = 0;

  /** True while a recognizer process is alive (warm). */
  get warm(): boolean {
    return Boolean(this.connection?.open);
  }

  /**
   * Transcribe one complete utterance, starting the recognizer if needed. A cold
   * model is the engine's problem, never the caller's: recording and streaming
   * happen regardless, and this simply waits for the load it already began at
   * {@link beginWarmup}.
   */
  async transcribe(
    samples: Float32Array,
    sampleRate: number,
    settings: SpeechToTextSettings,
  ): Promise<SttTranscribeResult> {
    if (this.shuttingDown)
      throw new Error("The server is restarting; dictation is unavailable.");
    if (samples.length === 0) return { text: "", decodeMs: 0 };
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      throw new Error(
        "The recognizer is busy with other dictation. Try again in a moment.",
      );
    }

    const started = Date.now();
    const result = await new Promise<SttDecodeResult>((resolve, reject) => {
      this.queue.push({
        samples,
        sampleRate,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      });
      void this.drain(settings);
    });
    return { text: result.text, decodeMs: Date.now() - started };
  }

  /**
   * Start loading the model as soon as recording begins, before the complete
   * utterance reaches {@link transcribe}. A held reservation prevents a short
   * idle timeout from releasing the model while the user is still speaking.
   * Warm-up errors stay background work; the eventual transcription returns the
   * actionable error to the client and may retry after the normal backoff.
   */
  beginWarmup(settings: SpeechToTextSettings): SttWarmup {
    const cold = !this.connection?.open;
    this.clearIdleTimer();
    this.warmupHolds++;
    let released = false;

    if (cold && !this.shuttingDown) {
      void this.ensureStarted(settings).then(
        () => {},
        (err) =>
          console.warn(`[stt] recognizer warm-up failed: ${errorText(err)}`),
      );
    }

    return {
      release: () => {
        if (released) return;
        released = true;
        this.warmupHolds = Math.max(0, this.warmupHolds - 1);
        this.scheduleIdleShutdown(settings);
      },
    };
  }

  /** Stop the recognizer and reject anything queued. Called on server shutdown. */
  async dispose(reason = "Server shutting down."): Promise<void> {
    this.shuttingDown = true;
    this.clearIdleTimer();
    this.warmupHolds = 0;
    const queued = this.queue;
    this.queue = [];
    for (const item of queued) item.reject(new Error(reason));
    this.stopChild(reason);
  }

  /** Serialize decodes: one at a time, in arrival order. */
  private async drain(settings: SpeechToTextSettings): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        if (Date.now() - item.enqueuedAt > QUEUE_TIMEOUT_MS) {
          item.reject(new Error("Timed out waiting for the recognizer."));
          continue;
        }
        try {
          const connection = await this.ensureStarted(settings);
          item.resolve(await connection.decode(item.samples, item.sampleRate));
        } catch (err) {
          // A failed decode usually means the child died; drop it so the next
          // utterance gets a fresh process rather than a dead socket.
          this.stopChild(`Decode failed: ${errorText(err)}`);
          item.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      this.draining = false;
      this.scheduleIdleShutdown(settings);
    }
  }

  /** Reuse the warm connection, or start a recognizer and connect to it. */
  private async ensureStarted(
    settings: SpeechToTextSettings,
  ): Promise<SttConnection> {
    this.clearIdleTimer();
    if (this.connection?.open) return this.connection;
    if (!this.starting)
      this.starting = this.start(settings).finally(() => {
        this.starting = undefined;
      });
    await this.starting;
    if (!this.connection?.open)
      throw new Error("The recognizer did not become ready.");
    return this.connection;
  }

  private async start(settings: SpeechToTextSettings): Promise<void> {
    const wait = this.notBefore - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    const runtime = resolveSttRuntime(settings);
    if (!runtime.ok) throw new Error(runtime.reason);

    const port = randomPort();
    const args = [
      `--port=${port}`,
      `--tokens=${runtime.model.tokens}`,
      `--encoder=${runtime.model.encoder}`,
      `--decoder=${runtime.model.decoder}`,
      `--joiner=${runtime.model.joiner}`,
      `--num-threads=${Math.max(1, Math.trunc(settings.numThreads))}`,
      "--num-work-threads=2",
      "--max-batch-size=1",
      `--max-utterance-length=${Math.max(1, Math.trunc(settings.maxUtteranceSeconds))}`,
      `--log-file=${sttLogPath()}`,
    ];

    const child = spawn(runtime.binary, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    releaseChildOomScore(child.pid);
    this.child = child;
    this.port = port;

    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2000);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.connection = undefined;
      // Back off so a model that cannot load does not respawn in a tight loop.
      this.notBefore = Date.now() + RESTART_BACKOFF_MS;
      if (!this.shuttingDown) {
        console.warn(
          `[stt] recognizer exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
        );
      }
    });

    let connection;
    try {
      // Waiting by retrying the real handshake keeps the recognizer's own log
      // clean; see connectSttWhenReady.
      connection = await connectSttWhenReady(
        `ws://127.0.0.1:${port}`,
        READY_TIMEOUT_MS,
        () => child.exitCode === null,
      );
    } catch (err) {
      this.stopChild("Recognizer failed to start.");
      const detail = stderrTail.trim().split("\n").slice(-3).join(" ").trim();
      throw new Error(
        `${errorText(err)}${detail ? ` Recognizer said: ${detail}` : ""}`,
      );
    }

    this.connection = connection;
    console.log(
      `[stt] recognizer ready on 127.0.0.1:${port} with model ${runtime.model.id}`,
    );
  }

  private stopChild(reason: string): void {
    this.connection?.close(reason);
    this.connection = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    // The recognizer exits promptly on SIGTERM; escalate only if it does not, so
    // a stuck child can never hold up a deploy's stop sequence.
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5_000);
    timer.unref();
  }

  private scheduleIdleShutdown(settings: SpeechToTextSettings): void {
    this.clearIdleTimer();
    const seconds = Math.trunc(settings.idleShutdownSeconds);
    if (seconds <= 0 || !this.child || this.warmupHolds > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.queue.length > 0 || this.draining || this.warmupHolds > 0)
        return;
      console.log(
        `[stt] recognizer idle for ${seconds}s on port ${this.port}; releasing memory`,
      );
      this.stopChild("Idle timeout.");
    }, seconds * 1000);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

/** Random loopback port; a collision just fails the start and is retried. */
function randomPort(): number {
  return (
    PORT_RANGE.min +
    Math.floor(Math.random() * (PORT_RANGE.max - PORT_RANGE.min))
  );
}

/** Process-wide singleton: one warm recognizer per server instance. */
export const sttEngine = new SttEngine();
