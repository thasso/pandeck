import { spawn, type ChildProcess } from "node:child_process";
import {
  KOKORO_ENGLISH_VOICES,
  type SpeechSynthesisSettings,
} from "@assistant/shared";
import { releaseChildOomScore } from "../childOomScore.ts";
import { KOKORO_SIDECAR_PATH } from "../runtimeAssets.ts";
import { resolveTtsRuntime } from "./ttsConfig.ts";
import { TtsFrameReader, type TtsFrame } from "./ttsProtocol.ts";

export class TtsBusyError extends Error {}
interface Job {
  id: number;
  resolve: (pcm: Buffer) => void;
  reject: (error: Error) => void;
}
interface Worker {
  child: ChildProcess;
  ready: boolean;
  loaded: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  job?: Job;
}
const dependencies = { spawn, runtime: resolveTtsRuntime };

/** One model, one bounded sentence in flight. No session or utterance state. */
export class TtsEngine {
  private worker: Worker | undefined;
  private stopping: Promise<void> = Promise.resolve();
  private disposed = false;
  private busy = false;
  private threads = 0;
  private nextId = 0;
  private notBefore = 0;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps = dependencies) {}

  async synthesize(
    text: string,
    settings: SpeechSynthesisSettings,
    signal: AbortSignal,
  ): Promise<Buffer> {
    if (this.disposed)
      throw new Error("Server is restarting; speech synthesis is unavailable.");
    signal.throwIfAborted();
    if (this.busy)
      throw new TtsBusyError(
        "Speech synthesis is busy. Try again in a moment.",
      );
    const voice = KOKORO_ENGLISH_VOICES.find(
      (voice) => voice.name === settings.voice,
    );
    if (!voice) throw new Error("Unknown Kokoro voice.");
    this.busy = true;
    clearTimeout(this.idleTimer);
    let cancelTimer: NodeJS.Timeout | undefined;
    const cancel = () => {
      const worker = this.worker;
      if (!worker) return;
      if (!worker.ready || !worker.job)
        this.stop(new Error("Speech synthesis cancelled."));
      else {
        this.send(worker, { type: "cancel", id: worker.job.id });
        // A phonemizer or native call may not reach its callback. Never leave it
        // consuming CPU indefinitely after the browser has gone away.
        cancelTimer = setTimeout(
          () => this.stop(new Error("Speech synthesis cancelled.")),
          2000,
        );
        cancelTimer.unref();
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    let timeout: NodeJS.Timeout | undefined;
    try {
      if (this.threads !== settings.numThreads) {
        this.stop(new Error("Synthesis thread settings changed."));
        this.threads = settings.numThreads;
      }
      await this.stopping;
      signal.throwIfAborted();
      if (!this.worker) {
        if (this.notBefore > Date.now())
          await new Promise<void>((resolve, reject) => {
            const aborted = () => {
              clearTimeout(timer);
              reject(new Error("Speech synthesis cancelled."));
            };
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", aborted);
              resolve();
            }, this.notBefore - Date.now());
            signal.addEventListener("abort", aborted, { once: true });
          });
        signal.throwIfAborted();
        if (this.disposed) throw new Error("Server shutting down.");
        this.start(settings.numThreads);
      }
      const worker = this.worker!;
      timeout = setTimeout(
        () => this.fail(worker, new Error("Kokoro warm-up timed out.")),
        60000,
      );
      timeout.unref();
      await worker.loaded;
      clearTimeout(timeout);
      signal.throwIfAborted();
      if (this.disposed || this.worker !== worker)
        throw new Error("Kokoro stopped while starting.");
      const id = ++this.nextId;
      const result = new Promise<Buffer>((resolve, reject) => {
        worker.job = { id, resolve, reject };
      });
      timeout = setTimeout(
        () => this.fail(worker, new Error("Speech synthesis timed out.")),
        30000,
      );
      timeout.unref();
      this.send(worker, {
        type: "synthesize",
        id,
        text,
        sid: voice.sid,
        speed: settings.speed,
      });
      const pcm = await result;
      signal.throwIfAborted();
      return pcm;
    } finally {
      clearTimeout(timeout);
      clearTimeout(cancelTimer);
      signal.removeEventListener("abort", cancel);
      this.busy = false;
      if (!this.disposed && this.worker && settings.idleShutdownSeconds > 0) {
        this.idleTimer = setTimeout(
          () => this.stop(new Error("Kokoro idle timeout.")),
          settings.idleShutdownSeconds * 1000,
        );
        this.idleTimer.unref();
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    this.stop(new Error("Server shutting down."));
  }

  private start(threads: number): void {
    const runtime = this.deps.runtime();
    if (!runtime.ok) throw new Error(runtime.reason);
    const child = this.deps.spawn(
      runtime.python,
      [
        "-u",
        KOKORO_SIDECAR_PATH,
        "--model-dir",
        runtime.modelDir,
        "--threads",
        String(threads),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    releaseChildOomScore(child.pid);
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const loaded = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const worker: Worker = { child, ready: false, loaded, resolve, reject };
    this.worker = worker;
    const reader = new TtsFrameReader();
    child.stdout!.on("data", (chunk: Buffer) => {
      if (this.worker !== worker) return;
      try {
        reader.feed(chunk, (frame) => this.receive(worker, frame));
      } catch {
        this.fail(worker, new Error("Invalid Kokoro sidecar response."));
      }
    });
    // Drain, but do not retain native diagnostics: phonemizers can echo text.
    child.stderr!.on("data", () => {});
    child.stdin!.on("error", () =>
      this.fail(worker, new Error("Kokoro input pipe failed.")),
    );
    child.on("error", () =>
      this.fail(worker, new Error("Cannot start Kokoro Python sidecar.")),
    );
    child.on("exit", () =>
      this.fail(worker, new Error("Kokoro Python sidecar exited.")),
    );
  }

  private receive(worker: Worker, frame: TtsFrame): void {
    if (frame.type === "ready") {
      if (worker.ready) throw new Error("Duplicate Kokoro readiness.");
      worker.ready = true;
      worker.resolve();
      return;
    }
    const job = worker.job;
    if (!worker.ready || !job || job.id !== frame.id)
      throw new Error("Unexpected Kokoro response.");
    delete worker.job;
    if (frame.type === "audio") job.resolve(frame.pcm);
    else
      job.reject(
        new Error(
          frame.type === "cancelled"
            ? "Speech synthesis cancelled."
            : "Kokoro could not synthesize this sentence.",
        ),
      );
  }

  private send(worker: Worker, value: object): void {
    try {
      worker.child.stdin!.write(`${JSON.stringify(value)}\n`);
    } catch {
      this.fail(worker, new Error("Kokoro input pipe failed."));
    }
  }

  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.notBefore = Date.now() + 5000;
    this.stop(error);
  }

  private stop(error: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    worker.reject(error);
    worker.job?.reject(error);
    const child = worker.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    // Wait for exit before another model can spawn, even after cancellation.
    this.stopping = new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      timer.unref();
      const stopped = () => {
        clearTimeout(timer);
        child.off("exit", stopped);
        child.off("close", stopped);
        resolve();
      };
      child.once("exit", stopped);
      // Failed exec emits error + close, but no exit. It must not strand retry.
      child.once("close", stopped);
      child.kill("SIGTERM");
    });
  }
}

export const ttsEngine = new TtsEngine();
