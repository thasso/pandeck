// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEFAULT_SPEECH_CONVERSATION_SETTINGS,
  DEFAULT_SPEECH_SYNTHESIS_SETTINGS,
  type DisplayMessage,
} from "@assistant/shared";
import {
  useConversation,
  type ConversationOptions,
} from "./useConversation.ts";
import { microphoneOwner } from "../lib/microphoneOwner.ts";
import {
  FakeSpeechContext,
  flushSpeech,
  wavResponse,
} from "../lib/speechFakes.test-support.ts";

const capture = vi.hoisted(() => ({
  start: vi.fn(),
  reason: vi.fn<() => string | undefined>(() => undefined),
}));
vi.mock("../lib/conversationCapture.ts", () => ({
  startConversationCapture: capture.start,
}));
vi.mock("../lib/speechCapture.ts", () => ({
  captureUnavailableReason: capture.reason,
  speechSocketUrl: () => "ws://localhost/ws/speech?token=abc",
  socketAcceptsMore: (socket: FakeSocket) =>
    socket.readyState === 1 && socket.bufferedAmount < 256 * 1024,
}));
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
  });
  constructor(readonly url: URL) {
    FakeSocket.instances.push(this);
  }
  send(value: unknown) {
    this.sent.push(value);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
let root: Root;
let container: HTMLDivElement;
let options: ConversationOptions;
let result: ReturnType<typeof useConversation>;
let sendFrame: (frame: Int16Array) => void;
const release = vi.fn();
function Harness() {
  result = useConversation(options);
  return (
    <div>
      {result.phase}:{result.partial}:{result.error}
    </div>
  );
}
const prose = (id: string, text: string, streaming = true): DisplayMessage => ({
  id,
  role: "assistant",
  streaming,
  blocks: [{ kind: "text", text }],
});
async function render(patch: Partial<ConversationOptions> = {}) {
  options = { ...options, ...patch };
  await act(async () => {
    root.render(<Harness />);
    await flushSpeech();
  });
}
async function start() {
  await act(async () => {
    result.toggle();
    await flushSpeech();
  });
  const socket = FakeSocket.instances.at(-1)!;
  act(() => {
    socket.open();
    socket.message({ type: "accepted", sampleRate: 16000 });
  });
  return socket;
}
beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("AudioContext", FakeSpeechContext);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => wavResponse()),
  );
  FakeSocket.instances = [];
  FakeSpeechContext.instances = [];
  capture.start.mockImplementation(
    async (_signal: AbortSignal, callback: typeof sendFrame) => {
      sendFrame = callback;
      return release;
    },
  );
  options = {
    instanceId: "voice-test",
    sessionId: "session-a",
    disabled: false,
    settings: {
      speechConversation: DEFAULT_SPEECH_CONVERSATION_SETTINGS,
      speechSynthesis: DEFAULT_SPEECH_SYNTHESIS_SETTINGS,
    },
    status: {
      configured: true,
      availableModelIds: [],
      maxUtteranceSeconds: 120,
      conversation: { configured: true, availableModelIds: [] },
      tts: { configured: true, availableVoices: [] },
    },
    messages: [],
    streaming: false,
    onFinal: vi.fn(() => true),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (microphoneOwner.id !== null)
    throw new Error("Microphone ownership leaked after unmount.");
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("M3-R4: recognized short table rows never reach synthesis", async () => {
  await start();
  await render({
    messages: [
      prose(
        "voice-live:short-row",
        "| Task | Status |\n| --- | --- |\nSensitive. More data",
      ),
    ],
    streaming: true,
  });
  await render({
    messages: [
      prose(
        "voice-live:short-row",
        "| Task | Status |\n| --- | --- |\nSensitive. More data\n\nAfter.",
        false,
      ),
    ],
    streaming: false,
  });
  expect(
    vi
      .mocked(fetch)
      .mock.calls.map((call) => JSON.parse(call[1]!.body as string).text),
  ).toEqual(["After."]);
});

it("M3-R1: a table prefix cannot consume the following prose cursor", async () => {
  await start();
  await render({ messages: [prose("voice-live:table", "Header. ")] });
  await render({
    messages: [
      prose(
        "voice-live:table",
        "Header. | State\n--- | ---\nx | y\n\nAfter.",
        false,
      ),
    ],
  });
  expect(
    vi
      .mocked(fetch)
      .mock.calls.map((call) => JSON.parse(call[1]!.body as string).text),
  ).toEqual(["After."]);
});

it("M3-R1: source positions survive already-spoken prose becoming a table", async () => {
  await start();
  await render({
    messages: [prose("voice-live:changed", "Header. More prose")],
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  await render({
    messages: [
      prose(
        "voice-live:changed",
        "Header. More prose | State\n--- | ---\nx | y\n\nAfter.",
        false,
      ),
    ],
  });
  expect(
    vi
      .mocked(fetch)
      .mock.calls.map((call) => JSON.parse(call[1]!.body as string).text),
  ).toEqual(["Header.", "After."]);
});

it("M3-R2: a remote send before the live overlay releases the mute", async () => {
  const socket = await start();
  const live = prose("voice-live:original", "Original answer. More");
  await render({ messages: [live], streaming: true });
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "wait please",
      isFinal: false,
    }),
  );
  const user: DisplayMessage = {
    id: "remote-user",
    role: "user",
    blocks: [{ kind: "text", text: "Next question" }],
  };
  await render({ messages: [user, live], streaming: true });
  await render({
    messages: [
      user,
      prose("durable-original", "Original answer. More", false),
      prose("voice-live:next", "Following the next question. More"),
    ],
    streaming: true,
  });
  expect(
    vi
      .mocked(fetch)
      .mock.calls.map((call) => JSON.parse(call[1]!.body as string).text),
  ).toEqual(["Original answer.", "Following the next question."]);
});

it.each(["steer", "queue"])(
  "M3-R2: a remote %s while busy releases the mute",
  async (path) => {
    const socket = await start();
    const user: DisplayMessage = {
      id: "first-user",
      role: "user",
      blocks: [{ kind: "text", text: "First question" }],
    };
    const live = prose("voice-live:busy", "Original answer. More");
    await render({
      messages: [user, live],
      streaming: true,
      queuedMessages: [{ id: "old-queue" }],
    });
    act(() =>
      socket.message({
        type: "transcript",
        segment: 0,
        text: "wait please",
        isFinal: false,
      }),
    );
    // History expansion, a queue edit/reorder and automatic peer prompts aren't sends.
    await render({
      messages: [
        { ...user, id: "older-user" },
        user,
        {
          ...user,
          id: "peer-user",
          promptOrigin: { kind: "agent", agentId: "peer" },
        },
        live,
      ],
      queuedMessages: [{ id: "old-queue" }],
    });
    const muted = prose("voice-live:muted-step", "Still interrupted. More");
    const durable = prose("durable-busy", "Original answer. More", false);
    await render({ messages: [user, durable, muted] });
    expect(fetch).toHaveBeenCalledTimes(1);
    const nextUser: DisplayMessage = {
      ...user,
      id: "next-user",
      promptDelivery: "steer",
    };
    await render({
      messages:
        path === "steer"
          ? [user, durable, nextUser, muted]
          : [user, durable, muted],
      queuedMessages:
        path === "queue"
          ? [{ id: "new-queue" }, { id: "old-queue" }]
          : [{ id: "old-queue" }],
    });
    await render({
      messages: [
        user,
        durable,
        prose("durable-muted", "Still interrupted. More", false),
        prose("voice-live:fresh", "Fresh answer. More"),
      ],
    });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.map((call) => JSON.parse(call[1]!.body as string).text),
    ).toEqual(["Original answer.", "Fresh answer."]);
  },
);

it("M3-R2: users already present at interruption never unmute a tool step", async () => {
  const socket = await start();
  const user: DisplayMessage = {
    id: "already-sent",
    role: "user",
    blocks: [{ kind: "text", text: "Earlier question" }],
  };
  await render({
    messages: [user, prose("voice-live:before", "Original answer. More")],
    streaming: true,
  });
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "wait please",
      isFinal: false,
    }),
  );
  await render({
    messages: [
      user,
      prose("durable-before", "Original answer. More", false),
      prose("voice-live:after", "Still muted. More"),
    ],
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("M3-R3: ambiguous multiword prefixes wait for the endpoint and preserve final text", async () => {
  const socket = await start();
  await render({
    messages: [prose("voice-live:prefix", "You cannot change this. More")],
    streaming: true,
  });
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "you can",
      isFinal: false,
    }),
  );
  expect(
    FakeSpeechContext.instances[0]!.sources[0]!.stop,
  ).not.toHaveBeenCalled();
  expect(result.partial).toBe("");
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "you can",
      isFinal: true,
    }),
  );
  expect(options.onFinal).toHaveBeenCalledExactlyOnceWith("you can");
  expect(
    FakeSpeechContext.instances[0]!.sources[0]!.stop,
  ).toHaveBeenCalledOnce();
});

it("M3-C2: streamed link boundaries never replay a preceding sentence", async () => {
  await start();
  await render({
    messages: [prose("voice-live:link", "First. [documentation")],
  });
  await render({
    messages: [prose("voice-live:link", "First. [documentation]")],
  });
  await render({
    messages: [
      prose(
        "voice-live:link",
        "First. [documentation](https://example.com) helps.",
        false,
      ),
    ],
  });
  expect(
    vi
      .mocked(fetch)
      .mock.calls.map((call) => JSON.parse(call[1]!.body as string).text),
  ).toEqual(["First.", "documentation helps."]);
});

it("never rewinds a spoken cursor if a projection temporarily gets shorter", async () => {
  await start();
  await render({ messages: [prose("voice-live:shorter", "First. Second")] });
  await render({ messages: [prose("voice-live:shorter", "First.")] });
  await render({
    messages: [prose("voice-live:shorter", "First. Second.", false)],
  });
  expect(
    vi
      .mocked(fetch)
      .mock.calls.map((call) => JSON.parse(call[1]!.body as string).text),
  ).toEqual(["First.", "Second."]);
});

it("ignores an unfinished recognizer word in speaker feedback", async () => {
  const socket = await start();
  await render({
    messages: [
      prose(
        "voice-live:subword",
        "I heard your message. This reply was generated by the local test responder.",
        false,
      ),
    ],
    streaming: true,
  });
  act(() => {
    const context = FakeSpeechContext.instances[0]!;
    context.currentTime = 2;
    context.sources[0]!.end();
    socket.message({
      type: "transcript",
      segment: 0,
      text: "I heard your message, this reply was generated by the local test resp",
      isFinal: false,
    });
  });
  expect(
    FakeSpeechContext.instances[0]!.sources.every(
      (source) => source.stop.mock.calls.length === 0,
    ),
  ).toBe(true);
  expect(result.partial).toBe("");
  expect(options.onFinal).not.toHaveBeenCalled();
});

it.each(["empty", "echo"])(
  "F3: a partial corrected to an %s final before this run speaks does not mute its reply",
  async (final) => {
    const socket = await start();
    if (final === "echo") {
      // A previous run's playback must not arm interruption for the next run.
      await render({
        messages: [prose("previous-run", "Hello world. More")],
        streaming: true,
      });
      act(() => FakeSpeechContext.instances[0]!.sources[0]!.end());
      await render({ messages: [], streaming: false });
      vi.mocked(fetch).mockClear();
    }
    await render({ messages: [], streaming: true });
    act(() => {
      socket.message({
        type: "transcript",
        segment: 0,
        text: "uh",
        isFinal: false,
      });
      socket.message({
        type: "transcript",
        segment: 0,
        text: final === "echo" ? "hello world" : "",
        isFinal: true,
      });
    });
    expect(options.onFinal).not.toHaveBeenCalled();
    await render({
      messages: [prose("current-run", "Here is the answer. More")],
    });
    await render({
      messages: [
        prose("current-run", "Here is the answer. Second sentence. More"),
      ],
    });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.map((call) => JSON.parse(call[1]!.body as string).text),
    ).toEqual(["Here is the answer.", "Second sentence."]);
  },
);

it("M3-C3: interruption mutes later messages from the same running turn", async () => {
  const socket = await start();
  await render({
    messages: [prose("voice-live:step-one", "I will check. More")],
    streaming: true,
  });
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "wait please",
      isFinal: false,
    }),
  );
  const first = prose("durable-step-one", "I will check. More", false);
  await render({ messages: [first], streaming: true });
  await render({
    messages: [
      first,
      prose("voice-live:step-two", "The check is complete. More"),
    ],
    streaming: true,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("keeps a tool-gap turn muted when speech starts between audio buffers", async () => {
  const socket = await start();
  const first = prose("voice-live:gap", "First answer. More");
  await render({ messages: [first], streaming: true });
  act(() => FakeSpeechContext.instances[0]!.sources[0]!.end());
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "wait please",
      isFinal: false,
    }),
  );
  await render({
    messages: [
      prose("gap-durable", "First answer. More", false),
      prose("voice-live:after-gap", "After the tool. More"),
    ],
    streaming: true,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(["run end", "spoken final", "typed send", "remote user"])(
  "releases whole-turn interruption for %s, without replaying muted rows",
  async (releaseBy) => {
    const socket = await start();
    await render({
      messages: [prose("voice-live:a", "First answer. More")],
      streaming: true,
    });
    act(() =>
      socket.message({
        type: "transcript",
        segment: 0,
        text: "wait please",
        isFinal: false,
      }),
    );
    const first = prose("durable:a", "First answer. More", false);
    await render({
      messages: [first, prose("voice-live:b", "Muted after tools. More")],
      streaming: true,
    });
    const second = prose("durable:b", "Muted after tools. More", false);
    await render({ messages: [first, second], streaming: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    let messages = [first, second];
    if (releaseBy === "run end") await render({ streaming: false });
    else if (releaseBy === "spoken final")
      act(() =>
        socket.message({
          type: "transcript",
          segment: 0,
          text: "next question",
          isFinal: true,
        }),
      );
    else if (releaseBy === "typed send") act(() => result.userMessageSent());
    else
      messages = [
        ...messages,
        {
          id: "new-user",
          role: "user",
          streaming: false,
          blocks: [{ kind: "text", text: "Next question" }],
        },
      ];
    await render({
      messages: [...messages, prose("voice-live:c", "Fresh answer. More")],
      streaming: true,
    });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.map((call) => JSON.parse(call[1]!.body as string).text),
    ).toEqual(["First answer.", "Fresh answer."]);
    expect(socket.sent).not.toContainEqual(JSON.stringify({ type: "abort" }));
  },
);

it("waits for admission, shows replacement partials and auto-sends a nonempty final exactly once", async () => {
  act(() => result.toggle());
  await act(async () => {
    await flushSpeech();
  });
  const socket = FakeSocket.instances[0]!;
  act(() => sendFrame(new Int16Array(3200)));
  expect(socket.sent).toHaveLength(0);
  act(() => {
    socket.open();
    socket.message({ type: "accepted", sampleRate: 16000 });
    sendFrame(new Int16Array(3200));
  });
  expect(socket.url.pathname).toBe("/ws/speech/conversation");
  expect(socket.url.search).toBe("?token=abc");
  expect(socket.sent[0]).toBe('{"type":"start"}');
  expect(socket.sent[1]).toBeInstanceOf(ArrayBuffer);
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "hello",
      isFinal: false,
    }),
  );
  expect(result.partial).toBe("hello");
  expect(result.phase).toBe("hearing you");
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "hello there",
      isFinal: true,
    }),
  );
  expect(options.onFinal).toHaveBeenCalledExactlyOnceWith("hello there");
  expect(result.partial).toBe("");
  act(() => {
    socket.message({
      type: "transcript",
      segment: 0,
      text: "hello there",
      isFinal: true,
    });
    socket.message({ type: "transcript", segment: 1, text: "", isFinal: true });
  });
  expect(options.onFinal).toHaveBeenCalledTimes(1);
});

it("does not consume a recognizer segment on an empty silence final", async () => {
  const socket = await start();
  act(() => {
    socket.message({ type: "transcript", segment: 0, text: "", isFinal: true });
    socket.message({ type: "transcript", segment: 0, text: "", isFinal: true });
    socket.message({
      type: "transcript",
      segment: 0,
      text: "second utterance",
      isFinal: false,
    });
  });
  expect(result.partial).toBe("second utterance");
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "second utterance",
      isFinal: true,
    }),
  );
  expect(options.onFinal).toHaveBeenCalledExactlyOnceWith("second utterance");
});

it("speaks only new assistant prose, skips tools/thinking, and flushes the final tail", async () => {
  await render({ messages: [prose("old", "Old prose.", false)] });
  await start();
  await render({
    messages: [
      prose("old", "Old prose.", false),
      {
        id: "new",
        role: "assistant",
        streaming: true,
        blocks: [
          { kind: "thinking", text: "Private reasoning." },
          { kind: "text", text: "Hello. More" },
        ],
      },
    ],
  });
  const fetchAudio = vi.mocked(fetch);
  expect(fetchAudio).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchAudio.mock.calls[0]![1]!.body as string).text).toBe(
    "Hello.",
  );
  await render({
    messages: [
      {
        id: "new",
        role: "assistant",
        streaming: false,
        blocks: [
          { kind: "thinking", text: "Private reasoning." },
          { kind: "text", text: "Hello. More" },
        ],
      },
    ],
  });
  await render({ messages: [prose("next", "Final tail", false)] });
  expect(
    fetchAudio.mock.calls.some(
      (call) => JSON.parse(call[1]!.body as string).text === "Final tail",
    ),
  ).toBe(false);
  const context = FakeSpeechContext.instances[0]!;
  await act(async () => {
    context.currentTime = 2;
    context.sources[0]!.end();
    await flushSpeech();
  });
  expect(
    fetchAudio.mock.calls.some(
      (call) => JSON.parse(call[1]!.body as string).text === "Final tail",
    ),
  ).toBe(true);
});

it("ignores speaker echo, barges in immediately on distinct speech and never aborts the agent", async () => {
  const socket = await start();
  await render({
    messages: [prose("reply", "Hello world. More text")],
    streaming: true,
  });
  const context = FakeSpeechContext.instances[0]!;
  expect(result.phase).toBe("speaking");
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "hello world",
      isFinal: false,
    }),
  );
  expect(context.sources[0]!.stop).not.toHaveBeenCalled();
  expect(result.partial).toBe("");
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "please stop",
      isFinal: false,
    }),
  );
  expect(context.sources[0]!.stop).toHaveBeenCalledOnce();
  expect(result.phase).toBe("hearing you");
  expect(result.active).toBe(true);
  await render({
    messages: [prose("reply", "Hello world. More text. Still going.")],
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "please stop",
      isFinal: true,
    }),
  );
  expect(options.onFinal).toHaveBeenCalledExactlyOnceWith("please stop");
});

it("transfers streamed sentence cursors to durable ids and resets for the next runtime stream", async () => {
  await start();
  await render({
    messages: [prose("voice-live:first", "One. Tail")],
    streaming: true,
  });
  await render({
    messages: [prose("durable-first", "One. Tail", false)],
    streaming: false,
  });
  expect(
    vi
      .mocked(fetch)
      .mock.calls.map((call) => JSON.parse(call[1]!.body as string).text),
  ).toEqual(["One.", "Tail"]);
  await render({
    messages: [
      prose("durable-first", "One. Tail", false),
      prose("voice-live:second", "Two. More"),
    ],
    streaming: true,
  });
  const context = FakeSpeechContext.instances[0]!;
  await act(async () => {
    context.currentTime = 2;
    context.sources[0]!.end();
    await flushSpeech();
  });
  expect(
    vi
      .mocked(fetch)
      .mock.calls.map((call) => JSON.parse(call[1]!.body as string).text),
  ).toEqual(["One.", "Tail", "Two."]);
});

it("does not let identical historical prose consume a new stream's durable handoff", async () => {
  const old = prose("old-identical", "Same. Tail", false);
  await render({ messages: [old] });
  await start();
  await render({ messages: [old, prose("voice-live:repeat", "Same. Tail")] });
  await render({
    messages: [old, prose("durable-repeat", "Same. Tail", false)],
  });
  expect(
    vi
      .mocked(fetch)
      .mock.calls.map((call) => JSON.parse(call[1]!.body as string).text),
  ).toEqual(["Same.", "Tail"]);
});

it("preserves barge-in suppression across the live-to-durable handoff", async () => {
  const socket = await start();
  await render({
    messages: [prose("voice-live:muted", "One. Tail")],
    streaming: true,
  });
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "please stop",
      isFinal: false,
    }),
  );
  await render({
    messages: [prose("durable-muted", "One. Tail", false)],
    streaming: false,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not speak older history prepended to the live transcript window", async () => {
  await render({ messages: [prose("old-tail", "Already visible.", false)] });
  await start();
  await render({
    messages: [
      prose("older-history", "Historical prose.", false),
      prose("old-tail", "Already visible.", false),
      prose("fresh", "Fresh reply.", false),
    ],
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string).text,
  ).toBe("Fresh reply.");
});

it("keeps thinking visible between auto-send and the runtime starting", async () => {
  const socket = await start();
  await render({ messages: [prose("earlier", "Earlier answer.", false)] });
  const context = FakeSpeechContext.instances[0]!;
  act(() => {
    context.currentTime = 2;
    context.sources[0]!.end();
  });
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "another question",
      isFinal: true,
    }),
  );
  expect(result.phase).toBe("thinking");
});

it("rejects malformed responses and releases the stream", async () => {
  const socket = await start();
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: null,
      isFinal: true,
    }),
  );
  expect(result.error).toBe("Invalid conversation response.");
  expect(result.active).toBe(false);
});

it("cancels pending synthesis before the first buffer and ignores a late response", async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const socket = await start();
  await render({
    messages: [prose("pending", "A slow sentence. Next")],
    streaming: true,
  });
  const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "wait",
      isFinal: false,
    }),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => {
    resolve(wavResponse());
    await flushSpeech();
  });
  expect(FakeSpeechContext.instances[0]!.sources).toHaveLength(0);
  expect(result.phase).toBe("hearing you");
  act(() =>
    socket.message({ type: "transcript", segment: 0, text: "", isFinal: true }),
  );
  await render({
    messages: [prose("pending", "A slow sentence. Next sentence. More")],
  });
  // Pending synthesis is a real interruption even before the first buffer plays.
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("retains matching speaker text until a delayed final without sending it", async () => {
  const socket = await start();
  await render({
    messages: [prose("echo", "Hello world. Next")],
    streaming: true,
  });
  const context = FakeSpeechContext.instances[0]!;
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "hello",
      isFinal: false,
    }),
  );
  act(() => {
    context.currentTime = 2;
    context.sources[0]!.end();
  });
  context.currentTime = 5;
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "hello world",
      isFinal: true,
    }),
  );
  expect(options.onFinal).not.toHaveBeenCalled();
  expect(result.partial).toBe("");
});

it("stops when auto-send is refused and surfaces microphone failures", async () => {
  const socket = await start();
  await render({ onFinal: vi.fn(() => false) });
  act(() =>
    socket.message({
      type: "transcript",
      segment: 0,
      text: "send",
      isFinal: true,
    }),
  );
  expect(result.error).toContain("could not be sent");
  expect(result.active).toBe(false);
  capture.start.mockRejectedValueOnce(new Error("Microphone denied"));
  await act(async () => {
    result.toggle();
    await flushSpeech();
  });
  expect(result.error).toBe("Microphone denied");
  expect(result.active).toBe(false);
});

it("fails a recognizer readiness timeout and does not reopen automatically", async () => {
  vi.useFakeTimers();
  try {
    await act(async () => {
      result.toggle();
      await flushSpeech();
    });
    act(() => {
      vi.advanceTimersByTime(65000);
    });
    expect(result.error).toContain("did not become ready");
    expect(result.active).toBe(false);
    expect(FakeSocket.instances).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it("cleans up on toggle, session switch, page hide and socket error", async () => {
  let socket = await start();
  act(() => result.toggle());
  expect(socket.close).toHaveBeenCalled();
  expect(release).toHaveBeenCalled();
  socket = await start();
  await render({ sessionId: "session-b" });
  expect(socket.close).toHaveBeenCalled();
  expect(result.active).toBe(false);
  socket = await start();
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: true,
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(socket.close).toHaveBeenCalled();
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
  socket = await start();
  act(() => socket.onerror?.());
  expect(result.error).toBe("Conversation connection failed.");
  expect(result.active).toBe(false);
});

it("releases a late microphone acquisition and ignores stale socket events", async () => {
  let resolve!: (release: () => void) => void;
  capture.start.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  act(() => result.toggle());
  const old = FakeSocket.instances[0]!;
  act(() => result.toggle());
  await start();
  await act(async () => {
    resolve(release);
    await flushSpeech();
  });
  expect(release).toHaveBeenCalled();
  act(() => old.message({ type: "error", message: "stale" }));
  expect(result.active).toBe(true);
  expect(result.error).toBeNull();
});

it.each(["speechConversation", "speechSynthesis"] as const)(
  "F1: persisted %s disablement gates capture before any socket or send",
  async (group) => {
    await render({
      settings: {
        ...options.settings!,
        [group]: { ...options.settings![group], enabled: false },
      },
    });
    expect(result.unavailableReason).toContain(
      group === "speechSynthesis"
        ? "Enable spoken replies"
        : "Enable conversation",
    );
    act(() => result.toggle());
    expect(FakeSocket.instances).toHaveLength(0);
    expect(capture.start).not.toHaveBeenCalled();
    expect(options.onFinal).not.toHaveBeenCalled();
  },
);

it("fails closed for settings, host capability, microphone ownership and backpressure", async () => {
  await render({
    status: {
      ...options.status!,
      tts: { configured: false, availableVoices: [], reason: "No Kokoro" },
    },
  });
  expect(result.unavailableReason).toBe("No Kokoro");
  act(() => result.toggle());
  expect(FakeSocket.instances).toHaveLength(0);
  await render({
    status: {
      ...options.status!,
      tts: { configured: true, availableVoices: [] },
    },
  });
  act(() => {
    microphoneOwner.claim("other");
    result.toggle();
  });
  expect(result.active).toBe(false);
  act(() => microphoneOwner.release("other"));
  const socket = await start();
  act(() => {
    socket.bufferedAmount = 300000;
    sendFrame(new Int16Array(3200));
  });
  expect(result.error).toContain("fell behind");
  expect(result.active).toBe(false);
});
