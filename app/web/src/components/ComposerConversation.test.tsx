// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_SPEECH_CONVERSATION_SETTINGS,
  DEFAULT_SPEECH_SYNTHESIS_SETTINGS,
} from "@assistant/shared";
import type { ConversationOptions } from "../hooks/useConversation.ts";
import { mount } from "../test/mount.tsx";
import { stubMatchMedia } from "../test/matchMedia.ts";
import { VOICE_REPLY_HINT } from "../lib/conversationText.ts";
import { Composer } from "./Composer.tsx";

const conversation = vi.hoisted(() => ({
  options: null as ConversationOptions | null,
}));
vi.mock("../hooks/useConversation.ts", () => ({
  useConversation: (options: ConversationOptions) => {
    conversation.options = options;
    return {
      active: false,
      phase: "off",
      partial: "",
      error: null,
      unavailableReason: undefined,
      toggle: vi.fn(),
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
afterEach(() => {
  vi.clearAllMocks();
});
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
  const options = props({ sendBlockedReason: "Pick a worktree" });
  mount(<Composer {...options} />);
  let sent = true;
  act(() => {
    sent = conversation.options!.onFinal("Do it");
  });
  expect(sent).toBe(false);
  expect(options.onSend).not.toHaveBeenCalled();
});
