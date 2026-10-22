// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEFAULT_SPEECH_CONVERSATION_SETTINGS,
  DEFAULT_SPEECH_SYNTHESIS_SETTINGS,
} from "@assistant/shared";
import type { ConversationOptions } from "../hooks/useConversation.ts";
import { mount } from "../test/mount.tsx";
import { stubMatchMedia } from "../test/matchMedia.ts";
import { persistentStore } from "../lib/persistentStore.ts";
import { VOICE_REPLY_HINT } from "../lib/conversationText.ts";
import { Composer } from "./Composer.tsx";

const conversation = vi.hoisted(() => ({
  options: null as ConversationOptions | null,
  active: false,
  partial: "",
  sent: vi.fn(),
}));
vi.mock("../hooks/useConversation.ts", () => ({
  useConversation: (options: ConversationOptions) => {
    conversation.options = options;
    return {
      active: conversation.active,
      phase: conversation.active ? "hearing you" : "off",
      partial: conversation.partial,
      error: null,
      unavailableReason: undefined,
      toggle: vi.fn(),
      userMessageSent: conversation.sent,
    };
  },
}));
stubMatchMedia();
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
HTMLElement.prototype.scrollIntoView = vi.fn();
const DRAFT_A = "voice-fix-draft-a";
const DRAFT_B = "voice-fix-draft-b";
beforeEach(() => {
  conversation.active = false;
  conversation.partial = "";
  persistentStore().removeItem(DRAFT_A);
  persistentStore().removeItem(DRAFT_B);
});
afterEach(() => {
  vi.clearAllMocks();
});
function type(field: HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function props(
  patch: Partial<ComponentProps<typeof Composer>> = {},
): ComponentProps<typeof Composer> {
  return {
    onSend: vi.fn(),
    onAbort: vi.fn(),
    streaming: false,
    disabled: false,
    contextInfo: null,
    session: { sessionId: "a", canSteer: true } as ComponentProps<
      typeof Composer
    >["session"],
    models: [],
    slashCommands: [],
    actions: {} as never,
    conversation: {
      settings: {
        speechConversation: DEFAULT_SPEECH_CONVERSATION_SETTINGS,
        speechSynthesis: DEFAULT_SPEECH_SYNTHESIS_SETTINGS,
      },
      messages: [],
      getMessages: () => [],
      onActiveChange: vi.fn(),
    },
    ...patch,
  };
}

it("passes authoritative user queue identities to conversation", () => {
  const options = props();
  const items = [{ id: "remote-queue", text: "Next question", createdAt: 1 }];
  mount(
    <Composer
      {...options}
      session={{ ...options.session!, promptQueue: { items, paused: false } }}
    />,
  );
  expect(conversation.options!.queuedMessages).toBe(items);
});

it.each(["queue", "steer"])(
  "a typed %s releases conversation muting while busy",
  (path) => {
    const options = props({
      streaming: true,
      ...(path === "queue" ? { onQueue: vi.fn() } : {}),
    });
    const view = mount(<Composer {...options} />);
    const field = view.container.querySelector("textarea")!;
    type(field, "Next question");
    act(() => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(conversation.sent).toHaveBeenCalledOnce();
    if (path === "queue")
      expect(options.onQueue).toHaveBeenCalledWith({ text: "Next question" });
    else expect(options.onSend).toHaveBeenCalledWith("Next question", []);
  },
);

it("M3-C1: sends an existing draft together with the spoken final", () => {
  const options = props({
    draft: { sessionId: "a", text: "Unsent important draft", token: 99 },
  });
  const { container } = mount(<Composer {...options} />);
  act(() => {
    conversation.options!.onFinal("Hello there");
  });
  expect(options.onSend).toHaveBeenCalledWith(
    `Unsent important draft\n\nHello there\n\n${VOICE_REPLY_HINT}`,
    [],
  );
  expect(container.querySelector("textarea")!.value).toBe("");
});

it("keeps persisted drafts and edits while appending a replaceable live preview", () => {
  persistentStore().setItem(DRAFT_A, "Saved draft");
  const options = props({ draftStorageKey: DRAFT_A });
  const view = mount(<Composer {...options} />);
  const field = view.container.querySelector("textarea")!;
  conversation.active = true;
  conversation.partial = "first guess";
  view.render(
    <Composer {...options} conversation={{ ...options.conversation! }} />,
  );
  const preview = view.container.querySelector('[aria-label="Live speech"]')!;
  expect(preview.textContent).toBe("first guess");
  expect(
    field.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  expect(field.value).toBe("Saved draft");
  expect(persistentStore().getItem(DRAFT_A)).toBe("Saved draft");
  type(field, "Edited draft");
  conversation.partial = "better guess";
  view.render(
    <Composer {...options} conversation={{ ...options.conversation! }} />,
  );
  expect(field.value).toBe("Edited draft");
  expect(persistentStore().getItem(DRAFT_A)).toBe("Edited draft");
  act(() => {
    conversation.options!.onFinal("final words");
  });
  expect(options.onSend).toHaveBeenCalledWith(
    `Edited draft\n\nfinal words\n\n${VOICE_REPLY_HINT}`,
    [],
  );
  expect(field.value).toBe("");
  expect(persistentStore().getItem(DRAFT_A)).toBeNull();
});

it("includes an edit even when its React render is still batched with the final", () => {
  const options = props();
  const view = mount(<Composer {...options} />);
  const field = view.container.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(field, "Last instant edit");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    conversation.options!.onFinal("spoken addition");
  });
  expect(options.onSend).toHaveBeenCalledWith(
    `Last instant edit\n\nspoken addition\n\n${VOICE_REPLY_HINT}`,
    [],
  );
});

it.each(["", "   "])(
  "does not send or clear a draft on an empty final %j",
  (final) => {
    persistentStore().setItem(DRAFT_A, "Keep me");
    const options = props({ draftStorageKey: DRAFT_A });
    const view = mount(<Composer {...options} />);
    act(() => {
      expect(conversation.options!.onFinal(final)).toBe(false);
    });
    expect(options.onSend).not.toHaveBeenCalled();
    expect(view.container.querySelector("textarea")!.value).toBe("Keep me");
    expect(persistentStore().getItem(DRAFT_A)).toBe("Keep me");
  },
);

it("preserves the draft on toggle-off and switches storage without saving partials", () => {
  persistentStore().setItem(DRAFT_A, "First draft");
  persistentStore().setItem(DRAFT_B, "Other draft");
  const options = props({ draftStorageKey: DRAFT_A });
  const view = mount(<Composer {...options} />);
  conversation.active = true;
  conversation.partial = "unfinished utterance";
  view.render(
    <Composer {...options} conversation={{ ...options.conversation! }} />,
  );
  conversation.active = false;
  conversation.partial = "";
  view.render(
    <Composer {...options} conversation={{ ...options.conversation! }} />,
  );
  expect(view.container.querySelector("textarea")!.value).toBe("First draft");
  view.render(
    <Composer
      {...options}
      session={{ sessionId: "b", canSteer: true } as never}
      draftStorageKey={DRAFT_B}
    />,
  );
  expect(view.container.querySelector("textarea")!.value).toBe("Other draft");
  expect(persistentStore().getItem(DRAFT_A)).toBe("First draft");
  expect(persistentStore().getItem(DRAFT_B)).toBe("Other draft");
  expect(options.onSend).not.toHaveBeenCalled();
});

it("sends a final through the normal send path with a short voice hint", () => {
  const options = props();
  const { container } = mount(<Composer {...options} />);
  expect(container.textContent).toContain("Conversation");
  let sent = false;
  act(() => {
    sent = conversation.options!.onFinal("Hello there");
  });
  expect(sent).toBe(true);
  expect(options.onSend).toHaveBeenCalledWith(
    `Hello there\n\n${VOICE_REPLY_HINT}`,
    [],
  );
  expect(options.onAbort).not.toHaveBeenCalled();
});

it("combines drafts with voice in queue and literal-comment paths too", () => {
  const queued = props({
    streaming: true,
    onQueue: vi.fn(),
    draft: { sessionId: "a", text: "Draft to queue", token: 101 },
  });
  mount(<Composer {...queued} />);
  act(() => {
    conversation.options!.onFinal("spoken addition");
  });
  expect(queued.onQueue).toHaveBeenCalledWith({
    text: `Draft to queue\n\nspoken addition\n\n${VOICE_REPLY_HINT}`,
  });
  const literal = props({
    draft: { sessionId: "a", text: "//Keep this literally", token: 102 },
  });
  mount(<Composer {...literal} />);
  act(() => {
    expect(conversation.options!.onFinal("spoken addition")).toBe(true);
  });
  expect(literal.onSend).toHaveBeenCalledWith(
    `/Keep this literally\n\nspoken addition\n\n${VOICE_REPLY_HINT}`,
    [],
  );
});

it("queues a spoken final while busy, and keeps permanent-session steer semantics", () => {
  const onQueue = vi.fn();
  const options = props({ streaming: true, onQueue });
  const view = mount(<Composer {...options} />);
  act(() => {
    conversation.options!.onFinal("Next thought");
  });
  expect(onQueue).toHaveBeenCalledWith({
    text: `Next thought\n\n${VOICE_REPLY_HINT}`,
  });
  expect(options.onSend).not.toHaveBeenCalled();
  const permanent = props({ streaming: true });
  view.render(<Composer {...permanent} />);
  act(() => {
    conversation.options!.onFinal("Steer this");
  });
  expect(permanent.onSend).toHaveBeenCalledWith(
    `Steer this\n\n${VOICE_REPLY_HINT}`,
    [],
  );
});

it("refuses auto-send under the same send-blocking rules", () => {
  persistentStore().setItem(DRAFT_A, "Keep draft");
  const options = props({
    sendBlockedReason: "Pick a worktree",
    draftStorageKey: DRAFT_A,
  });
  const view = mount(<Composer {...options} />);
  let sent = true;
  act(() => {
    sent = conversation.options!.onFinal("Do it");
  });
  expect(sent).toBe(false);
  expect(options.onSend).not.toHaveBeenCalled();
  expect(view.container.querySelector("textarea")!.value).toBe(
    "Keep draft\n\nDo it",
  );
  expect(persistentStore().getItem(DRAFT_A)).toBe("Keep draft\n\nDo it");
});
