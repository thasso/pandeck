// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { SpeechPlayer } from "./speechPlayer.ts";
import {
  FakeSpeechContext,
  flushSpeech,
  wavResponse,
} from "./speechFakes.test-support.ts";

const players: SpeechPlayer[] = [];
afterEach(() => {
  players.forEach((player) => player.dispose());
  players.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup(fetchAudio = vi.fn<typeof fetch>(async () => wavResponse())) {
  const context = new FakeSpeechContext();
  const onSpeaking = vi.fn();
  const onError = vi.fn();
  const player = new SpeechPlayer({
    context: context as unknown as AudioContext,
    fetch: fetchAudio,
    onSpeaking,
    onError,
    voice: "bm_lewis",
    speed: 1.2,
  });
  players.push(player);
  return { player, context, fetchAudio, onSpeaking, onError };
}

it("binds the browser fetch receiver rather than invoking it as a player method", async () => {
  const context = new FakeSpeechContext();
  const onError = vi.fn();
  const browserFetch = vi.fn(function (this: unknown) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(wavResponse());
  });
  vi.stubGlobal("fetch", browserFetch);
  const player = new SpeechPlayer({
    context: context as unknown as AudioContext,
    onSpeaking: vi.fn(),
    onError,
  });
  players.push(player);
  player.enqueue(["Hello."]);
  await flushSpeech();
  expect(browserFetch).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  expect(context.sources).toHaveLength(1);
});

it("fetches sequentially, pipelines one ahead and schedules without a gap", async () => {
  const { player, context, fetchAudio, onSpeaking } = setup();
  player.enqueue(["First.", "Second.", "Third."]);
  expect(fetchAudio).toHaveBeenCalledTimes(1);
  await flushSpeech();
  expect(fetchAudio).toHaveBeenCalledTimes(2);
  expect(context.sources[0]!.start).toHaveBeenCalledWith(0);
  expect(context.sources[1]!.start).toHaveBeenCalledWith(2);
  expect(JSON.parse(fetchAudio.mock.calls[0]![1]!.body as string)).toEqual({
    text: "First.",
    voice: "bm_lewis",
    speed: 1.2,
  });
  context.currentTime = 2;
  context.sources[0]!.end();
  await flushSpeech();
  expect(fetchAudio).toHaveBeenCalledTimes(3);
  expect(context.sources[2]!.start).toHaveBeenCalledWith(4);
  expect(onSpeaking).toHaveBeenCalledWith(true);
});

it("does not overlap even when enqueue arrives during a pending fetch", async () => {
  let resolve!: (response: Response) => void;
  const fetchAudio = vi.fn<typeof fetch>(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { player } = setup(fetchAudio);
  player.enqueue(["One."]);
  player.enqueue(["Two."]);
  expect(fetchAudio).toHaveBeenCalledTimes(1);
  resolve(wavResponse());
  await flushSpeech();
  expect(fetchAudio).toHaveBeenCalledTimes(2);
});

it("barge-in stops scheduled audio, aborts fetch, clears queue and discards late results", async () => {
  let resolve!: (response: Response) => void;
  const fetchAudio = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(wavResponse())
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
  const { player, context, onSpeaking } = setup(fetchAudio);
  player.enqueue(["One.", "Two.", "Three."]);
  await flushSpeech();
  const signal = fetchAudio.mock.calls[1]![1]!.signal!;
  expect(player.echoText).toContain("One.");
  player.stop();
  expect(signal.aborted).toBe(true);
  expect(context.sources[0]!.stop).toHaveBeenCalledOnce();
  expect(onSpeaking).toHaveBeenLastCalledWith(false);
  resolve(wavResponse());
  await flushSpeech();
  expect(context.sources).toHaveLength(1);
  expect(fetchAudio).toHaveBeenCalledTimes(2);
});

it("discards audio decoded after cancellation", async () => {
  const { player, context } = setup();
  let decode!: (buffer: { duration: number }) => void;
  context.decodeAudioData.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        decode = resolve;
      }),
  );
  player.enqueue(["One."]);
  await flushSpeech();
  player.stop();
  decode({ duration: 2 });
  await flushSpeech();
  expect(context.sources).toHaveLength(0);
});

it("surfaces busy and decode errors without retrying or leaving queued audio", async () => {
  const fetchAudio = vi.fn<typeof fetch>(
    async () =>
      ({ ok: false, status: 429, json: async () => ({}) }) as Response,
  );
  const { player, onError } = setup(fetchAudio);
  player.enqueue(["One.", "Two."]);
  await flushSpeech();
  expect(onError).toHaveBeenCalledWith(
    "Speech synthesis is busy. Try again shortly.",
  );
  expect(fetchAudio).toHaveBeenCalledTimes(1);
  const other = setup();
  other.context.decodeAudioData.mockRejectedValueOnce(new Error("Bad WAV"));
  other.player.enqueue(["One."]);
  await flushSpeech();
  expect(other.onError).toHaveBeenCalledWith("Bad WAV");
});
