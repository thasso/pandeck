// @vitest-environment jsdom
import { act, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptAttachment, SlashCommandInfo } from "@assistant/shared";
import type { AssistantActions } from "../hooks/useAssistant.ts";
import type { PendingChatCommentsController } from "../hooks/usePendingChatComments.ts";
import { Composer } from "./Composer.tsx";

/**
 * The dock row's Send, which reaches into the composer through `submitRef`
 * because the draft never leaves this component — the host only ever holds the
 * bounded preview it shows on the row's field.
 */

const actions = { runSlashCommand: () => {} } as unknown as AssistantActions;

// jsdom ships no media-query engine; the composer only asks whether it is on a
// touch viewport, which this desktop-shaped stub answers with "no".
if (!window.matchMedia)
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.localStorage.clear();
});

function render(options: {
  submitRef: RefObject<(() => void) | null>;
  onSend: (text: string, attachments?: PromptAttachment[]) => void;
  sendBlockedReason?: string;
  chatComments?: PendingChatCommentsController;
  slashCommands?: SlashCommandInfo[];
}): HTMLTextAreaElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <Composer
        onSend={options.onSend}
        onAbort={() => {}}
        streaming={false}
        disabled={false}
        contextInfo={null}
        session={{ agentType: "developer", harness: "pi" } as never}
        models={[]}
        slashCommands={options.slashCommands ?? []}
        actions={actions}
        draftAutoFocus={false}
        mobile
        sendBlockedReason={options.sendBlockedReason}
        submitRef={options.submitRef}
        chatComments={options.chatComments}
      />,
    ),
  );
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("composer textarea did not render");
  return textarea;
}

/** Type as a user does: React only sees a value set through the native setter. */
function type(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Composer submitRef", () => {
  it("sends the draft the host cannot see, and clears it", () => {
    const submitRef = createRef<(() => void) | null>();
    const sent: string[] = [];
    const textarea = render({ submitRef, onSend: (text) => sent.push(text) });

    type(textarea, "ship it");
    act(() => submitRef.current?.());

    expect(sent).toEqual(["ship it"]);
    expect(textarea.value).toBe("");
  });

  it("opens on the hint instead of sending while a send is blocked", () => {
    const submitRef = createRef<(() => void) | null>();
    const sent: string[] = [];
    const textarea = render({
      submitRef,
      onSend: (text) => sent.push(text),
      // A Developer session staged without the worktree it requires.
      sendBlockedReason: "Developer sessions run in a worktree — pick one.",
    });

    type(textarea, "ship it");
    act(() => submitRef.current?.());

    // Nothing left, the draft is intact, and the composer is now up with the
    // reason showing above it.
    expect(sent).toEqual([]);
    expect(textarea.value).toBe("ship it");
    expect(document.activeElement).toBe(textarea);
    expect(container?.textContent).toContain(
      "Developer sessions run in a worktree",
    );
  });

  it("sends attached comments with an empty overall message and clears them", () => {
    const submitRef = createRef<(() => void) | null>();
    const sent: string[] = [];
    const clear = vi.fn();
    const comment = {
      id: "c1",
      anchor: {
        kind: "session" as const,
        sessionId: "s1",
        entryId: "e1",
        blockIndex: 0,
      },
      selectors: {
        quote: { exact: "a passage", prefix: "", suffix: "" },
        position: { start: 0, end: 9 },
      },
      quote: "a passage",
      body: "Please explain this.",
      transcriptPosition: {
        rowCreatedAt: "2026-08-20T14:32:00.000Z",
        rowId: "e1",
        blockIndex: 0,
      },
    };
    const chatComments: PendingChatCommentsController = {
      comments: [comment],
      activeCommentId: null,
      add: vi.fn(() => true),
      update: vi.fn(async () => ({ status: "saved" as const })),
      remove: vi.fn(),
      clear,
      select: vi.fn(),
    };
    render({
      submitRef,
      onSend: (text) => sent.push(text),
      chatComments,
    });

    act(() => submitRef.current?.());
    expect(sent).toEqual([
      "Comments on your previous response:\n\n1. On “a passage”:\n   Please explain this.",
    ]);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("refuses a registered slash command without consuming attached comments", () => {
    const submitRef = createRef<(() => void) | null>();
    const sent: string[] = [];
    const clear = vi.fn();
    const chatComments: PendingChatCommentsController = {
      comments: [
        {
          id: "c1",
          anchor: {
            kind: "session",
            sessionId: "s1",
            entryId: "e1",
            blockIndex: 0,
          },
          selectors: {
            quote: { exact: "passage", prefix: "", suffix: "" },
            position: { start: 0, end: 7 },
          },
          quote: "passage",
          body: "Explain this.",
          transcriptPosition: {
            rowCreatedAt: "2026-08-20T14:32:00.000Z",
            rowId: "e1",
            blockIndex: 0,
          },
        },
      ],
      activeCommentId: null,
      add: vi.fn(() => true),
      update: vi.fn(async () => ({ status: "saved" as const })),
      remove: vi.fn(),
      clear,
      select: vi.fn(),
    };
    const textarea = render({
      submitRef,
      onSend: (text) => sent.push(text),
      chatComments,
      slashCommands: [
        {
          name: "commit",
          description: "Commit changes",
          usage: "/commit",
          agentTypes: ["developer"],
        },
      ],
    });
    type(textarea, "/commit ");

    act(() => submitRef.current?.());

    expect(sent).toEqual([]);
    expect(clear).not.toHaveBeenCalled();
    expect(textarea.value).toBe("/commit ");
    expect(container?.textContent).toContain(
      "Slash commands do not support attached comments yet.",
    );
  });

  it("does nothing with an empty draft", () => {
    const submitRef = createRef<(() => void) | null>();
    const sent: string[] = [];
    render({ submitRef, onSend: (text) => sent.push(text) });

    act(() => submitRef.current?.());
    expect(sent).toEqual([]);
  });
});
