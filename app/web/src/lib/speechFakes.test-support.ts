import { vi } from "vitest";

export class FakeSpeechSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
  end() {
    this.onended?.();
  }
}

export class FakeSpeechContext {
  static instances: FakeSpeechContext[] = [];
  currentTime = 0;
  destination = {};
  sources: FakeSpeechSource[] = [];
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  decodeAudioData = vi.fn(async (_body: ArrayBuffer) => ({ duration: 2 }));
  constructor() {
    FakeSpeechContext.instances.push(this);
  }
  createBufferSource() {
    const source = new FakeSpeechSource();
    this.sources.push(source);
    return source;
  }
}

export function wavResponse() {
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(12) } as Response;
}

export async function flushSpeech() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
