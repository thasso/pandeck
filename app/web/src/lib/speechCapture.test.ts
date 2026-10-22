import { describe, expect, it } from "vitest";
import { SPEECH_SEND_WATERMARK_BYTES } from "@assistant/shared";
import {
  concatFrames,
  effectiveCaptureRate,
  socketAcceptsMore,
} from "./speechCapture.ts";

it("N1: speech sockets stop feeding at the shared backlog watermark", () => {
  const socket: { readyState: number; bufferedAmount: number } = {
    readyState: WebSocket.OPEN,
    bufferedAmount: SPEECH_SEND_WATERMARK_BYTES - 1,
  };
  expect(socketAcceptsMore(socket as WebSocket)).toBe(true);
  socket.bufferedAmount = SPEECH_SEND_WATERMARK_BYTES;
  expect(socketAcceptsMore(socket as WebSocket)).toBe(false);
  socket.bufferedAmount += 6400;
  expect(socketAcceptsMore(socket as WebSocket)).toBe(false);
  socket.readyState = WebSocket.CLOSED;
  socket.bufferedAmount = 0;
  expect(socketAcceptsMore(socket as WebSocket)).toBe(false);
});

describe("effectiveCaptureRate", () => {
  /**
   * This must agree with the worklet's own rule. If the two drift, the server is
   * told the wrong rate for the audio it receives — the transcript comes back
   * garbled rather than failing outright, which is much harder to diagnose.
   */
  it("reports the decimated rate whenever the context rate is an exact multiple", () => {
    expect(effectiveCaptureRate(48000)).toBe(16000);
    expect(effectiveCaptureRate(32000)).toBe(16000);
    expect(effectiveCaptureRate(16000)).toBe(16000);
  });

  it("passes a non-multiple rate through for the server to resample", () => {
    expect(effectiveCaptureRate(44100)).toBe(44100);
    expect(effectiveCaptureRate(22050)).toBe(22050);
  });
});

describe("concatFrames", () => {
  it("joins frames in order without losing samples", () => {
    const buffer = concatFrames([
      new Int16Array([1, 2]),
      new Int16Array([3]),
      new Int16Array([4, 5]),
    ]);
    expect(Array.from(new Int16Array(buffer))).toEqual([1, 2, 3, 4, 5]);
  });

  it("handles the no-audio case", () => {
    expect(concatFrames([]).byteLength).toBe(0);
  });
});
