import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

interface ScheduledSpeech {
  source: AudioBufferSourceNode;
  text: string;
  start: number;
  end: number;
}

export interface SpeechPlayerOptions {
  onSpeaking: (speaking: boolean) => void;
  onError: (message: string) => void;
  voice?: string;
  speed?: number;
  /** Injectable browser boundaries for deterministic queue tests. */
  context?: AudioContext;
  fetch?: typeof fetch;
}

/** One synthesis fetch at a time, at most two decoded sentences scheduled.
 * Scheduling at the previous buffer's exact end avoids JS timer gaps. The next
 * fetch overlaps playback, not another fetch. stop invalidates even late decodes.
 */
export class SpeechPlayer {
  private readonly context: AudioContext;
  private readonly fetchAudio: typeof fetch;
  private queue: string[] = [];
  private scheduled: ScheduledSpeech[] = [];
  private request: AbortController | null = null;
  private generation = 0;
  private disposed = false;
  private recent: { text: string; until: number } | null = null;

  constructor(private readonly options: SpeechPlayerOptions) {
    this.context = options.context ?? new AudioContext();
    this.fetchAudio = options.fetch ?? fetch.bind(globalThis);
    void this.context.resume().catch((error: unknown) => {
      if (!this.disposed)
        options.onError(error instanceof Error ? error.message : String(error));
    });
  }

  get pending(): boolean {
    return (
      this.request !== null ||
      this.scheduled.length > 0 ||
      this.queue.length > 0
    );
  }

  get echoText(): string {
    const now = this.context.currentTime;
    return [
      ...(this.recent && this.recent.until >= now ? [this.recent.text] : []),
      ...this.scheduled
        .filter((item) => item.start <= now)
        .map((item) => item.text),
    ].join(" ");
  }

  enqueue(sentences: readonly string[]): void {
    if (this.disposed) return;
    if (this.queue.length + sentences.length > 128) {
      this.stop();
      this.options.onError(
        "Speech queue is full. Conversation playback stopped.",
      );
      return;
    }
    this.queue.push(...sentences);
    void this.pump();
  }

  stop(): void {
    this.generation++;
    this.request?.abort();
    this.request = null;
    this.queue = [];
    const active = this.echoText;
    if (active)
      this.recent = { text: active, until: this.context.currentTime + 1.5 };
    for (const item of this.scheduled) {
      item.source.onended = null;
      item.source.stop();
      item.source.disconnect();
    }
    this.scheduled = [];
    this.options.onSpeaking(false);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    void this.context.close().catch(() => {});
  }

  private async pump(): Promise<void> {
    if (
      this.disposed ||
      this.request ||
      this.scheduled.length >= 2 ||
      !this.queue.length
    )
      return;
    const generation = this.generation;
    const request = new AbortController();
    this.request = request;
    const text = this.queue.shift()!;
    try {
      const response = await this.fetchAudio(
        `${serverHttpOrigin()}/api/speech/synthesize`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            text,
            ...(this.options.voice ? { voice: this.options.voice } : {}),
            ...(this.options.speed !== undefined
              ? { speed: this.options.speed }
              : {}),
          }),
          signal: request.signal,
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          payload.error ??
            (response.status === 429
              ? "Speech synthesis is busy. Try again shortly."
              : `Speech synthesis failed (${response.status}).`),
        );
      }
      const buffer = await this.context.decodeAudioData(
        await response.arrayBuffer(),
      );
      if (this.disposed || generation !== this.generation) return;
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      const start = Math.max(
        this.context.currentTime,
        this.scheduled.at(-1)?.end ?? 0,
      );
      const item = { source, text, start, end: start + buffer.duration };
      this.scheduled.push(item);
      source.onended = () => {
        this.scheduled = this.scheduled.filter((entry) => entry !== item);
        this.recent = { text, until: this.context.currentTime + 1.5 };
        source.disconnect();
        if (!this.scheduled.length) this.options.onSpeaking(false);
        void this.pump();
      };
      source.start(start);
      this.options.onSpeaking(true);
    } catch (error) {
      if (generation === this.generation && !this.disposed) {
        this.stop();
        this.options.onError(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      if (this.request === request) this.request = null;
      if (generation === this.generation) void this.pump();
    }
  }
}
