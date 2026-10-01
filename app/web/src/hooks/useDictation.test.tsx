// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CaptureHandle } from "../lib/speechCapture.ts";
import { useDictation, type UseDictationResult } from "./useDictation.ts";

/**
 * What an utterance owes the caller once it is OVER.
 *
 * Cancelling cannot recall the work already on the wire: the socket close races
 * the server, and the HTTP fallback's POST is a request nobody can take back. So
 * the hook identifies each utterance and checks that identity again before it
 * delivers or tears anything down — otherwise a cancelled utterance's answer
 * lands in whatever the composer is writing NOW, and its teardown stops the
 * recording that replaced it. The composer cannot do this itself: from out
 * there, two utterances of the same hook look identical.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A capture that records what happened to it, with no audio anywhere. */
function fakeCapture(): CaptureHandle & { stopped: number } {
  return {
    sampleRate: 16000,
    frames: [],
    bytes: 4,
    stopped: 0,
    pendingBytes: () => 0,
    flush: () => true,
    async stop() {
      this.stopped += 1;
    },
    toBuffer: () => new ArrayBuffer(4),
  };
}

let capture = fakeCapture();
/** What the NEXT `startCapture` answers with; a test may hold it open. */
let nextCapture: () => Promise<CaptureHandle> = () => Promise.resolve(capture);
vi.mock("../lib/speechCapture.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/speechCapture.ts")>();
  return {
    ...actual,
    captureUnavailableReason: () => undefined,
    speechSocketUrl: () => "ws://localhost/ws/speech",
    socketAcceptsMore: () => true,
    startCapture: () => nextCapture(),
  };
});
vi.mock("../lib/screenWakeLock.ts", () => ({
  requestScreenWakeLock: () => Promise.resolve(null),
}));

/** A socket the test opens, kills and inspects by hand. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = 0;
  constructor() {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  addEventListener() {}
  send(data: unknown) {
    if (typeof data === "string") this.sent.push(data);
  }
  close() {
    this.closed += 1;
    this.readyState = 3;
  }
}

let container: HTMLDivElement;
let root: Root;
let hook: UseDictationResult;
let transcripts: string[];
let errors: string[];
/** Settles the HTTP fallback's response when the test decides it lands. */
let answerUpload: ((text: string) => void) | null = null;
/** How many uploads were abandoned by an abort rather than answered. */
let abortedUploads = 0;

function Harness() {
  hook = useDictation({
    instanceId: "test-composer",
    available: true,
    maxUtteranceSeconds: 120,
    onTranscript: (text) => transcripts.push(text),
    onError: (message) => errors.push(message),
  });
  return null;
}

beforeEach(() => {
  capture = fakeCapture();
  nextCapture = () => Promise.resolve(capture);
  transcripts = [];
  errors = [];
  answerUpload = null;
  abortedUploads = 0;
  FakeSocket.last = null;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    (_url: string, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortedUploads += 1;
          reject(new DOMException("Aborted", "AbortError"));
        });
        answerUpload = (text: string) =>
          resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ text }),
          } as Response);
      }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Record, then stop with the socket dead so delivery takes the HTTP fallback. */
async function recordOntoTheHttpFallback() {
  await act(async () => {
    root.render(<Harness />);
  });
  await act(async () => {
    hook.toggle();
  });
  expect(hook.phase).toBe("recording");
  FakeSocket.last!.readyState = 3;
  await act(async () => {
    hook.toggle();
  });
  expect(hook.phase).toBe("transcribing");
}

it("drops a cancelled utterance's transcript, even once a new one is recording", async () => {
  await recordOntoTheHttpFallback();
  const stale = answerUpload!;

  await act(async () => {
    hook.cancel();
  });
  expect(hook.phase).toBe("idle");

  // The composer reopened and the user is already dictating again.
  const second = fakeCapture();
  capture = second;
  await act(async () => {
    hook.toggle();
  });
  expect(hook.phase).toBe("recording");

  // Only now does the abandoned upload answer.
  await act(async () => {
    stale("what was said before the cancel");
    await Promise.resolve();
  });

  expect(transcripts).toEqual([]);
  expect(errors).toEqual([]);
  // And it did not take the live recording down with it.
  expect(hook.phase).toBe("recording");
  expect(second.stopped).toBe(0);
});

// Unmounting is the third way an utterance ends, and the quietest: a diff
// comment composer closes while the fallback is still transcribing, and there is
// no cancel anywhere for it to have gone through.
it("abandons the upload when its composer unmounts", async () => {
  await recordOntoTheHttpFallback();
  const stale = answerUpload!;

  await act(async () => {
    root.unmount();
  });
  await act(async () => {
    stale("what was said before the editor closed");
    await Promise.resolve();
  });

  expect(transcripts).toEqual([]);
  expect(errors).toEqual([]);
  // And the request was abandoned rather than left running against a composer
  // that no longer exists.
  expect(abortedUploads).toBe(1);
});

it("stops the utterance's timers when its composer unmounts", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"],
  });
  try {
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => {
      hook.toggle();
    });
    expect(hook.phase).toBe("recording");

    await act(async () => {
      root.unmount();
    });
    // The unmount stopped the microphone once. The utterance cap must not fire
    // afterwards and run a whole `finish` against a composer that is gone.
    expect(capture.stopped).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(200_000);
    });
    expect(capture.stopped).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

it("delivers the utterance that is actually in flight", async () => {
  await recordOntoTheHttpFallback();
  await act(async () => {
    answerUpload!("what was said");
    await Promise.resolve();
  });

  expect(transcripts).toEqual(["what was said"]);
  expect(hook.phase).toBe("idle");
});

it("does not let a cancelled utterance's microphone arrive into the next one", async () => {
  // The slowest wait in the hook: a permission prompt the user leaves sitting
  // there, which is exactly where a cancel lands.
  const abandoned = fakeCapture();
  let handOverTheMicrophone: (() => void) | null = null;
  nextCapture = () =>
    new Promise<CaptureHandle>((resolve) => {
      handOverTheMicrophone = () => resolve(abandoned);
    });
  await act(async () => {
    root.render(<Harness />);
  });
  await act(async () => {
    hook.toggle();
  });
  expect(hook.phase).toBe("starting");
  const abandonedSocket = FakeSocket.last!;

  await act(async () => {
    hook.cancel();
  });
  expect(hook.phase).toBe("idle");

  // A second utterance starts and gets its microphone straight away.
  const live = fakeCapture();
  nextCapture = () => Promise.resolve(live);
  await act(async () => {
    hook.toggle();
  });
  expect(hook.phase).toBe("recording");

  // Only now does the first microphone open.
  await act(async () => {
    handOverTheMicrophone!();
    await Promise.resolve();
  });

  // It announced nothing on its own dead socket, and it did not become the
  // recording that is running: stopping THAT stops the live capture.
  expect(
    abandonedSocket.sent.filter((frame) => frame.includes('"start"')),
  ).toEqual([]);
  expect(errors).toEqual([]);
  expect(hook.phase).toBe("recording");
  FakeSocket.last!.readyState = 3;
  await act(async () => {
    hook.toggle();
  });
  expect(live.stopped).toBe(1);
  expect(abandoned.stopped).toBe(1); // stopped by the teardown that abandoned it
});

it("lets a dead socket's unlabelled error say nothing about the live utterance", async () => {
  await act(async () => {
    root.render(<Harness />);
  });
  await act(async () => {
    hook.toggle();
  });
  const abandonedSocket = FakeSocket.last!;
  await act(async () => {
    hook.cancel();
  });

  const live = fakeCapture();
  nextCapture = () => Promise.resolve(live);
  await act(async () => {
    hook.toggle();
  });
  expect(hook.phase).toBe("recording");

  // The server's parting words about the CANCELLED utterance. An error frame
  // need not name one, so nothing in the payload can tell them apart — only the
  // socket it arrived on can.
  await act(async () => {
    abandonedSocket.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "error", message: "utterance cancelled" }),
      }),
    );
    await Promise.resolve();
  });

  expect(errors).toEqual([]);
  expect(hook.phase).toBe("recording");
  expect(live.stopped).toBe(0);
});

it("lets a dead socket fail without killing the next utterance's startup", async () => {
  await act(async () => {
    root.render(<Harness />);
  });
  await act(async () => {
    hook.toggle();
  });
  const abandonedSocket = FakeSocket.last!;
  await act(async () => {
    hook.cancel();
  });

  // The replacement is still arming: there is no capture yet, which is exactly
  // the state the socket's own error handler treats as unrecoverable.
  const live = fakeCapture();
  let handOverTheMicrophone: (() => void) | null = null;
  nextCapture = () =>
    new Promise<CaptureHandle>((resolve) => {
      handOverTheMicrophone = () => resolve(live);
    });
  await act(async () => {
    hook.toggle();
  });
  expect(hook.phase).toBe("starting");

  await act(async () => {
    abandonedSocket.onerror?.();
    await Promise.resolve();
  });
  expect(errors).toEqual([]);
  expect(hook.phase).toBe("starting");

  // And it goes on to record, rather than having been torn down mid-arming.
  await act(async () => {
    handOverTheMicrophone!();
    await Promise.resolve();
  });
  expect(hook.phase).toBe("recording");
});

it("ignores a socket transcript addressed to an utterance that ended", async () => {
  await act(async () => {
    root.render(<Harness />);
  });
  await act(async () => {
    hook.toggle();
  });
  const socket = FakeSocket.last!;
  const started = JSON.parse(
    socket.sent.find((frame) => frame.includes('"start"'))!,
  ) as { utteranceId: string };

  await act(async () => {
    hook.cancel();
  });
  await act(async () => {
    socket.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "transcript",
          utteranceId: started.utteranceId,
          text: "too late",
          audioMs: 10,
          decodeMs: 5,
        }),
      }),
    );
    await Promise.resolve();
  });

  expect(transcripts).toEqual([]);
});
