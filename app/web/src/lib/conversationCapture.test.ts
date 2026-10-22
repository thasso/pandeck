// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startConversationCapture } from "./conversationCapture.ts";
import { flushSpeech } from "./speechFakes.test-support.ts";

vi.mock("./speechCapture.ts", () => ({
  captureUnavailableReason: () => undefined,
  effectiveCaptureRate: (rate: number) => (rate === 48000 ? 16000 : rate),
}));
class Context {
  static current: Context;
  sampleRate = 44100;
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  audioWorklet = { addModule: vi.fn(async () => {}) };
  source = { connect: vi.fn(), disconnect: vi.fn() };
  createMediaStreamSource = vi.fn(() => this.source);
  constructor() {
    Context.current = this;
  }
}
class Worklet {
  static current: Worklet;
  port = {
    onmessage: null as
      ((event: { data: { type: string; frame: Int16Array } }) => void) | null,
  };
  disconnect = vi.fn();
  onprocessorerror: (() => void) | null = null;
  constructor() {
    Worklet.current = this;
  }
}
let track: {
  stop: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
};
let stream: MediaStream;
let abort: AbortController;
beforeEach(() => {
  track = { stop: vi.fn(), addEventListener: vi.fn() };
  stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Worklet);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => stream) },
  });
  abort = new AbortController();
});
afterEach(() => {
  abort.abort();
  vi.unstubAllGlobals();
});

it("captures with echo controls, continuously resamples and releases all audio resources", async () => {
  const onFrame = vi.fn();
  const stop = await startConversationCapture(abort.signal, onFrame, vi.fn());
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  Worklet.current.port.onmessage!({
    data: { type: "audio", frame: new Int16Array(8820) },
  });
  expect(onFrame).toHaveBeenCalledTimes(1);
  expect(onFrame.mock.calls[0]![0]).toHaveLength(3200);
  stop();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(Context.current.source.disconnect).toHaveBeenCalledOnce();
  expect(Worklet.current.port.onmessage).toBeNull();
  expect(Context.current.close).toHaveBeenCalledOnce();
});

it("does not leak a microphone granted after cancellation", async () => {
  let resolve!: (stream: MediaStream) => void;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = startConversationCapture(
    abort.signal,
    vi.fn(),
    vi.fn(),
  ).catch((failure: unknown) => failure);
  await flushSpeech();
  abort.abort();
  resolve(stream);
  const failure = await pending;
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("cancelled");
  expect(track.stop).toHaveBeenCalledOnce();
  expect(Context.current.createMediaStreamSource).not.toHaveBeenCalled();
});

it("closes the context on permission denial and reports processor failures", async () => {
  vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(
    new Error("Permission denied"),
  );
  await expect(
    startConversationCapture(abort.signal, vi.fn(), vi.fn()),
  ).rejects.toThrow("Permission denied");
  expect(Context.current.close).toHaveBeenCalled();
  const onError = vi.fn();
  await startConversationCapture(abort.signal, vi.fn(), onError);
  Worklet.current.onprocessorerror!();
  expect(onError).toHaveBeenCalledWith("Conversation audio capture failed.");
});
