import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { SpeechConversationSettings } from "@assistant/shared";
import { releaseChildOomScore } from "../childOomScore.ts";
import { errorText } from "../errors.ts";
import { connectSttWhenReady } from "./sttClient.ts";
import { resolveStreamingSttRuntime } from "./streamingSttConfig.ts";
import {
  StreamingSttConnection,
  type StreamingTranscript,
} from "./streamingSttClient.ts";

const RESTART_BACKOFF_MS = 5_000;
const MAX_STREAMS = 2;

const dependencies = {
  spawn,
  runtime: resolveStreamingSttRuntime,
  ready: connectSttWhenReady,
};

/** Owns the online model process, separately from the untouched offline engine. */
export class StreamingSttEngine {
  private child: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private ready = false;
  private port = 0;
  private notBefore = 0;
  private disposed = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private streams = new Set<StreamingSttConnection>();
  private holds = 0;
  private configuration = "";

  constructor(private readonly deps = dependencies) {}

  async open(
    settings: SpeechConversationSettings,
    onTranscript: (result: StreamingTranscript) => void,
    onError: (error: Error) => void,
    onDone: () => void,
  ): Promise<StreamingSttConnection> {
    if (this.disposed)
      throw new Error("Server is restarting; conversation is unavailable.");
    if (this.holds >= MAX_STREAMS)
      throw new Error(
        "The streaming recognizer is busy. Try again in a moment.",
      );
    const configuration = JSON.stringify([
      settings.modelId,
      settings.numThreads,
      settings.endpointSilenceSeconds,
    ]);
    if (this.holds > 0 && this.configuration !== configuration)
      throw new Error(
        "Stop active conversations before changing streaming recognizer settings.",
      );
    if (this.configuration !== configuration) {
      this.stopChild("Streaming settings changed.");
      this.configuration = configuration;
    }
    this.holds++;
    this.clearIdleTimer();
    let connection: StreamingSttConnection | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (connection) this.streams.delete(connection);
      this.holds--;
      this.scheduleIdle(settings);
    };
    try {
      if (!this.ready) {
        this.starting ??= this.start(settings).finally(() => {
          this.starting = undefined;
        });
        await this.starting;
      }
      if (this.disposed || !this.ready)
        throw new Error("Streaming recognizer is unavailable.");
      connection = new StreamingSttConnection(
        onTranscript,
        onError,
        onDone,
        release,
      );
      this.streams.add(connection);
      await connection.connect(`ws://127.0.0.1:${this.port}`);
      if (this.disposed || !this.ready)
        throw new Error("Streaming recognizer stopped while connecting.");
      return connection;
    } catch (error) {
      connection?.close();
      release();
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearIdleTimer();
    this.stopChild("Server shutting down.");
  }

  private async start(settings: SpeechConversationSettings): Promise<void> {
    const delay = this.notBefore - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.disposed) throw new Error("Server shutting down.");
    const runtime = await this.deps.runtime(settings);
    if (!runtime.ok) throw new Error(runtime.reason);
    if (this.disposed) throw new Error("Server shutting down.");
    this.port = 46_000 + Math.floor(Math.random() * 1_000);
    const child = this.deps.spawn(
      runtime.binary,
      [
        `--port=${this.port}`,
        `--tokens=${runtime.model.tokens}`,
        `--encoder=${runtime.model.encoder}`,
        `--decoder=${runtime.model.decoder}`,
        `--joiner=${runtime.model.joiner}`,
        `--num-threads=${settings.numThreads}`,
        "--num-work-threads=2",
        "--max-batch-size=1",
        "--decoding-method=greedy_search",
        "--enable-endpoint=true",
        `--rule2-min-trailing-silence=${settings.endpointSilenceSeconds}`,
        "--rule3-min-utterance-length=120",
        `--log-file=${process.env.ASSISTANT_STT_STREAMING_LOG?.trim() || join(process.env.TMPDIR?.trim() || "/tmp", "assistant-streaming-stt.log")}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    releaseChildOomScore(child.pid);
    this.child = child;
    let stderr = "";
    let spawnError: Error | undefined;
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("exit", () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.ready = false;
      this.notBefore = Date.now() + RESTART_BACKOFF_MS;
      // Socket closure tells each browser that its stream was interrupted.
      if (!this.disposed)
        console.warn("[streaming-stt] recognizer exited unexpectedly");
    });
    try {
      const probe = await this.deps.ready(
        `ws://127.0.0.1:${this.port}`,
        60_000,
        () =>
          !this.disposed &&
          !spawnError &&
          this.child === child &&
          child.exitCode === null &&
          child.signalCode === null,
      );
      probe.close();
      if (this.disposed || this.child !== child)
        throw new Error("Streaming recognizer stopped while starting.");
      this.ready = true;
    } catch (error) {
      this.stopChild("Streaming recognizer failed to start.");
      this.notBefore = Date.now() + RESTART_BACKOFF_MS;
      throw new Error(
        `${errorText(spawnError ?? error)} ${stderr.trim().split("\n").slice(-3).join(" ")}`.trim(),
      );
    }
  }

  private stopChild(reason: string): void {
    this.ready = false;
    for (const stream of this.streams) stream.close();
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    console.log(`[streaming-stt] ${reason}`);
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, 5_000);
    timer.unref();
  }

  private scheduleIdle(settings: SpeechConversationSettings): void {
    this.clearIdleTimer();
    if (
      this.disposed ||
      this.holds > 0 ||
      !this.child ||
      settings.idleShutdownSeconds <= 0
    )
      return;
    this.idleTimer = setTimeout(() => {
      if (this.holds === 0) this.stopChild("Idle timeout.");
    }, settings.idleShutdownSeconds * 1_000);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

export const streamingSttEngine = new StreamingSttEngine();
